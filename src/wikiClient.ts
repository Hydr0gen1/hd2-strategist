/**
 * I/O layer for the wiki LORE source: fetch helldivers.wiki.gg + KV caching.
 * Deliberately separate from client.ts (the live war-state upstream) — the
 * two sources never share a fetch path, and the `wiki:` KV namespace never
 * collides with the short-lived `raw:` war-state cache.
 *
 * Caching is keyed on the CANONICAL page title (lowercased, spaces →
 * underscores) so casing variants collapse to one entry. Intro extracts are
 * cached 24h (lore changes rarely); full pages 1h (stat/patch pages move
 * faster). On any fetch failure this throws a typed WikiError — it never
 * returns a partial object or a stale copy (the caller decides what to do
 * with the error; the live war-state tools are unaffected either way).
 */
import { buildWikiQueryUrl, shapeWikiPage, wikiCacheKey } from "./wiki";
import type { Env, WikiPageFound, WikiPageResult } from "./types";

/** Intro extract cache window: 24 hours. */
export const INTRO_CACHE_TTL_SECONDS = 86_400;
/** Full-page (wikitext) cache window: 1 hour. */
export const FULL_CACHE_TTL_SECONDS = 3_600;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * MediaWiki API etiquette requires a descriptive User-Agent identifying the
 * app and a contact. Fixed string (the repo URL + a one-line description) so
 * it is always meaningful and never accidentally omitted.
 */
export const WIKI_USER_AGENT =
  "hd2-strategist/1.0 (https://github.com/Hydr0gen1/hd2-strategist; " +
  "Cloudflare Worker MCP server for Helldivers 2 strategic analysis)";

export class WikiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WikiError";
  }
}

/** Injectable fetch so unit tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

function isFound(result: WikiPageResult): result is WikiPageFound {
  return !("found" in result);
}

/**
 * Cache-first wiki page fetch:
 *   1. Read KV under the input-normalized key; a hit returns it with
 *      `cached: true` (its stored `retrieved_at` is the write time). A KV
 *      read failure is swallowed and falls through to a live fetch.
 *   2. Live-fetch the Action API with the descriptive User-Agent. Any
 *      network / HTTP / non-JSON / malformed-shape failure throws a typed
 *      WikiError — never a partial object, never a stale fallback.
 *   3. A missing page returns the not-found shape WITHOUT caching (it may be
 *      created later). A found page is cached under the CANONICAL-title key
 *      (TTL by mode) and returned with `cached: false`.
 */
export async function fetchWikiPage(
  env: Env,
  args: { title: string; full?: boolean },
  opts: { fetchFn?: FetchLike; nowMs?: number } = {},
): Promise<WikiPageResult> {
  const fetchFn: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const now = opts.nowMs ?? Date.now();
  const full = args.full === true;
  const { title } = args;
  // The read key is derived from the INPUT title (casing-normalized). On a
  // write we also store under the CANONICAL title; when a redirect makes the
  // two differ (e.g. "Eruptor" → "R-36 Eruptor") we additionally write this
  // alias key so repeat calls with the same alias hit cache instead of
  // refetching (avoids needless wiki traffic / rate limits).
  const requestKey = wikiCacheKey(title, full);

  // 1. Cache read — keyed on the input title (casing-normalized). KV being
  // unavailable must never fail the call: swallow and live-fetch instead.
  if (env.WAR_CACHE) {
    try {
      const cached = await env.WAR_CACHE.get<WikiPageFound>(requestKey, "json");
      if (cached) return { ...cached, cached: true };
    } catch {
      // KV down — fall through to a live fetch.
    }
  }

  // 2. Live fetch. No stale fallback on failure (the spec is explicit): throw.
  let response: Response;
  try {
    response = await fetchFn(buildWikiQueryUrl(title, full), {
      headers: { Accept: "application/json", "User-Agent": WIKI_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WikiError(
      `Wiki request for "${title}" failed (${err instanceof Error ? err.message : "network error"}). The live war-state tools are unaffected.`,
    );
  }

  if (!response.ok) {
    const reason =
      response.status === 429 ? "rate limited (429)" : `returned ${response.status}`;
    throw new WikiError(
      `Wiki ${reason} for "${title}". Try again shortly; the live war-state tools are unaffected.`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new WikiError(
      `Wiki returned a non-JSON response for "${title}". The live war-state tools are unaffected.`,
    );
  }

  let result: WikiPageResult;
  try {
    result = shapeWikiPage(body, { title, full }, now);
  } catch (err) {
    throw new WikiError(
      err instanceof Error ? err.message : "Unexpected wiki API response.",
    );
  }

  // 3. Cache only FOUND pages. Write under the canonical-title key, plus the
  // input alias key when a redirect made it differ — so a redirect alias hits
  // cache on its next call instead of refetching. A missing page is never
  // cached (it might be created on the wiki later).
  if (isFound(result) && env.WAR_CACHE) {
    const serialized = JSON.stringify(result);
    const ttl = {
      expirationTtl: full ? FULL_CACHE_TTL_SECONDS : INTRO_CACHE_TTL_SECONDS,
    };
    const canonicalKey = wikiCacheKey(result.title, full);
    const keys =
      canonicalKey === requestKey
        ? [canonicalKey]
        : [canonicalKey, requestKey];
    for (const key of keys) {
      try {
        await env.WAR_CACHE.put(key, serialized, ttl);
      } catch {
        // Cache write failures must never break a successful wiki read.
      }
    }
  }

  return result;
}
