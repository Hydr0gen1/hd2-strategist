/**
 * Upstream fetch wrapper + KV caching + HP rate sampling.
 * Auth headers come from env secrets (SUPER_CLIENT / SUPER_CONTACT) — never
 * hardcoded. Raw responses are cached; invariant normalization always runs
 * AFTER the cache read, so logic changes never require cache invalidation.
 */
import {
  advanceGlobalSeries,
  advancePlanetSeries,
  coerceStore,
  foldSignatures,
  type GlobalSample,
  type HealthSample,
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

export { MIN_SAMPLE_INTERVAL_MS } from "./sampling";

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
    return { data: cached.body as T, stale: false };
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
    if (cached) return { data: cached.body as T, stale: true };
    throw new UpstreamError(
      `Upstream request to ${path} failed (${err instanceof Error ? err.message : "network error"}) and no cached copy is available.`,
    );
  }

  if (!response.ok) {
    if (cached) return { data: cached.body as T, stale: true };
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
  return { data: body, stale: false };
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
}

export interface SampleOutput {
  hpPerHour: number | null;
  /** ms since the campaign was first seen by this Worker; null if no id. */
  campaignAgeMs: number | null;
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
 * Stage 5: the accumulation layers (observed campaign signatures and the
 * global statistics series) ride this SAME single write — never a second
 * per-cycle KV put. Unlike planet series they ALWAYS carry forward,
 * regardless of carryForward: that flag's rebuild semantics apply to planet
 * series and campaign first-seen ages only. A call without `signatures` /
 * `globalStatistics` passes both layers through untouched.
 */
export async function samplePlanetRates(
  env: Env,
  inputs: SampleInput[],
  nowMs: number = Date.now(),
  opts: {
    carryForward?: boolean;
    signatures?: SignatureObservation[];
    globalStatistics?: RawStatistics | null;
  } = {},
): Promise<Map<number, SampleOutput>> {
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
  );
  if (global.length > 0) nextStore.global = global;

  for (const input of inputs) {
    const idxKey = String(input.planetIndex);

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

    let campaignAgeMs: number | null = null;
    if (input.campaignId != null) {
      const cidKey = String(input.campaignId);
      const firstSeen = store.campaignsFirstSeen[cidKey] ?? nowMs;
      nextStore.campaignsFirstSeen[cidKey] = firstSeen;
      campaignAgeMs = nowMs - firstSeen;
    }

    results.set(input.planetIndex, { hpPerHour, campaignAgeMs });
  }

  if (env.WAR_CACHE) {
    try {
      await env.WAR_CACHE.put(SAMPLES_KEY, JSON.stringify(nextStore), {
        // 30 days, refreshed on every write: planet samples still age out
        // in code at 48h (sampling.ts), but the Stage 5 accumulation layers
        // must survive gaps in usage — a truly abandoned store still
        // evaporates after a month.
        expirationTtl: SAMPLES_KEY_TTL_SECONDS,
      });
    } catch {
      // Best-effort persistence; next request reseeds.
    }
  }

  return results;
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
