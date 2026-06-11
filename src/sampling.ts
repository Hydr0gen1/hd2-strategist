/**
 * Pure planet-sample series logic: the bounded ring buffer behind both the
 * signed hp_per_hour rate and get_planet_history. Zero I/O — client.ts owns
 * all KV access and feeds the store in/out of these functions.
 *
 * The hp_per_hour SIGN CONVENTION is defined ONCE in the comment block above
 * samplePlanetRates in client.ts; advancePlanetSeries implements it verbatim
 * — (previous.health − current.health) / hoursElapsed, positive = progressing.
 */

import type { RawStatistics } from "./types";

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

/** Stage 5: one distinct campaign signature as observed upstream. Every
 * field comes straight from the raw campaign — a missing upstream field is
 * recorded as null inside the tuple key, never fabricated. */
export interface SignatureObservation {
  campaign_type: number | null;
  event_type: number | null;
  has_event: boolean;
  faction: string | null;
}

/** Stage 5: an accumulated signature tuple. `sample_count` counts distinct
 * observations at least MIN_SAMPLE_INTERVAL_MS apart (same discipline as the
 * planet sampler), so the 45s raw cache can't inflate it. */
export interface ObservedSignature extends SignatureObservation {
  first_seen: number;
  last_seen: number;
  sample_count: number;
}

/** Stage 5: one retained global war-statistics sample — a lean named subset
 * of upstream `war.statistics`. Missing fields are null, never 0.
 *
 * Stage 11 adds two co-sampled fields from the SAME war/campaigns fetch:
 * `impact_multiplier` (raw upstream `war.impactMultiplier`, war-payload root
 * — verified live 2026-06-11) and `active_campaign_count` (length of the
 * campaigns list at sample time). Both are OPTIONAL: points stored before
 * Stage 11 lack them and read as null — never backfilled, never 0. Raw
 * observed values only; no field relating them is ever computed. */
export interface GlobalSample {
  t: number;
  player_count: number | null;
  missions_won: number | null;
  missions_lost: number | null;
  deaths: number | null;
  terminid_kills: number | null;
  automaton_kills: number | null;
  illuminate_kills: number | null;
  impact_multiplier?: number | null;
  active_campaign_count?: number | null;
}

/** Stage 8: one observed Major Order objective-progress sample. `progress`
 * and `target` are the Stage-7-decoded values (upstream per-objective
 * progress and the valueType-3 goal slot); missing upstream → null, never
 * 0. `t` is the Worker clock, as everywhere. */
export interface MoProgressSample {
  t: number;
  progress: number | null;
  target: number | null;
}

/** Stage 8: a retained per-objective Major Order progress series, keyed by
 * MO id + objective index (an MO can carry several objectives; each gets its
 * own series — points are never mixed across MO ids or objectives).
 * `task_type` is the raw upstream task type, stored so the read path can
 * decode objective_kind with the current label map (a later-seeded label
 * applies retroactively — the decode is never baked into the store). */
export interface MoObjectiveSeries {
  major_order_id: number;
  objective_index: number;
  task_type: number | null;
  samples: MoProgressSample[];
}

/** Stage 8: one observation fed into advanceMoSeries by the poll path —
 * the Stage-7 objective decode's progress/target for one MO objective. */
export interface MoProgressObservation {
  majorOrderId: number;
  objectiveIndex: number;
  taskType: number | null;
  progress: number | null;
  target: number | null;
}

export interface SampleStore {
  planets: Record<string, PlanetSampleSeries>;
  campaignsFirstSeen: Record<string, number>;
  /** Stage 5 (signatures/global) + Stage 8 (mo) accumulation layers.
   * OPTIONAL: absent on stores written before the layer existed and omitted
   * when empty, so older stores round-trip unchanged. All ride the same
   * single per-poll KV write in client.ts — never a second write — and
   * always carry forward regardless of the planet series' carryForward
   * semantics. */
  signatures?: ObservedSignature[];
  global?: GlobalSample[];
  mo?: MoObjectiveSeries[];
}

/** Minimum spacing between two health samples for a rate to be computed. */
export const MIN_SAMPLE_INTERVAL_MS = 60_000;

/**
 * Retention bounds for the per-planet ring buffer. At max sampling cadence
 * (~1 sample/min: 45s raw-cache TTL + 60s MIN_SAMPLE_INTERVAL_MS) 96 points
 * cover ~1.6h of continuous polling; under typical sporadic MCP use the 48h
 * age cap is the binding limit. Worst-case serialized size: ~261 planets ×
 * 96 samples × ~35 bytes ≈ 0.9 MB; the Stage 5 accumulation layers add at
 * most ~500 signatures × ~120 B ≈ 60 KB and 96 global samples × ~220 B ≈
 * 22 KB (incl. the Stage 11 impact_multiplier / active_campaign_count
 * fields) — combined still far under the 5 MB KV value limit (asserted in
 * test/stage2.test.ts and test/stage5.test.ts). Note the store KEY carries
 * a 30-day KV TTL refreshed on every write (client.ts) — long enough that
 * the accumulated signature record survives gaps in usage, while a truly
 * abandoned store still evaporates. Planet-sample retention is unchanged:
 * the 48h age eviction here still binds on every write.
 */
export const MAX_SAMPLES_PER_PLANET = 96;
export const MAX_SAMPLE_AGE_MS = 48 * 3_600_000;

/** Stage 5 bounds. Distinct signature tuples are few in practice (dozens);
 * 500 is a defensive cap, evicting the oldest last_seen beyond it. The
 * global series reuses the planet-series discipline: 96 points / 48h. */
export const MAX_SIGNATURES = 500;
export const MAX_GLOBAL_SAMPLES = 96;

/** Stage 8 bounds. Each MO objective series reuses the global-series
 * discipline: 96 points / 48h. An MO carries a handful of objectives and at
 * most a couple of MOs run at once, so the series-count cap is defensive
 * (evicting the series with the oldest newest-sample beyond it). Worst case
 * ~50 series × 96 points × ~45 B ≈ 0.2 MB on top of the existing store —
 * still far under the 5 MB KV value limit (asserted in stage8.test.ts). */
export const MAX_MO_SAMPLES = 96;
export const MAX_MO_SERIES = 50;

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

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Coerce one stored signature entry; garbage (no finite timestamps) drops. */
function coerceSignatureEntry(entry: unknown): ObservedSignature | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  const firstSeen = finiteOrNull(e.first_seen);
  const lastSeen = finiteOrNull(e.last_seen);
  if (firstSeen == null || lastSeen == null) return undefined;
  return {
    campaign_type: numberOrNull(e.campaign_type),
    event_type: numberOrNull(e.event_type),
    has_event: e.has_event === true,
    faction: stringOrNull(e.faction),
    first_seen: firstSeen,
    last_seen: lastSeen,
    sample_count: finiteOrNull(e.sample_count) ?? 1,
  };
}

/** Coerce one stored global sample; entries without a finite `t` drop. */
function coerceGlobalEntry(entry: unknown): GlobalSample | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  const t = finiteOrNull(e.t);
  if (t == null) return undefined;
  return {
    t,
    player_count: numberOrNull(e.player_count),
    missions_won: numberOrNull(e.missions_won),
    missions_lost: numberOrNull(e.missions_lost),
    deaths: numberOrNull(e.deaths),
    terminid_kills: numberOrNull(e.terminid_kills),
    automaton_kills: numberOrNull(e.automaton_kills),
    illuminate_kills: numberOrNull(e.illuminate_kills),
    // Stage 11: pre-Stage-11 points lack these keys → null, never backfilled.
    impact_multiplier: numberOrNull(e.impact_multiplier),
    active_campaign_count: numberOrNull(e.active_campaign_count),
  };
}

/** Coerce one stored MO objective series; entries without finite series
 * keys or any valid sample drop — rates of garbage rebuild, never throw. */
function coerceMoEntry(entry: unknown): MoObjectiveSeries | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  const id = finiteOrNull(e.major_order_id);
  const idx = finiteOrNull(e.objective_index);
  if (id == null || idx == null || !Array.isArray(e.samples)) return undefined;
  const samples: MoProgressSample[] = [];
  for (const s of e.samples) {
    if (typeof s !== "object" || s === null) continue;
    const sample = s as Record<string, unknown>;
    const t = finiteOrNull(sample.t);
    if (t == null) continue;
    samples.push({
      t,
      progress: numberOrNull(sample.progress),
      target: numberOrNull(sample.target),
    });
  }
  if (samples.length === 0) return undefined;
  return {
    major_order_id: id,
    objective_index: idx,
    task_type: numberOrNull(e.task_type),
    samples,
  };
}

/** Coerce a raw KV value (any historical shape, or garbage) to a SampleStore. */
export function coerceStore(raw: unknown): SampleStore {
  const store: SampleStore = { planets: {}, campaignsFirstSeen: {} };
  if (typeof raw !== "object" || raw === null) return store;
  const r = raw as {
    planets?: unknown;
    campaignsFirstSeen?: unknown;
    signatures?: unknown;
    global?: unknown;
    mo?: unknown;
  };
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
  // Stage 5 sections appear ONLY when the stored value carried them — a
  // pre-Stage-5 store round-trips byte-identically (regression-pinned).
  if (Array.isArray(r.signatures)) {
    store.signatures = r.signatures
      .map(coerceSignatureEntry)
      .filter((s): s is ObservedSignature => s !== undefined);
  }
  if (Array.isArray(r.global)) {
    store.global = r.global
      .map(coerceGlobalEntry)
      .filter((g): g is GlobalSample => g !== undefined);
  }
  // Stage 8 section: same presence rule — absent unless the stored value
  // carried it, so pre-Stage-8 stores round-trip unchanged.
  if (Array.isArray(r.mo)) {
    store.mo = r.mo
      .map(coerceMoEntry)
      .filter((m): m is MoObjectiveSeries => m !== undefined);
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
  return boundSeries(samples, nowMs, MAX_SAMPLES_PER_PLANET);
}

/** The shared append-path bound: age eviction, newest-survives guard, then
 * the point cap. Generalized from the planet ring buffer so the Stage 8 MO
 * series reuses the identical discipline instead of a parallel mechanism. */
function boundSeries<T extends { t: number }>(
  samples: T[],
  nowMs: number,
  maxPoints: number,
): T[] {
  const cutoff = nowMs - MAX_SAMPLE_AGE_MS;
  let kept = samples.filter((s) => s.t >= cutoff);
  if (kept.length === 0 && samples.length > 0) {
    kept = [samples[samples.length - 1]!];
  }
  return kept.slice(-maxPoints);
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

/** Separator-safe tuple identity: faction is a free upstream string, so a
 * joined-string key could collide; a JSON array key cannot. */
function signatureKey(s: SignatureObservation): string {
  return JSON.stringify([s.campaign_type, s.event_type, s.has_event, s.faction]);
}

/**
 * Stage 5, Part A: fold the current poll cycle's observed campaign
 * signatures into the accumulated record. Pure observation, no
 * interpretation:
 *
 * - new tuple → appended with first_seen = last_seen = nowMs, sample_count 1.
 * - existing tuple → last_seen/sample_count bump ONLY when the previous
 *   last_seen is ≥ MIN_SAMPLE_INTERVAL_MS old — the same discipline as the
 *   planet sampler, so replays of the 45s raw cache can't inflate counts.
 *   sample_count therefore counts distinct ≥60s-apart observations.
 * - observations within one cycle are deduped by tuple first (many campaigns
 *   share a signature; one cycle is one observation of it).
 * - empty observation set → the existing record is returned unchanged.
 * - growth is bounded at MAX_SIGNATURES, evicting the oldest last_seen
 *   (distinct tuples are few in practice — the cap is defensive).
 */
export function foldSignatures(
  existing: ObservedSignature[] | undefined,
  observed: SignatureObservation[],
  nowMs: number,
): ObservedSignature[] {
  const current = existing ?? [];
  if (observed.length === 0) return current;

  const byKey = new Map<string, ObservedSignature>();
  for (const sig of current) byKey.set(signatureKey(sig), sig);

  const seenThisCycle = new Set<string>();
  for (const obs of observed) {
    const key = signatureKey(obs);
    if (seenThisCycle.has(key)) continue;
    seenThisCycle.add(key);
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, {
        campaign_type: obs.campaign_type,
        event_type: obs.event_type,
        has_event: obs.has_event,
        faction: obs.faction,
        first_seen: nowMs,
        last_seen: nowMs,
        sample_count: 1,
      });
    } else if (nowMs - known.last_seen >= MIN_SAMPLE_INTERVAL_MS) {
      byKey.set(key, {
        ...known,
        last_seen: nowMs,
        sample_count: known.sample_count + 1,
      });
    }
  }

  let next = [...byKey.values()];
  if (next.length > MAX_SIGNATURES) {
    next = next
      .sort((a, b) => b.last_seen - a.last_seen || b.first_seen - a.first_seen)
      .slice(0, MAX_SIGNATURES);
  }
  return next;
}

/**
 * Stage 5, Part E: advance the global war-statistics ring buffer.
 *
 * - stats == null (poll path that never fetched /api/v1/war) → the existing
 *   series is returned UNTOUCHED — no all-null row is ever appended for a
 *   cycle that simply didn't carry global statistics.
 * - a present stats object appends a sample only when the tail is at least
 *   MIN_SAMPLE_INTERVAL_MS old (same no-duplicate discipline as the planet
 *   sampler); each field is recorded as a finite number or null — never 0.
 * - bounded like the planet series: MAX_SAMPLE_AGE_MS age eviction, then
 *   the newest MAX_GLOBAL_SAMPLES points (newest always survives).
 *
 * Stage 11: `extras` co-samples the raw war-root `impactMultiplier` and the
 * active-campaign count from the SAME poll cycle; an absent value is null at
 * that point, never 0, never fabricated. The append gate is unchanged
 * (stats presence + the 60s guard) — extras never create a sample alone.
 */
export function advanceGlobalSeries(
  existing: GlobalSample[] | undefined,
  stats: RawStatistics | null | undefined,
  nowMs: number,
  extras: {
    impactMultiplier?: number | null;
    activeCampaignCount?: number | null;
  } = {},
): GlobalSample[] {
  const series = existing ?? [];
  if (stats == null) return series;
  const tail = series[series.length - 1];
  if (tail && nowMs - tail.t < MIN_SAMPLE_INTERVAL_MS) return series;

  const appended = [
    ...series,
    {
      t: nowMs,
      player_count: finiteOrNull(stats.playerCount),
      missions_won: finiteOrNull(stats.missionsWon),
      missions_lost: finiteOrNull(stats.missionsLost),
      deaths: finiteOrNull(stats.deaths),
      terminid_kills: finiteOrNull(stats.terminidKills),
      automaton_kills: finiteOrNull(stats.automatonKills),
      illuminate_kills: finiteOrNull(stats.illuminateKills),
      impact_multiplier: finiteOrNull(extras.impactMultiplier),
      active_campaign_count: finiteOrNull(extras.activeCampaignCount),
    },
  ];
  const cutoff = nowMs - MAX_SAMPLE_AGE_MS;
  let kept = appended.filter((s) => s.t >= cutoff);
  if (kept.length === 0) kept = [appended[appended.length - 1]!];
  return kept.slice(-MAX_GLOBAL_SAMPLES);
}

/** Series identity: MO id + objective index, both finite numbers. */
function moSeriesKey(majorOrderId: number, objectiveIndex: number): string {
  return `${majorOrderId}:${objectiveIndex}`;
}

/**
 * Stage 8: advance the per-objective Major Order progress series with the
 * current poll cycle's observations. Same disciplines as the other
 * accumulation layers, observation only — never a forecast:
 *
 * - one bounded series per {major_order_id, objective_index}; a sample
 *   appends only when the tail is ≥ MIN_SAMPLE_INTERVAL_MS old (45s raw-cache
 *   replays never double-sample), bounded by boundSeries (48h age + 96
 *   points, newest survives — the planet/global discipline verbatim).
 * - progress/target are recorded as finite numbers or null — a value missing
 *   upstream is null at that point, never 0, never fabricated.
 * - MO TURNOVER: a new MO id simply seeds new series; series NOT observed
 *   this cycle (a prior MO after turnover, or every series while no MO is
 *   active) are retained as historical record and age out by plain
 *   MAX_SAMPLE_AGE_MS eviction — without the newest-survives guard, so a
 *   fully-aged inactive series drops entirely. Points are never moved or
 *   merged across series, so turnover cannot cross-contaminate.
 * - no observations + no existing series → []; the store section therefore
 *   stays absent until data first accrues (client.ts omits empty sections).
 * - series count is capped at MAX_MO_SERIES (defensive — a few objectives ×
 *   a couple of MOs in practice), evicting the oldest newest-sample first.
 */
export function advanceMoSeries(
  existing: MoObjectiveSeries[] | undefined,
  observed: MoProgressObservation[],
  nowMs: number,
): MoObjectiveSeries[] {
  const byKey = new Map<string, MoObjectiveSeries>();
  for (const series of existing ?? []) {
    byKey.set(moSeriesKey(series.major_order_id, series.objective_index), series);
  }

  const seenThisCycle = new Set<string>();
  for (const obs of observed) {
    if (
      !Number.isFinite(obs.majorOrderId) ||
      !Number.isFinite(obs.objectiveIndex)
    ) {
      continue; // no usable series identity — never guess one
    }
    const key = moSeriesKey(obs.majorOrderId, obs.objectiveIndex);
    if (seenThisCycle.has(key)) continue;
    seenThisCycle.add(key);
    const sample: MoProgressSample = {
      t: nowMs,
      progress: finiteOrNull(obs.progress),
      target: finiteOrNull(obs.target),
    };
    const known = byKey.get(key);
    const tail = known?.samples[known.samples.length - 1];
    if (!known) {
      byKey.set(key, {
        major_order_id: obs.majorOrderId,
        objective_index: obs.objectiveIndex,
        task_type: finiteOrNull(obs.taskType),
        samples: [sample],
      });
    } else if (!tail || nowMs - tail.t >= MIN_SAMPLE_INTERVAL_MS) {
      byKey.set(key, {
        ...known,
        task_type: finiteOrNull(obs.taskType) ?? known.task_type,
        samples: boundSeries([...known.samples, sample], nowMs, MAX_MO_SAMPLES),
      });
    }
    // tail too recent → series untouched, same as the planet/global guard.
  }

  // Age-out pass for series not observed this cycle (prior-MO retention
  // bound): plain age eviction; an emptied series drops.
  const cutoff = nowMs - MAX_SAMPLE_AGE_MS;
  let next: MoObjectiveSeries[] = [];
  for (const [key, series] of byKey) {
    if (seenThisCycle.has(key)) {
      next.push(series);
      continue;
    }
    const kept = series.samples.filter((s) => s.t >= cutoff);
    if (kept.length === series.samples.length) next.push(series);
    else if (kept.length > 0) next.push({ ...series, samples: kept });
  }

  if (next.length > MAX_MO_SERIES) {
    next = next
      .sort(
        (a, b) =>
          (b.samples[b.samples.length - 1]?.t ?? 0) -
          (a.samples[a.samples.length - 1]?.t ?? 0),
      )
      .slice(0, MAX_MO_SERIES);
  }
  return next;
}
