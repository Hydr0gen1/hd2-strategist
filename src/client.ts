/**
 * Upstream fetch wrapper + KV caching + HP rate sampling.
 * Auth headers come from env secrets (SUPER_CLIENT / SUPER_CONTACT) — never
 * hardcoded. Raw responses are cached; invariant normalization always runs
 * AFTER the cache read, so logic changes never require cache invalidation.
 */
import type { Env } from "./types";

const BASE_URL = "https://api.helldivers2.dev";
/** Freshness window for raw upstream responses. */
export const CACHE_TTL_SECONDS = 45;
/** How long stale copies survive in KV to serve as 429/5xx fallback. */
const STALE_KEEP_TTL_SECONDS = 600;
/** Minimum spacing between two health samples for a rate to be computed. */
export const MIN_SAMPLE_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const SAMPLES_KEY = "samples:planets";

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

interface SampleStore {
  planets: Record<string, { h: number; t: number; lastRate: number | null }>;
  campaignsFirstSeen: Record<string, number>;
}

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

/**
 * One KV read + one KV write for the whole batch (O(n) over the campaign
 * list, no nested loops). Rates only update once samples are at least
 * MIN_SAMPLE_INTERVAL_MS apart; between updates the last computed rate is
 * reused so cached health reads don't collapse the rate to a bogus 0.
 */
export async function samplePlanetRates(
  env: Env,
  inputs: SampleInput[],
  nowMs: number = Date.now(),
): Promise<Map<number, SampleOutput>> {
  const results = new Map<number, SampleOutput>();
  let store: SampleStore = { planets: {}, campaignsFirstSeen: {} };
  if (env.WAR_CACHE) {
    try {
      const existing = await env.WAR_CACHE.get<SampleStore>(
        SAMPLES_KEY,
        "json",
      );
      if (existing) {
        store = {
          planets: existing.planets ?? {},
          campaignsFirstSeen: existing.campaignsFirstSeen ?? {},
        };
      }
    } catch {
      // Treat unreadable state as empty; rates will rebuild.
    }
  }

  const nextStore: SampleStore = { planets: {}, campaignsFirstSeen: {} };

  for (const input of inputs) {
    const idxKey = String(input.planetIndex);
    let hpPerHour: number | null = null;

    if (input.health != null && Number.isFinite(input.health)) {
      const prev = store.planets[idxKey];
      if (prev && nowMs - prev.t >= MIN_SAMPLE_INTERVAL_MS) {
        const hoursElapsed = (nowMs - prev.t) / 3_600_000;
        // See sign convention block above: positive = progressing.
        hpPerHour = (prev.h - input.health) / hoursElapsed;
        nextStore.planets[idxKey] = {
          h: input.health,
          t: nowMs,
          lastRate: hpPerHour,
        };
      } else if (prev) {
        hpPerHour = prev.lastRate;
        nextStore.planets[idxKey] = prev;
      } else {
        nextStore.planets[idxKey] = {
          h: input.health,
          t: nowMs,
          lastRate: null,
        };
      }
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
        // Samples for campaigns that ended simply age out.
        expirationTtl: 86_400,
      });
    } catch {
      // Best-effort persistence; next request reseeds.
    }
  }

  return results;
}
