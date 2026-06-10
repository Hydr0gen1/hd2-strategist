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
 * Endpoint verified live (2026-06-10): the API entry point is the ROOT
 * /api.php (the /w/api.php path 404s), MediaWiki 1.43.6 with the
 * TextExtracts extension enabled (prop=extracts works; no fallback needed).
 */
import type { WikiResult } from "./types";

export const WIKI_HOST = "helldivers.wiki.gg";
/** Confirmed entry point — root /api.php, NOT /w/api.php. */
export const WIKI_API_URL = "https://helldivers.wiki.gg/api.php";
/**
 * From the wiki's own siteinfo rightsinfo (verified live): content is
 * Creative Commons Attribution-Non-Commercial-ShareAlike 4.0. Attribution
 * is mandatory on every wiki payload, found or not.
 */
export const WIKI_LICENSE = "CC BY-NC-SA 4.0";
export const WIKI_LICENSE_URL =
  "https://creativecommons.org/licenses/by-nc-sa/4.0";
/** Lead-extract length cap: keep the payload lean; the URL has the rest. */
export const WIKI_EXTRACT_MAX_CHARS = 1_500;

export const WIKI_LORE_NOTE =
  "Community-authored lore from the Helldivers wiki — narrative/background " +
  "context only, not live war state. The live tools (get_planet, " +
  "get_campaigns, get_war_status, …) are authoritative for current war " +
  "state; any ownership, status, or numbers in this text are historical or " +
  "in-fiction. Content license: " +
  WIKI_LICENSE +
  " — attribution to " +
  WIKI_HOST +
  " required when reusing.";

/** A query plan: candidate page titles (preference order) + the request. */
export interface WikiQueryPlan {
  /** Exactly what the caller asked for, trimmed. */
  requested: string;
  /** Page titles to try, in preference order, deduplicated. */
  candidates: string[];
  /** Full Action API URL querying all candidates in one request. */
  url: string;
  /** KV key — separate `wiki:` namespace, never collides with `raw:`. */
  cacheKey: string;
}

/**
 * Mechanical lookup-key conversion: first letter of each whitespace-run word
 * upper, rest lower ("GRAND ERRANT" → "Grand Errant"). Used ONLY to build a
 * wiki title candidate — never to reformat live tool output (display
 * formatting stays the consumer's job, per the roadmap).
 */
export function titleCaseWords(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Build the single-request query plan. An explicit `title` is tried verbatim
 * and alone (the caller controls it). A planet `name` is tried both as sent
 * and title-cased: upstream sends ALL-CAPS names ("GRAND ERRANT") which the
 * case-sensitive wiki misses, while names like "RD-4" only match as sent —
 * so both candidates go in ONE multi-title query (verified supported) and
 * the first existing page in candidate order wins. No silent substitution
 * beyond this deterministic casing variant.
 */
export function planWikiQuery(args: {
  name?: string;
  title?: string;
}): WikiQueryPlan {
  const requested = (args.title ?? args.name ?? "").trim();
  const candidates =
    args.title != null
      ? [requested]
      : [...new Set([requested, titleCaseWords(requested)])];

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "extracts|info",
    inprop: "url",
    explaintext: "1",
    exintro: "1",
    exlimit: "max",
    redirects: "1",
    titles: candidates.join("|"),
  });

  return {
    requested,
    candidates,
    url: `${WIKI_API_URL}?${params.toString()}`,
    cacheKey: `wiki:${candidates.join("|").toLowerCase()}`,
  };
}

/* ---- raw MediaWiki response shapes (only the fields we consume) ---- */

interface RawWikiRename {
  from?: unknown;
  to?: unknown;
}

interface RawWikiPage {
  title?: unknown;
  missing?: unknown;
  extract?: unknown;
  fullurl?: unknown;
  canonicalurl?: unknown;
}

interface RawWikiResponse {
  query?: {
    normalized?: RawWikiRename[];
    redirects?: RawWikiRename[];
    pages?: RawWikiPage[];
  };
}

function renameMap(entries: RawWikiRename[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries ?? []) {
    if (typeof e.from === "string" && typeof e.to === "string") {
      map.set(e.from, e.to);
    }
  }
  return map;
}

/** Mandatory attribution block — present on EVERY wiki payload. */
function attribution(nowMs: number) {
  return {
    source: WIKI_HOST,
    license: WIKI_LICENSE,
    license_url: WIKI_LICENSE_URL,
    retrieved_at: new Date(nowMs).toISOString(),
    notes: WIKI_LORE_NOTE,
  };
}

function notFound(
  plan: Pick<WikiQueryPlan, "requested" | "candidates">,
  nowMs: number,
  url: string | null,
  hint: string,
): WikiResult {
  return {
    found: false,
    requested: plan.requested,
    title: plan.candidates[0] ?? plan.requested,
    extract: null,
    truncated: false,
    url,
    redirected_from: null,
    hint,
    ...attribution(nowMs),
  };
}

/**
 * Shape one raw Action API response into the tool payload. Deterministic
 * resolution: each candidate is followed through the API's `normalized` and
 * `redirects` renames to its final page title; the first candidate (in
 * preference order) whose page exists wins. A followed redirect is reported
 * in `redirected_from` — never silent. Missing page or empty extract →
 * found: false with a hint, never a hard error. Attribution is attached to
 * every outcome.
 */
export function shapeWikiResult(
  body: unknown,
  plan: Pick<WikiQueryPlan, "requested" | "candidates">,
  nowMs: number,
): WikiResult {
  const query = (body as RawWikiResponse | null | undefined)?.query;
  const pages = Array.isArray(query?.pages) ? query.pages : null;
  if (!pages) {
    return notFound(
      plan,
      nowMs,
      null,
      "Unexpected wiki API response shape — the page may exist; try again or open the wiki directly.",
    );
  }

  const normalized = renameMap(query?.normalized);
  const redirects = renameMap(query?.redirects);
  const byTitle = new Map<string, RawWikiPage>();
  for (const p of pages) {
    if (typeof p.title === "string") byTitle.set(p.title, p);
  }

  for (const candidate of plan.candidates) {
    let title = normalized.get(candidate) ?? candidate;
    let redirectedFrom: string | null = null;
    // Follow redirect chains defensively (bounded — wikis forbid loops).
    for (let hop = 0; hop < 5; hop++) {
      const next = redirects.get(title);
      if (next == null) break;
      redirectedFrom = redirectedFrom ?? title;
      title = next;
    }

    const page = byTitle.get(title);
    if (!page || page.missing !== undefined) continue;

    const url =
      typeof page.canonicalurl === "string"
        ? page.canonicalurl
        : typeof page.fullurl === "string"
          ? page.fullurl
          : null;
    const rawExtract =
      typeof page.extract === "string" ? page.extract.trim() : "";
    if (rawExtract === "") {
      // Page exists but TextExtracts produced nothing readable (e.g. a
      // pure-infobox or disambiguation shell): honest found:false + URL.
      return notFound(
        plan,
        nowMs,
        url,
        `The wiki page "${title}" exists but has no plain-text intro extract. See the page URL for the full content.`,
      );
    }

    const truncated = rawExtract.length > WIKI_EXTRACT_MAX_CHARS;
    return {
      found: true,
      requested: plan.requested,
      title,
      extract: truncated
        ? `${rawExtract.slice(0, WIKI_EXTRACT_MAX_CHARS).trimEnd()}…`
        : rawExtract,
      truncated,
      url,
      redirected_from: redirectedFrom,
      ...attribution(nowMs),
    };
  }

  // Every candidate missing: report the attempt; never substitute a page.
  const attempted = plan.candidates[0] ?? plan.requested;
  const missingPage = byTitle.get(attempted) ?? pages[0];
  return notFound(
    plan,
    nowMs,
    typeof missingPage?.canonicalurl === "string"
      ? missingPage.canonicalurl
      : null,
    `No wiki page found for "${plan.requested}". Try the exact wiki page title via the \`title\` argument (e.g. "Jet Brigade", "Predator Strain", "Hive Lord") — no alternative page was substituted.`,
  );
}
