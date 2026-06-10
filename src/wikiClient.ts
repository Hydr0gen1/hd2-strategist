/**
 * I/O layer for the wiki LORE source: fetch helldivers.wiki.gg + KV caching.
 * Deliberately separate from client.ts (the live war-state upstream) — the
 * two sources never share a fetch path, and the `wiki:` KV namespace never
 * collides with the short-lived `raw:` war-state cache.
 *
 * Caching is aggressive because lore changes rarely: a long fresh window
 * plus a much longer stale-fallback retention, mirroring the war-state
 * cache's stale-on-failure semantics (never crash; structured error only
 * when there is no copy at all). This also shields the wiki from rate
 * limits — repeat lookups are served entirely from KV.
 */
import type { Env } from "./types";

/** Fresh window: serve from KV without touching the wiki for 6 hours. */
export const WIKI_CACHE_TTL_SECONDS = 21_600;
/** How long copies survive in KV as a down/rate-limited fallback: 7 days. */
export const WIKI_STALE_KEEP_TTL_SECONDS = 604_800;
const FETCH_TIMEOUT_MS = 8_000;

export class WikiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WikiError";
  }
}

interface WikiCacheEnvelope {
  fetchedAt: number;
  body: unknown;
}

export interface WikiFetchResult {
  body: unknown;
  /** True when served from an expired cache copy due to wiki failure. */
  stale: boolean;
}

/** Injectable fetch so unit tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/**
 * MediaWiki etiquette: send a descriptive User-Agent identifying the app
 * and a contact. Reuses the SUPER_CLIENT/SUPER_CONTACT secrets in spirit,
 * with non-secret repo fallbacks so the header is always meaningful.
 */
export function wikiUserAgent(env: Env): string {
  const client = env.SUPER_CLIENT || "hd2-strategist";
  const contact =
    env.SUPER_CONTACT || "https://github.com/Hydr0gen1/hd2-strategist";
  return `${client} (${contact})`;
}

/**
 * Cache-first wiki GET, same shape as client.ts fetchUpstream:
 * fresh KV copy → return; otherwise fetch the wiki and cache the RAW body
 * (shaping always runs after the cache read, so shaping changes never need
 * invalidation); on failure fall back to any stale copy (stale: true);
 * with no fallback, throw a typed WikiError — never a raw exception.
 */
export async function fetchWikiQuery(
  env: Env,
  plan: { url: string; cacheKey: string },
  opts: { fetchFn?: FetchLike; nowMs?: number } = {},
): Promise<WikiFetchResult> {
  const fetchFn: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const now = opts.nowMs ?? Date.now();

  let cached: WikiCacheEnvelope | null = null;
  if (env.WAR_CACHE) {
    try {
      cached = await env.WAR_CACHE.get<WikiCacheEnvelope>(
        plan.cacheKey,
        "json",
      );
    } catch {
      cached = null;
    }
  }
  if (cached && now - cached.fetchedAt < WIKI_CACHE_TTL_SECONDS * 1000) {
    return { body: cached.body, stale: false };
  }

  let response: Response;
  try {
    response = await fetchFn(plan.url, {
      headers: {
        Accept: "application/json",
        "User-Agent": wikiUserAgent(env),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (cached) return { body: cached.body, stale: true };
    throw new WikiError(
      `Wiki request failed (${err instanceof Error ? err.message : "network error"}) and no cached copy is available. The live war-state tools are unaffected.`,
    );
  }

  if (!response.ok) {
    if (cached) return { body: cached.body, stale: true };
    const reason =
      response.status === 429
        ? "rate limited (429)"
        : `returned ${response.status}`;
    throw new WikiError(
      `Wiki ${reason} and no cached copy is available. Try again shortly; the live war-state tools are unaffected.`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (cached) return { body: cached.body, stale: true };
    throw new WikiError(
      "Wiki returned a non-JSON response and no cached copy is available.",
    );
  }

  if (env.WAR_CACHE) {
    try {
      await env.WAR_CACHE.put(
        plan.cacheKey,
        JSON.stringify({ fetchedAt: now, body } satisfies WikiCacheEnvelope),
        { expirationTtl: WIKI_STALE_KEEP_TTL_SECONDS },
      );
    } catch {
      // Cache write failures must never break a successful wiki read.
    }
  }
  return { body, stale: false };
}
