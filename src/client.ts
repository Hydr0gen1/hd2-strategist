/**
 * Upstream fetch wrapper + KV caching + HP rate sampling.
 * Auth headers come from env secrets (SUPER_CLIENT / SUPER_CONTACT) — never
 * hardcoded. Raw responses are cached; invariant normalization always runs
 * AFTER the cache read, so logic changes never require cache invalidation.
 */
import {
  archiveSampleTick,
  signatureKeyString,
  type ArchiveTick,
  type GlobalArchiveWriteRow,
  type MoArchiveWriteRow,
  type MoOutcomeRow,
  type PlanetArchiveWriteRow,
  type QuarantineRow,
  type SignatureArchiveRow,
} from "./archive";
import { screenGlobalRow } from "./integrity";
import {
  advanceGlobalSeries,
  advanceMoSeries,
  advancePlanetSeries,
  coerceStore,
  foldSignatures,
  MIN_SAMPLE_INTERVAL_MS,
  type GlobalSample,
  type HealthSample,
  type MoObjectiveSeries,
  type MoProgressObservation,
  type ObservedSignature,
  type SampleStore,
  type SignatureObservation,
} from "./sampling";
import type { Env, RawStatistics } from "./types";

const BASE_URL = "https://api.helldivers2.dev";
/** Freshness window for raw upstream responses. */
export const CACHE_TTL_SECONDS = 45;
/** How long stale copies survive in KV to serve as 429/5xx fallback. */
const STALE_KEEP_TTL_SECONDS = 600;
const FETCH_TIMEOUT_MS = 8_000;
const SAMPLES_KEY = "samples:planets";

export { MIN_SAMPLE_INTERVAL_MS };

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

interface CacheEnvelope {
  fetchedAt: number;
  body: unknown;
}

export interface UpstreamResult<T> {
  data: T;
  /** True when served from an expired cache copy due to upstream failure. */
  stale: boolean;
  /** Worker-clock ms epoch of when this payload was retrieved from upstream
   * (the cache record's stored timestamp — NOT when this request ran).
   * Stage 6 freshness metadata derives from it. */
  fetchedAt: number;
  /** Feature 5: true when this result came from KV (a fresh-cache hit OR a
   * stale fallback) rather than a NEW network fetch. The warm-cache snapshot is
   * refreshed only on a genuine network fetch (cached: false), so it never adds
   * a KV write on a plain cache hit. */
  cached: boolean;
}

async function readCache(
  env: Env,
  key: string,
): Promise<CacheEnvelope | null> {
  if (!env.WAR_CACHE) return null;
  try {
    return await env.WAR_CACHE.get<CacheEnvelope>(key, "json");
  } catch {
    return null;
  }
}

/**
 * GET an upstream path with cache-first semantics:
 * fresh KV copy → return; otherwise fetch upstream and cache the RAW body;
 * on 429/5xx/timeout fall back to any stale KV copy (marked stale: true);
 * with no fallback available, throw a typed UpstreamError (never a raw
 * exception out of the Worker).
 */
export async function fetchUpstream<T>(
  env: Env,
  path: string,
): Promise<UpstreamResult<T>> {
  const key = `raw:${path}`;
  const cached = await readCache(env, key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_SECONDS * 1000) {
    return {
      data: cached.body as T,
      stale: false,
      fetchedAt: cached.fetchedAt,
      cached: true,
    };
  }

  let response: Response;
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (env.SUPER_CLIENT) headers["X-Super-Client"] = env.SUPER_CLIENT;
    if (env.SUPER_CONTACT) headers["X-Super-Contact"] = env.SUPER_CONTACT;
    response = await fetch(`${BASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (cached) {
      return {
        data: cached.body as T,
        stale: true,
        fetchedAt: cached.fetchedAt,
        cached: true,
      };
    }
    throw new UpstreamError(
      `Upstream request to ${path} failed (${err instanceof Error ? err.message : "network error"}) and no cached copy is available.`,
    );
  }

  if (!response.ok) {
    if (cached) {
      return {
        data: cached.body as T,
        stale: true,
        fetchedAt: cached.fetchedAt,
        cached: true,
      };
    }
    const reason =
      response.status === 429
        ? "rate limited (429)"
        : `returned ${response.status}`;
    throw new UpstreamError(
      `Upstream ${reason} for ${path} and no cached copy is available. Try again shortly.`,
      response.status,
    );
  }

  const body = (await response.json()) as T;
  if (env.WAR_CACHE) {
    try {
      await env.WAR_CACHE.put(
        key,
        JSON.stringify({ fetchedAt: now, body } satisfies CacheEnvelope),
        { expirationTtl: STALE_KEEP_TTL_SECONDS },
      );
    } catch {
      // Cache write failures must never break a successful upstream read.
    }
  }
  return { data: body, stale: false, fetchedAt: now, cached: false };
}

/* ------------------------------------------------------------------------
 * Feature 5: warm bulk-planet snapshot.
 *
 * A durable, long-TTL copy of the full /api/v1/planets list, refreshed on
 * every genuine upstream fetch of that list (never on a plain cache hit, so it
 * adds no KV write to the hot path). It exists ONLY as a fallback: when a live
 * planets fetch cannot complete AND the short-lived raw: cache has already
 * evaporated, adjacency/ownership/HP context lookups (get_planet,
 * get_supply_graph) read this snapshot instead of hard-failing.
 *
 * FENCE: this snapshot feeds context lookups ONLY. It MUST NOT backfill the
 * history/global-stats archive (it is read by no sampling path), so the known
 * 18145 / 0.07364573 global-stats sentinel can never be enshrined through it.
 * ---------------------------------------------------------------------- */

const BULK_PLANETS_KEY = "snapshot:planets";
/** 7 days — long enough to ride out a sustained outage, short enough that a
 * truly abandoned snapshot still evaporates. */
export const BULK_SNAPSHOT_TTL_SECONDS = 7 * 86_400;

interface BulkSnapshotEnvelope {
  fetchedAt: number;
  body: unknown;
}

/** Best-effort durable write of the bulk planets snapshot. Never throws — a
 * snapshot-cache failure must never break the live response it rode in on. */
export async function cacheBulkPlanets(
  env: Env,
  planets: unknown,
  fetchedAt: number,
): Promise<void> {
  if (!env.WAR_CACHE) return;
  try {
    await env.WAR_CACHE.put(
      BULK_PLANETS_KEY,
      JSON.stringify({ fetchedAt, body: planets } satisfies BulkSnapshotEnvelope),
      { expirationTtl: BULK_SNAPSHOT_TTL_SECONDS },
    );
  } catch {
    // Snapshot persistence is best-effort; the next fetch retries.
  }
}

/** Read the most recent durable bulk planets snapshot, or null when none. */
export async function readBulkPlanetsSnapshot<T>(
  env: Env,
): Promise<{ data: T; fetchedAt: number } | null> {
  if (!env.WAR_CACHE) return null;
  try {
    const env_ = await env.WAR_CACHE.get<BulkSnapshotEnvelope>(
      BULK_PLANETS_KEY,
      "json",
    );
    if (!env_ || typeof env_.fetchedAt !== "number") return null;
    return { data: env_.body as T, fetchedAt: env_.fetchedAt };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------
 * HP rate sampling (hp_per_hour) and campaign first-seen tracking.
 *
 * SIGN CONVENTION — single source of truth for the whole server:
 * Planet/event health counts DOWN toward resolution: it DECREASES as a
 * planet is liberated or successfully defended.
 *
 *   hp_per_hour = (previous.health - current.health) / hoursElapsed
 *
 *   positive hp_per_hour  => health is being depleted  => progressing
 *                            toward resolution (player damage > regen)
 *   negative hp_per_hour  => health is rising           => losing ground
 *
 * This one signed value is computed here, once, and consumed by exactly two
 * places: projectResolution() takes its MAGNITUDE via abs() (deliberately
 * sign-blind), and directionFromRate() takes its SIGN — the direction flag
 * is the SOLE carrier of liberating-vs-losing. Never derive direction from
 * any second, independently computed quantity; the projection and the
 * direction flag must stay consistent with this convention.
 * ---------------------------------------------------------------------- */

export interface SampleInput {
  planetIndex: number;
  /** Current trackable health: planet.health, or event.health for defense. */
  health: number | null;
  campaignId: number | null;
  /** Stage 12 archive-only context — pass-through metadata for the D1 row this
   * tick produces. These NEVER affect the KV rate path (it ignores them); they
   * only enrich the append-only archive. Optional so existing call sites and
   * the single-planet probe keep working when they can't supply them. */
  maxHealth?: number | null;
  campaignKind?: string | null;
  faction?: string | null;
}

export interface SampleOutput {
  hpPerHour: number | null;
  /** ms since the campaign was first seen by this Worker; null if no id. */
  campaignAgeMs: number | null;
  /** Stage 9: the planet's retained sample series as of this poll (post-
   * advance, oldest → newest) — exposed so the campaign path can derive the
   * historical trend rate from the SAME single KV read this call already
   * performs, never a second read. Empty when no series is retained. */
  samples: HealthSample[];
}

async function readSampleStore(env: Env): Promise<SampleStore> {
  if (!env.WAR_CACHE) return { planets: {}, campaignsFirstSeen: {} };
  try {
    const existing = await env.WAR_CACHE.get(SAMPLES_KEY, "json");
    // Accepts both the current ring-buffer shape and the pre-history
    // single-sample shape (migrated in place); unreadable state is empty.
    return coerceStore(existing);
  } catch {
    return { planets: {}, campaignsFirstSeen: {} };
  }
}

/**
 * One KV read + one KV write for the whole batch (O(n) over the campaign
 * list, no nested loops). Rates only update once samples are at least
 * MIN_SAMPLE_INTERVAL_MS apart; between updates the last computed rate is
 * reused so cached health reads don't collapse the rate to a bogus 0.
 * Per planet a bounded ring buffer of samples is retained (sampling.ts) —
 * the rate logic still reads only the tail, so hp_per_hour is unchanged.
 *
 * carryForward: by default the next store is rebuilt from the inputs alone,
 * so planets that leave the campaign set drop out (and re-entry reseeds a
 * null rate — long-standing semantics the rate logic depends on). Single
 * planet probes (get_planet on a non-campaign planet) MUST pass true so one
 * lookup doesn't wipe every other planet's series and the campaign
 * first-seen ages.
 *
 * Stage 5/8: the accumulation layers (observed campaign signatures, the
 * global statistics series, and the Major Order progress series) ride this
 * SAME single write — never a second per-cycle KV put. Unlike planet series
 * they ALWAYS carry forward, regardless of carryForward: that flag's rebuild
 * semantics apply to planet series and campaign first-seen ages only. A call
 * without `signatures` / `globalStatistics` passes those layers through
 * untouched; the MO series additionally apply their age eviction on every
 * write (that is how a prior MO's retained series eventually ages out).
 *
 * PROVENANCE GATE (P1 fix — the load-bearing choke point). Persistence
 * requires a COMPLETE LIVE fetch. `opts.persist === false` makes this call
 * READ-ONLY: rates are still computed and returned for the response, but
 * NOTHING is written — no KV append, no D1 archive row (the D1 write already
 * rides `kvCommitted`, which stays false). The caller sets `persist` from the
 * PROVENANCE of the data it is sampling (live fetch vs. fallback/snapshot/
 * resilient-empty), never from apparent planet state. This is what keeps a
 * stale snapshot out of `samples:planets`/D1 for EVERY caller (cron,
 * get_planet, get_war_status, …) — degraded data may be served, never
 * recorded. Default `true` preserves every existing live call site.
 */
export async function samplePlanetRates(
  env: Env,
  inputs: SampleInput[],
  nowMs: number = Date.now(),
  opts: {
    carryForward?: boolean;
    /** P1 provenance gate: false → compute rates but write nothing (the data
     * is a fallback/snapshot/resilient-empty observation, not a live fetch). */
    persist?: boolean;
    signatures?: SignatureObservation[];
    globalStatistics?: RawStatistics | null;
    /** Stage 11: raw war-root impactMultiplier + active-campaign count,
     * co-sampled into the same global point — recorded only when
     * globalStatistics gates a sample in; absent → null, never 0. */
    globalImpactMultiplier?: number | null;
    globalActiveCampaignCount?: number | null;
    moProgress?: MoProgressObservation[];
  } = {},
): Promise<Map<number, SampleOutput>> {
  const prepared = await prepareSampleTick(env, inputs, nowMs, opts);
  // P1: persistence is a SEPARATE, opt-in step. Default true preserves every
  // existing live call site; persist:false (or a pure loader) computes rates and
  // writes nothing. The decoupled commit (commitSampleTick) is what handlers use
  // to write ONCE, after all input provenance is known.
  if (opts.persist !== false) await commitSampleTick(env, prepared);
  return prepared.results;
}

/** P1: the result of computing a sample tick WITHOUT writing it — the rates for
 * the response plus everything commitSampleTick needs to persist later. A pure
 * loader returns one of these; the handler's terminal gated step commits it (or
 * not). Side-effect-free: prepareSampleTick performs one KV READ and no write. */
export interface PreparedSampleTick {
  results: Map<number, SampleOutput>;
  nextStore: SampleStore;
  /** Inputs the D1 archive step needs at commit time (old store + folded
   * sections + the per-tick planet rows). `moObservations` is null when the
   * poll carried NO assignments data (e.g. a single-planet probe) — item 10's
   * end-of-order detection must then abstain: absence of observations is not
   * evidence an order ended. */
  archive: {
    planetRows: PlanetArchiveWriteRow[];
    oldStore: SampleStore;
    global: GlobalSample[];
    mo: MoObjectiveSeries[];
    signatures: SignatureObservation[];
    moObservations: MoProgressObservation[] | null;
    nowMs: number;
  };
}

/**
 * P1: compute a sample tick read-only — one KV read, ZERO writes. Returns the
 * rates (for the response) and the fully-built next store + archive rows for a
 * later commit. Loaders call this and persist NOTHING; the handler decides
 * whether to commitSampleTick once both inputs' provenance is known.
 */
export async function prepareSampleTick(
  env: Env,
  inputs: SampleInput[],
  nowMs: number,
  opts: {
    carryForward?: boolean;
    signatures?: SignatureObservation[];
    globalStatistics?: RawStatistics | null;
    globalImpactMultiplier?: number | null;
    globalActiveCampaignCount?: number | null;
    moProgress?: MoProgressObservation[];
  } = {},
): Promise<PreparedSampleTick> {
  const results = new Map<number, SampleOutput>();
  const store = await readSampleStore(env);

  const nextStore: SampleStore = opts.carryForward
    ? {
        planets: { ...store.planets },
        campaignsFirstSeen: { ...store.campaignsFirstSeen },
      }
    : { planets: {}, campaignsFirstSeen: {} };

  // Stage 5 accumulation layers: always carried forward, then folded.
  // Sections stay absent (not empty arrays) until they first accrue data,
  // so pre-Stage-5 stores round-trip unchanged.
  const signatures = foldSignatures(
    store.signatures,
    opts.signatures ?? [],
    nowMs,
  );
  if (signatures.length > 0) nextStore.signatures = signatures;
  const global = advanceGlobalSeries(
    store.global,
    opts.globalStatistics ?? null,
    nowMs,
    {
      impactMultiplier: opts.globalImpactMultiplier ?? null,
      activeCampaignCount: opts.globalActiveCampaignCount ?? null,
    },
  );
  if (global.length > 0) nextStore.global = global;
  // Stage 8: MO progress series — same single write, same carry-forward.
  const mo = advanceMoSeries(store.mo, opts.moProgress ?? [], nowMs);
  if (mo.length > 0) nextStore.mo = mo;

  // Stage 12: archive rows for ONLY the observations newly committed to KV
  // this tick (a new sample was appended). A within-60s replay appends nothing
  // and therefore produces no archive rows — the same gate as the KV write, so
  // the D1 archive never accrues duplicate rows. Built only when a D1 binding
  // exists (cheap to skip otherwise).
  const archivePlanetRows: PlanetArchiveWriteRow[] = [];

  for (const input of inputs) {
    const idxKey = String(input.planetIndex);

    // The predecessor timestamp (the OLD series tail) is read BEFORE the append
    // — it is the dedup anchor two overlapping polls share (both read the same
    // old store), so the D1 unique index collapses their concurrent inserts.
    const prevT = store.planets[idxKey]?.samples.at(-1)?.t;

    const advanced = advancePlanetSeries(
      store.planets[idxKey],
      input.health != null && Number.isFinite(input.health)
        ? input.health
        : null,
      nowMs,
    );
    const hpPerHour = advanced.hpPerHour;
    if (advanced.series) {
      nextStore.planets[idxKey] = advanced.series;
    } else if (opts.carryForward) {
      // Legacy parity: a null-health observation drops the entry.
      delete nextStore.planets[idxKey];
    }

    // Committed iff a sample was appended with this tick's timestamp (a fresh
    // seed or a >60s append) — the same determination the KV ring buffer made,
    // reused here, never recomputed.
    const newest = advanced.series?.samples[advanced.series.samples.length - 1];
    if (env.HISTORY_DB && newest && newest.t === nowMs) {
      archivePlanetRows.push({
        planet_index: input.planetIndex,
        sampled_at: nowMs,
        health: newest.h,
        max_health:
          input.maxHealth != null && Number.isFinite(input.maxHealth)
            ? input.maxHealth
            : null,
        hp_per_hour: hpPerHour,
        campaign_id: input.campaignId,
        campaign_kind: input.campaignKind ?? null,
        faction: input.faction ?? null,
        tick_anchor: tickAnchor(prevT, nowMs),
      });
    }

    let campaignAgeMs: number | null = null;
    if (input.campaignId != null) {
      const cidKey = String(input.campaignId);
      const firstSeen = store.campaignsFirstSeen[cidKey] ?? nowMs;
      nextStore.campaignsFirstSeen[cidKey] = firstSeen;
      campaignAgeMs = nowMs - firstSeen;
    }

    results.set(input.planetIndex, {
      hpPerHour,
      campaignAgeMs,
      samples: advanced.series?.samples ?? [],
    });
  }

  return {
    results,
    nextStore,
    archive: {
      planetRows: archivePlanetRows,
      oldStore: store,
      global,
      mo,
      signatures: opts.signatures ?? [],
      // null (not []) when the poll had no assignments fetch — item 10's
      // detection distinguishes "no MOs active (observed)" from "not observed".
      moObservations: opts.moProgress ?? null,
      nowMs,
    },
  };
}

/**
 * P1: the WRITE half — the single gated persistence step. Writes the prepared
 * next store to KV and (only when that put commits) appends the D1 archive
 * tick. Failure-isolated exactly as before. Handlers call this ONCE, after all
 * input provenance is known and the all-inputs-live gate passed; a loader never
 * calls it. A within-60s replay's nextStore is identical to the current store,
 * so re-writing it is a harmless no-op for history (the append guards live in
 * prepare).
 */
export async function commitSampleTick(
  env: Env,
  prepared: PreparedSampleTick,
): Promise<void> {
  // Track whether the KV ring buffer actually persisted this tick. The D1
  // archive must ride a COMMITTED KV sample: if the KV write is skipped (no
  // binding) or fails (a transient KV error / exhausted write budget), the
  // next poll re-reads an empty/old store and re-seeds the SAME observation as
  // "fresh", so archiving now would accumulate duplicate/over-sampled rows that
  // no longer correspond to the ring buffer. Gate the archive on the put.
  let kvCommitted = false;
  if (env.WAR_CACHE) {
    try {
      await env.WAR_CACHE.put(SAMPLES_KEY, JSON.stringify(prepared.nextStore), {
        // 30 days, refreshed on every write: planet samples still age out
        // in code at 48h (sampling.ts), but the Stage 5 accumulation layers
        // must survive gaps in usage — a truly abandoned store still
        // evaporates after a month.
        expirationTtl: SAMPLES_KEY_TTL_SECONDS,
      });
      kvCommitted = true;
    } catch {
      // Best-effort persistence; next request reseeds. kvCommitted stays false
      // so this tick is NOT archived (the ring buffer did not advance).
    }
  }

  // Stage 12: only when the KV write above actually committed, append this tick
  // to the D1 archive — best-effort and failure-isolated (archiveSampleTick
  // wraps its own batch in try/catch and swallows). KV stays the source of
  // truth for all live logic; D1 is the durable long-term record only. A tick
  // that committed nothing new to KV (a within-60s replay) yields empty
  // sections, so the archive never gains duplicate rows.
  if (env.HISTORY_DB && kvCommitted) {
    // Belt-and-suspenders isolation: archiveSampleTick already swallows its own
    // batch failures, and the row-assembly below cannot realistically throw,
    // but the whole archive step is wrapped so it can NEVER affect the KV write
    // or the returned rates. Best-effort archival, fully isolated.
    try {
      await archiveSampleTick(
        env,
        buildArchiveTick(
          prepared.archive.planetRows,
          prepared.archive.oldStore,
          prepared.archive.global,
          prepared.archive.mo,
          prepared.archive.signatures,
          prepared.archive.moObservations,
          prepared.archive.nowMs,
        ),
      );
    } catch (err) {
      console.warn(
        `D1 archive step skipped (KV unaffected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Stage 12: the dedup anchor for one append-only archive row. For an append it
 * is the predecessor KV sample's timestamp (`prevT`) — two overlapping polls
 * read the SAME old store, so they compute the SAME anchor and the D1 unique
 * index collapses their concurrent inserts. A seed has no predecessor, so it
 * anchors on a NEGATIVE 60s bucket of `nowMs` (disjoint from any positive
 * prevT), which dedups same-window seed races while keeping a genuine later
 * re-seed (a different bucket) distinct. Legit consecutive samples follow
 * different predecessors, so they always get distinct anchors.
 */
function tickAnchor(prevT: number | undefined, nowMs: number): number {
  if (prevT != null) return prevT;
  return -(Math.floor(nowMs / MIN_SAMPLE_INTERVAL_MS) + 1);
}

/**
 * Stage 12: assemble the D1 archive payload for one tick from state already
 * computed by samplePlanetRates — ONLY the observations committed to KV as NEW
 * this tick (a section's tail timestamp equals the tick clock). A within-60s
 * replay commits nothing, so every section is empty and the archive gains no
 * duplicate rows (the tick_anchor unique index is the atomic backstop against
 * concurrent overlapping polls). `store` is the OLD (pre-advance) store, read
 * for each series' predecessor anchor. Pure shaping — no I/O.
 */
function buildArchiveTick(
  planetRows: PlanetArchiveWriteRow[],
  store: SampleStore,
  global: GlobalSample[],
  mo: MoObjectiveSeries[],
  signatures: SignatureObservation[],
  moObservations: MoProgressObservation[] | null,
  nowMs: number,
): ArchiveTick {
  // Global sample committed iff the series gained a point at this tick.
  const globalTail = global[global.length - 1];
  const globalCommitted = globalTail != null && globalTail.t === nowMs;
  let globalRow: GlobalArchiveWriteRow | null =
    globalCommitted && globalTail
      ? {
          sampled_at: nowMs,
          player_count: globalTail.player_count,
          impact_multiplier: globalTail.impact_multiplier ?? null,
          active_campaign_count: globalTail.active_campaign_count ?? null,
          missions_won: globalTail.missions_won,
          missions_lost: globalTail.missions_lost,
          deaths: globalTail.deaths,
          terminid_kills: globalTail.terminid_kills,
          automaton_kills: globalTail.automaton_kills,
          illuminate_kills: globalTail.illuminate_kills,
          tick_anchor: tickAnchor(
            store.global?.[store.global.length - 1]?.t,
            nowMs,
          ),
        }
      : null;

  // Item 7: plausibility screen on the archive-bound global row — the known
  // sentinel signature + the Nσ delta-outlier rule over the RECENT (pre-
  // advance) series. A failing row is DIVERTED to quarantined_samples with
  // its reason and both sides of the comparison — never silently dropped,
  // never written to the live table. The KV ring buffer above is untouched
  // (frozen path): the observation is still served live, only the durable
  // archive is screened. The allFresh gate is unchanged — this branch runs
  // strictly after it, at row-assembly time.
  const quarantined: QuarantineRow[] = [];
  if (globalRow) {
    // The recent series EXCLUDING this tick's point: the old store's tail.
    const recent = store.global ?? [];
    const findings = screenGlobalRow(globalRow, recent);
    if (findings.length > 0) {
      // ONE quarantine row per diverted subject (the dedup index is keyed on
      // table/subject/anchor); every finding rides the detail JSON.
      quarantined.push({
        table_name: "global_samples",
        subject_key: "global",
        sampled_at: nowMs,
        reason: findings[0]!.reason,
        detail: JSON.stringify(findings.map((f) => f.detail)),
        row_json: JSON.stringify(globalRow),
        tick_anchor: globalRow.tick_anchor,
      });
      globalRow = null;
    }
  }

  // MO rows: one per series that gained a sample at this tick (a series carried
  // forward unchanged keeps an older tail and is skipped). Each anchors on its
  // OWN predecessor (the matching old series' tail).
  const oldMoTail = new Map<string, number>();
  for (const s of store.mo ?? []) {
    const t = s.samples[s.samples.length - 1]?.t;
    if (t != null) oldMoTail.set(`${s.major_order_id}:${s.objective_index}`, t);
  }
  const moRows: MoArchiveWriteRow[] = [];
  for (const series of mo) {
    const tail = series.samples[series.samples.length - 1];
    if (tail && tail.t === nowMs) {
      moRows.push({
        major_order_id: series.major_order_id,
        objective_index: series.objective_index,
        sampled_at: nowMs,
        progress: tail.progress,
        target: tail.target,
        tick_anchor: tickAnchor(
          oldMoTail.get(`${series.major_order_id}:${series.objective_index}`),
          nowMs,
        ),
      });
    }
  }

  // Signatures are upserted only on a fresh tick (one that committed at least
  // one new KV sample), so 45s cache replays never inflate sample_count — the
  // same discipline foldSignatures applies to the KV record. Deduped by
  // signature key within the cycle (many campaigns share one signature).
  const tickIsFresh =
    planetRows.length > 0 || globalCommitted || moRows.length > 0;
  const signatureRows: SignatureArchiveRow[] = [];
  if (tickIsFresh && signatures.length > 0) {
    const seen = new Set<string>();
    for (const sig of signatures) {
      const key = signatureKeyString(sig);
      if (seen.has(key)) continue;
      seen.add(key);
      signatureRows.push({
        signature: key,
        campaign_type: sig.campaign_type,
        event_type: sig.event_type,
        has_event: sig.has_event ? 1 : 0,
        faction: sig.faction,
        seen_at: nowMs,
      });
    }
  }

  // Item 10: end-of-order detection. An MO id that WAS being tracked (a
  // retained series in the old store) but is absent from THIS poll's live
  // assignments observations has observably ended — record each objective's
  // FINAL retained state. Only when observations were actually supplied
  // (moObservations null = no assignments fetch this poll — absence of
  // evidence, abstain) and only on a fresh tick (the same freshness the
  // signature upsert requires, so a within-60s cache replay adds no D1
  // write). Re-detections while the retired series is retained are no-ops
  // via the natural-PK INSERT OR IGNORE — first writer wins.
  const moOutcomes: MoOutcomeRow[] = [];
  if (moObservations != null && tickIsFresh) {
    const activeIds = new Set(moObservations.map((o) => o.majorOrderId));
    for (const series of store.mo ?? []) {
      if (activeIds.has(series.major_order_id)) continue;
      const first = series.samples[0];
      const tail = series.samples[series.samples.length - 1];
      if (!tail) continue;
      const reached =
        tail.progress != null && tail.target != null
          ? tail.progress >= tail.target
            ? 1
            : 0
          : null;
      moOutcomes.push({
        major_order_id: series.major_order_id,
        objective_index: series.objective_index,
        task_type: series.task_type,
        final_progress: tail.progress,
        target: tail.target,
        final_progress_pct:
          tail.progress != null && tail.target != null && tail.target > 0
            ? (tail.progress / tail.target) * 100
            : null,
        target_reached: reached as 0 | 1 | null,
        first_observed_at: first?.t ?? null,
        last_observed_at: tail.t,
        recorded_at: nowMs,
      });
    }
  }

  return {
    planets: planetRows,
    global: globalRow,
    mo: moRows,
    signatures: signatureRows,
    quarantined,
    moOutcomes,
  };
}

/** KV TTL for the combined sample/accumulation store key. */
export const SAMPLES_KEY_TTL_SECONDS = 30 * 86_400;

/**
 * Read-only view of one planet's retained sample series for
 * get_planet_history: one KV read, zero writes — history lookups never touch
 * the sampling write budget.
 */
export async function readPlanetSamples(
  env: Env,
  planetIndex: number,
): Promise<HealthSample[]> {
  const store = await readSampleStore(env);
  return store.planets[String(planetIndex)]?.samples ?? [];
}

/** Stage 5: read-only view of the accumulated signature record for
 * get_observed_signatures — one KV read, zero writes. */
export async function readObservedSignatures(
  env: Env,
): Promise<ObservedSignature[]> {
  const store = await readSampleStore(env);
  return store.signatures ?? [];
}

/** Stage 5: read-only view of the retained global statistics series for
 * get_global_history — one KV read, zero writes. */
export async function readGlobalSamples(env: Env): Promise<GlobalSample[]> {
  const store = await readSampleStore(env);
  return store.global ?? [];
}

/** Stage 8: read-only view of the retained Major Order progress series for
 * get_major_order_history — one KV read, zero writes. */
export async function readMoSeries(env: Env): Promise<MoObjectiveSeries[]> {
  const store = await readSampleStore(env);
  return store.mo ?? [];
}
