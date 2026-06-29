/**
 * Lore source: helldivers.wiki.gg (MediaWiki Action API) — pure logic only.
 * Zero I/O; the fetch + KV caching live in wikiClient.ts.
 *
 * SEPARATION RULE (Stage 4): the wiki is a NEW, clearly-separated source.
 * Live tools say WHAT IS HAPPENING (verifiable war facts); the wiki says
 * WHAT IT MEANS (community-authored lore). Nothing in this module reads or
 * returns live war-state numbers (HP, rates, ownership), and no live tool
 * may import wiki prose into its fields. The two sources are joined only in
 * the conversation layer, by the consumer.
 *
 * Endpoints verified live (2026-06-29):
 *   - Entry point is the ROOT /api.php (the /w/api.php path 404s).
 *   - Intro extract: prop=extracts&explaintext=1&exintro=1 (the TextExtracts
 *     extension IS enabled — plain text, no fallback needed).
 *   - Full page: prop=revisions&rvprop=content&rvslots=main returns the raw
 *     wikitext at pages[].revisions[0].slots.main.content (extracts can only
 *     return rendered text, so a full fetch always uses revisions).
 *   - redirects=1 resolves redirects silently; the canonical title comes back
 *     in pages[].title ("Eruptor" → "R-36 Eruptor").
 *   - A missing page carries a `missing` field on the page object.
 *   - The wiki's own siteinfo rightsinfo reports CC BY-NC-SA 4.0 (NOT a plain
 *     CC BY-SA — the NonCommercial clause is real and is reflected here).
 */
import type { WikiPageNotFound, WikiPageResult } from "./types";

export const WIKI_HOST = "helldivers.wiki.gg" as const;
/** Confirmed entry point — root /api.php, NOT /w/api.php. */
export const WIKI_API_URL = "https://helldivers.wiki.gg/api.php";
/**
 * The wiki's own rightsinfo (verified live 2026-06-29): Creative Commons
 * Attribution-NonCommercial-ShareAlike 4.0. Attribution is mandatory on every
 * wiki payload. NOTE: the implementation spec's example said "CC BY-SA"; the
 * live siteinfo says BY-NC-SA, and emitting the accurate license is the whole
 * point of this correctness layer — so the verified value is what ships.
 */
export const WIKI_LICENSE = "CC BY-NC-SA 4.0";
/** Fixed lore disclaimer string, present on every found payload. */
export const WIKI_LORE_NOTE =
  "Community-authored lore. Live tools (get_planet, get_campaigns, etc.) are " +
  "authoritative for current war state.";

/**
 * Cache-key normalization: lowercased, spaces → underscores. Applied to the
 * INPUT title for the read key and to the CANONICAL API title for the write
 * key, so casing variants ("eruptor"/"ERUPTOR"/"Eruptor") collapse to one
 * cache entry.
 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/ /g, "_");
}

/** KV key in the dedicated `wiki:` namespace; separate intro/full entries. */
export function wikiCacheKey(title: string, full: boolean): string {
  return `wiki:page:${normalizeTitle(title)}:${full ? "full" : "intro"}`;
}

/** Canonical page URL: https://helldivers.wiki.gg/wiki/{encoded_title}. */
export function wikiPageUrl(title: string): string {
  return `https://helldivers.wiki.gg/wiki/${encodeURIComponent(
    title.trim().replace(/ /g, "_"),
  )}`;
}

/**
 * Build the single Action API request URL. Intro uses TextExtracts (plain
 * text); full uses revisions (raw wikitext) because extracts cannot return
 * wikitext. redirects=1 resolves redirects silently in both modes.
 */
export function buildWikiQueryUrl(title: string, full: boolean): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    titles: title,
  });
  if (full) {
    params.set("prop", "revisions");
    params.set("rvprop", "content");
    params.set("rvslots", "main");
  } else {
    params.set("prop", "extracts");
    params.set("explaintext", "1");
    params.set("exintro", "1");
  }
  return `${WIKI_API_URL}?${params.toString()}`;
}

/* ---- raw MediaWiki response shapes (formatversion=2; only consumed fields) ---- */

interface RawWikiPage {
  title?: unknown;
  missing?: unknown;
  extract?: unknown;
  revisions?: Array<{ slots?: { main?: { content?: unknown } } }>;
}

interface RawWikiResponse {
  query?: { pages?: RawWikiPage[] };
}

/**
 * Shape one raw Action API response into the tool payload. The canonical
 * `title` (post-redirect) governs both the output and the cache write key.
 * A `missing` page → the not-found shape (never a throw). An existing page
 * with an empty extract is still a FOUND page (extract: ""). An unexpected
 * body shape (no pages array) throws — the I/O layer wraps it as a WikiError.
 */
export function shapeWikiPage(
  body: unknown,
  args: { title: string; full: boolean },
  nowMs: number,
): WikiPageResult {
  const pages = (body as RawWikiResponse | null | undefined)?.query?.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(
      "Unexpected wiki API response shape (no pages array) — the page may exist; try again or open the wiki directly.",
    );
  }

  const page = pages[0];
  if (page == null || page.missing !== undefined) {
    const notFound: WikiPageNotFound = {
      found: false,
      title: args.title,
      url: wikiPageUrl(args.title),
      source: WIKI_HOST,
    };
    return notFound;
  }

  const canonicalTitle =
    typeof page.title === "string" ? page.title : args.title;

  let extract = "";
  let format: "wikitext" | undefined;
  if (args.full) {
    const content = page.revisions?.[0]?.slots?.main?.content;
    extract = typeof content === "string" ? content : "";
    format = "wikitext";
  } else {
    extract = typeof page.extract === "string" ? page.extract : "";
  }

  return {
    title: canonicalTitle,
    extract,
    url: wikiPageUrl(canonicalTitle),
    source: WIKI_HOST,
    license: WIKI_LICENSE,
    retrieved_at: new Date(nowMs).toISOString(),
    cached: false,
    notes: WIKI_LORE_NOTE,
    ...(format ? { format } : {}),
  };
}
