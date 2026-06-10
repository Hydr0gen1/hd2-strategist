/**
 * Pure planet-sample series logic: the bounded ring buffer behind both the
 * signed hp_per_hour rate and get_planet_history. Zero I/O — client.ts owns
 * all KV access and feeds the store in/out of these functions.
 *
 * The hp_per_hour SIGN CONVENTION is defined ONCE in the comment block above
 * samplePlanetRates in client.ts; advancePlanetSeries implements it verbatim
 * — (previous.health − current.health) / hoursElapsed, positive = progressing.
 */

/** One observed health sample. `t` is the Worker clock (Date.now()) at the
 * moment of sampling — upstream `war.now` is game-epoch time and unusable. */
export interface HealthSample {
  h: number;
  t: number;
}

/** Per-planet retained series, oldest → newest. The TAIL is what the legacy
 * single-sample store held; the rate logic only ever reads the tail. */
export interface PlanetSampleSeries {
  samples: HealthSample[];
  lastRate: number | null;
}

export interface SampleStore {
  planets: Record<string, PlanetSampleSeries>;
  campaignsFirstSeen: Record<string, number>;
}

/** Minimum spacing between two health samples for a rate to be computed. */
export const MIN_SAMPLE_INTERVAL_MS = 60_000;

/**
 * Retention bounds for the per-planet ring buffer. At max sampling cadence
 * (~1 sample/min: 45s raw-cache TTL + 60s MIN_SAMPLE_INTERVAL_MS) 96 points
 * cover ~1.6h of continuous polling; under typical sporadic MCP use the 48h
 * age cap is the binding limit. Worst-case serialized size: ~261 planets ×
 * 96 samples × ~35 bytes ≈ 0.9 MB — well under the 5 MB KV value limit
 * (asserted in test/stage2.test.ts). Note the store KEY carries a 24h KV TTL
 * refreshed on every write, so the 48h window only survives while polling
 * continues — deliberate: an abandoned store should evaporate.
 */
export const MAX_SAMPLES_PER_PLANET = 96;
export const MAX_SAMPLE_AGE_MS = 48 * 3_600_000;

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isValidSample(s: unknown): s is HealthSample {
  return (
    typeof s === "object" &&
    s !== null &&
    Number.isFinite((s as HealthSample).h) &&
    Number.isFinite((s as HealthSample).t)
  );
}

/**
 * Coerce one stored planet entry to the current series shape. Accepts the
 * current shape (`samples` array — checked FIRST so a hybrid entry written
 * by an old Worker during a deploy overlap resolves to the richer series),
 * the legacy single-sample shape `{h, t, lastRate}` (migrated to a
 * one-sample series so rate continuity survives the deploy), and anything
 * else is dropped — rates rebuild, exactly like an unreadable store.
 */
export function coercePlanetEntry(
  entry: unknown,
): PlanetSampleSeries | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as {
    samples?: unknown;
    lastRate?: unknown;
    h?: unknown;
    t?: unknown;
  };
  if (Array.isArray(e.samples)) {
    return {
      samples: e.samples.filter(isValidSample).map((s) => ({ h: s.h, t: s.t })),
      lastRate: finiteOrNull(e.lastRate),
    };
  }
  if (Number.isFinite(e.h) && Number.isFinite(e.t)) {
    return {
      samples: [{ h: e.h as number, t: e.t as number }],
      lastRate: finiteOrNull(e.lastRate),
    };
  }
  return undefined;
}

/** Coerce a raw KV value (any historical shape, or garbage) to a SampleStore. */
export function coerceStore(raw: unknown): SampleStore {
  const store: SampleStore = { planets: {}, campaignsFirstSeen: {} };
  if (typeof raw !== "object" || raw === null) return store;
  const r = raw as { planets?: unknown; campaignsFirstSeen?: unknown };
  if (typeof r.planets === "object" && r.planets !== null) {
    for (const [key, entry] of Object.entries(r.planets)) {
      const series = coercePlanetEntry(entry);
      if (series) store.planets[key] = series;
    }
  }
  if (
    typeof r.campaignsFirstSeen === "object" &&
    r.campaignsFirstSeen !== null
  ) {
    for (const [key, value] of Object.entries(r.campaignsFirstSeen)) {
      const t = finiteOrNull(value);
      if (t != null) store.campaignsFirstSeen[key] = t;
    }
  }
  return store;
}

/**
 * Bound a series after an append: drop samples older than MAX_SAMPLE_AGE_MS,
 * then keep the newest MAX_SAMPLES_PER_PLANET. The newest sample always
 * survives (guard against a skewed caller clock), so an append can never
 * strand a planet with an empty series.
 */
export function evictSamples(
  samples: HealthSample[],
  nowMs: number,
): HealthSample[] {
  const cutoff = nowMs - MAX_SAMPLE_AGE_MS;
  let kept = samples.filter((s) => s.t >= cutoff);
  if (kept.length === 0 && samples.length > 0) {
    kept = [samples[samples.length - 1]!];
  }
  return kept.slice(-MAX_SAMPLES_PER_PLANET);
}

/**
 * Advance one planet's series with a freshly observed health value.
 * Reproduces the pre-ring-buffer single-sample semantics EXACTLY, with
 * `prev` = the tail of the series (which IS the old single sample):
 *
 * - tail ≥ MIN_SAMPLE_INTERVAL_MS old → compute the rate with the verbatim
 *   legacy arithmetic and append the new sample (then evict).
 * - tail too recent → reuse lastRate, NO append: the series is returned
 *   untouched (no eviction either — history must not depend on read timing,
 *   and cached health reads must not collapse the rate to a bogus 0).
 * - no series → seed one sample, rate null until a second qualifying sample.
 * - health null/non-finite → series is DROPPED (returns undefined), exactly
 *   as the legacy store dropped its entry: the next valid sample reseeds with
 *   a null rate. Keeping a stale tail instead would compute a rate where the
 *   legacy code produced null. Pre-existing consequence, now visible in
 *   history: a planet's series wipes when its health goes null or it leaves
 *   the sampled input set.
 */
export function advancePlanetSeries(
  series: PlanetSampleSeries | undefined,
  health: number | null,
  nowMs: number,
): { series: PlanetSampleSeries | undefined; hpPerHour: number | null } {
  if (health == null || !Number.isFinite(health)) {
    return { series: undefined, hpPerHour: null };
  }
  const prev = series?.samples[series.samples.length - 1];
  if (prev && nowMs - prev.t >= MIN_SAMPLE_INTERVAL_MS) {
    const hoursElapsed = (nowMs - prev.t) / 3_600_000;
    // See the sign convention block in client.ts: positive = progressing.
    const hpPerHour = (prev.h - health) / hoursElapsed;
    return {
      series: {
        samples: evictSamples(
          [...series!.samples, { h: health, t: nowMs }],
          nowMs,
        ),
        lastRate: hpPerHour,
      },
      hpPerHour,
    };
  }
  if (series && prev) {
    return { series, hpPerHour: series.lastRate };
  }
  return {
    series: { samples: [{ h: health, t: nowMs }], lastRate: null },
    hpPerHour: null,
  };
}
