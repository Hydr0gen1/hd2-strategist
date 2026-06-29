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
import type { WikiInfobox, WikiPageNotFound, WikiPageResult } from "./types";

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

/**
 * KV key for the page's RAW WIKITEXT, cached separately from the intro/full
 * entries so the intro extract (24h) and its parsed infobox (sourced from this
 * 1h wikitext) age out on independent TTLs. Default (intro) requests fetch
 * this once to populate `infobox` without forcing the caller into `full: true`.
 */
export function wikiWikitextCacheKey(title: string): string {
  return `wiki:page:${normalizeTitle(title)}:wikitext`;
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
  /** Set (with `invalidreason`) when the title contains illegal characters. */
  invalid?: unknown;
  extract?: unknown;
  revisions?: Array<{ slots?: { main?: { content?: unknown } } }>;
}

interface RawWikiResponse {
  query?: { pages?: RawWikiPage[] };
}

/**
 * Shape one raw Action API response into the tool payload. The canonical
 * `title` (post-redirect) governs both the output and the cache write key.
 * A `missing` OR `invalid` page → the not-found shape (never a throw): an
 * invalid title (illegal characters like `<`, `{`, `[`, or a bare namespace
 * prefix) carries an `invalid` attribute and no extract, and must NOT be
 * shaped/cached as an empty-extract success. An existing page with an empty
 * extract is still a FOUND page (extract: ""). An unexpected body shape (no
 * pages array) throws — the I/O layer wraps it as a WikiError.
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
  if (
    page == null ||
    page.missing !== undefined ||
    page.invalid !== undefined
  ) {
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

/**
 * Pull the raw wikitext out of a `prop=revisions&rvslots=main` response —
 * pages[0].revisions[0].slots.main.content. Returns "" on any absent/garbled
 * slot (never throws); the caller treats "" as "no infobox available".
 */
export function extractWikitextContent(body: unknown): string {
  const pages = (body as RawWikiResponse | null | undefined)?.query?.pages;
  if (!Array.isArray(pages) || pages.length === 0) return "";
  const content = pages[0]?.revisions?.[0]?.slots?.main?.content;
  return typeof content === "string" ? content : "";
}

/* ---- infobox parsing (pure; lore/context only, never a live war number) ---- */

/** Recognized infobox template families → the emitted `type` value. */
const INFOBOX_TYPES: Record<string, WikiInfobox["type"]> = {
  "infobox weapon": "weapon",
  "infobox warbond": "warbond",
  "infobox armor": "armor",
  "infobox stratagem": "stratagem",
};

/** Empty infobox result (no recognized infobox on the page). */
const NO_INFOBOX: WikiInfobox = { type: null, fields: {} };

/**
 * Render a single (non-nested) wiki template `{{name|arg1|arg2|…}}` to plain
 * text, covering the patterns that actually appear in Helldivers infoboxes.
 * Anything unrecognized renders to "" (the field is dropped if it cleans empty).
 * No recursion — nested templates are handled by the innermost-first loop in
 * `cleanInfoboxValue`.
 */
function renderTemplate(inner: string): string {
  const parts = inner.split("|");
  const name = (parts[0] ?? "").trim().toLowerCase();
  switch (name) {
    case "damage": {
      // {{Damage|Ballistic|230 Projectile|notext}} → "230" (2nd arg, 1st token)
      const seg = (parts[2] ?? "").trim();
      return seg.split(/\s+/)[0] ?? "";
    }
    case "armor": {
      // {{Armor|4|AP}} → "AP4" (type + number)
      const num = (parts[1] ?? "").trim();
      const apType = (parts[2] ?? "").trim();
      return `${apType}${num}`;
    }
    case "currency": {
      // {{Currency|Medals|60}} → "60 Medals"
      const kind = (parts[1] ?? "").trim();
      const amount = (parts[2] ?? "").trim();
      return amount && kind ? `${amount} ${kind}` : `${amount}${kind}`;
    }
    default:
      return "";
  }
}

/**
 * Clean a raw infobox field value to plain text per the documented rules:
 * `{{*}}`→", "; `<br>`→" / "; nested `{{…}}` resolved (Damage/Armor/Currency)
 * or stripped; `[[Link|Display]]`→display; `<small>` stripped; `''italic''`
 * stripped; dangling/unmatched braces removed; whitespace collapsed. Never
 * throws on malformed markup (edge case 5).
 */
export function cleanInfoboxValue(raw: string): string {
  let s = raw;
  // List separator and line break first (so their surrounding whitespace is
  // absorbed and the generic template pass never eats `{{*}}`).
  s = s.replace(/\s*\{\{\s*\*\s*\}\}\s*/g, ", ");
  s = s.replace(/\s*<br\s*\/?>\s*/gi, " / ");
  // Innermost-first template resolution (no recursive arg parsing). Bounded
  // iteration guards against pathological input.
  for (let i = 0; i < 32 && s.includes("{{"); i++) {
    const next = s.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) =>
      renderTemplate(body),
    );
    if (next === s) break;
    s = next;
  }
  // Unmatched `{{` (no closing) → strip to end of value; drop any stray `}}`.
  s = s.replace(/\{\{[\s\S]*$/g, "").replace(/\}\}/g, "");
  // Wiki links: keep display text (after the last pipe) or the bare target.
  s = s.replace(/\[\[([^[\]]*)\]\]/g, (_m, body: string) => {
    const pipe = body.lastIndexOf("|");
    return pipe === -1 ? body : body.slice(pipe + 1);
  });
  // <small> wrapper stripped (content kept); italic/bold markup stripped.
  s = s.replace(/<\/?small>/gi, "");
  s = s.replace(/'''/g, "").replace(/''/g, "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split an infobox template body into top-level `| key = value` segments,
 * respecting nested `{{…}}` and `[[…]]` (whose interior pipes are NOT field
 * separators). The first segment is the template name and is returned too;
 * the caller skips it.
 */
function splitTopLevelFields(inner: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let templateDepth = 0;
  let linkDepth = 0;
  let i = 0;
  while (i < inner.length) {
    if (inner.startsWith("{{", i)) {
      templateDepth++;
      buf += "{{";
      i += 2;
    } else if (inner.startsWith("}}", i)) {
      if (templateDepth > 0) templateDepth--;
      buf += "}}";
      i += 2;
    } else if (inner.startsWith("[[", i)) {
      linkDepth++;
      buf += "[[";
      i += 2;
    } else if (inner.startsWith("]]", i)) {
      if (linkDepth > 0) linkDepth--;
      buf += "]]";
      i += 2;
    } else if (inner[i] === "|" && templateDepth === 0 && linkDepth === 0) {
      segments.push(buf);
      buf = "";
      i++;
    } else {
      buf += inner[i];
      i++;
    }
  }
  segments.push(buf);
  return segments;
}

/**
 * Parse the FIRST infobox template found in a page's wikitext into structured
 * `{ type, fields }`. Lore/context only — community-authored, possibly stale,
 * and never a live war-state value. Returns `{ type: null, fields: {} }` when
 * the page has no infobox, an unrecognized one, or empty wikitext. Never throws
 * on malformed markup.
 *
 * Block boundary uses brace-depth tracking from the opening `{{Infobox` (not a
 * line split), so a closing `}}` sharing a line with nested templates is found
 * correctly. Only the first infobox is used; `image`/`caption-image` filename
 * fields are skipped; values that clean to empty are dropped.
 */
export function parseInfobox(wikitext: string): WikiInfobox {
  if (!wikitext) return NO_INFOBOX;
  const start = wikitext.toLowerCase().indexOf("{{infobox");
  if (start === -1) return NO_INFOBOX;

  // Template name: from just after `{{` up to the first `|`, newline, or `}}`.
  const nameMatch = wikitext.slice(start + 2).match(/^([^\n|}]*)/);
  const rawName = (nameMatch?.[1] ?? "").trim();
  const type = INFOBOX_TYPES[rawName.replace(/_/g, " ").toLowerCase()] ?? null;
  // Unrecognized infobox → reported as absent (no field extraction).
  if (type === null) return NO_INFOBOX;

  // Block boundary by brace-depth from the opening `{{`.
  let depth = 0;
  let end = wikitext.length;
  let i = start;
  while (i < wikitext.length) {
    if (wikitext.startsWith("{{", i)) {
      depth++;
      i += 2;
    } else if (wikitext.startsWith("}}", i)) {
      depth--;
      i += 2;
      if (depth === 0) {
        end = i;
        break;
      }
    } else {
      i++;
    }
  }

  const inner = wikitext.slice(start + 2, end - 2);
  const fields: Record<string, string> = {};
  // Segment 0 is the template name — skip it.
  for (const segment of splitTopLevelFields(inner).slice(1)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase().replace(/ /g, "_");
    if (!key || key === "image" || key === "caption-image") continue;
    const value = cleanInfoboxValue(segment.slice(eq + 1));
    if (value === "") continue;
    fields[key] = value;
  }
  return { type, fields };
}
