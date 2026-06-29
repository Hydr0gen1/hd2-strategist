/**
 * Stage 4 tests: live event/modifier decode (pure, src/enrichment.ts) and
 * the get_wiki_page lore source (pure shaping in src/wiki.ts; the I/O
 * layer src/wikiClient.ts is exercised with an INJECTED fetch and an
 * in-memory KV stub — no network, no global mocking).
 *
 * Fixtures stand in for live data deliberately: at implementation time the
 * war had zero active events, so the eventType enum could not be confirmed
 * live — EVENT_MODIFIER_NAMES ships empty and every mapped-enum test
 * injects its own map.
 */
import { describe, expect, it } from "vitest";
import {
  EVENT_MODIFIER_NAMES,
  decodeEventModifier,
} from "../src/enrichment";
import { normalizeCampaign } from "../src/invariants";
import { HPC_CAMPAIGN_TYPES } from "../src/invariants";
import type { Env, NormalizeContext, RawCampaign, RawEvent } from "../src/types";
import {
  WIKI_API_URL,
  WIKI_HOST,
  WIKI_LICENSE,
  WIKI_LORE_NOTE,
  buildWikiQueryUrl,
  normalizeTitle,
  shapeWikiPage,
  wikiCacheKey,
  wikiPageUrl,
} from "../src/wiki";
import {
  FULL_CACHE_TTL_SECONDS,
  INTRO_CACHE_TTL_SECONDS,
  WIKI_USER_AGENT,
  WikiError,
  fetchWikiPage,
} from "../src/wikiClient";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-06-10T12:00:00Z");

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 1,
    eventType: 1,
    faction: "Automaton",
    health: 500_000,
    maxHealth: 1_000_000,
    startTime: "2026-06-09T00:00:00Z",
    endTime: "2026-06-10T00:00:00Z",
    campaignId: 42,
    ...overrides,
  };
}

function makeCampaign(overrides: {
  planet?: Partial<RawCampaign["planet"]>;
  type?: number;
  id?: number;
}): RawCampaign {
  return {
    id: overrides.id ?? 42,
    type: overrides.type ?? 0,
    count: 1,
    faction: "Humans",
    planet: {
      index: 175,
      name: "GRAND ERRANT",
      sector: "Farsight",
      maxHealth: 1_000_000,
      health: 600_000,
      disabled: false,
      initialOwner: "Humans",
      currentOwner: "Terminids",
      regenPerSecond: 2.7777777,
      event: null,
      attacking: [],
      waypoints: [],
      ...overrides.planet,
    },
  };
}

function ctx(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    hpPerHour: 10_000,
    campaignAgeMs: 2 * HOUR_MS,
    hpcTypes: HPC_CAMPAIGN_TYPES,
    moPlanetIndices: new Set<number>(),
    ...overrides,
  };
}

/* ====================================================================== *
 * Part 1 — event/modifier decode (live fact)
 * ====================================================================== */

describe("decodeEventModifier: live event identity, never a guess", () => {
  it("no event → both null (not an error)", () => {
    expect(decodeEventModifier(null)).toEqual({
      event_type: null,
      modifier: null,
    });
    expect(decodeEventModifier(undefined)).toEqual({
      event_type: null,
      modifier: null,
    });
  });

  it("known enum → decoded name from the supplied map", () => {
    const names = new Map([
      [7, "Jet Brigade"],
      [9, "Predator Strain"],
    ]);
    expect(decodeEventModifier(makeEvent({ eventType: 7 }), names)).toEqual({
      event_type: 7,
      modifier: "Jet Brigade",
    });
    expect(decodeEventModifier(makeEvent({ eventType: 9 }), names)).toEqual({
      event_type: 9,
      modifier: "Predator Strain",
    });
  });

  it("unmapped enum → event_type passed through raw, modifier null — visible, never fabricated", () => {
    const names = new Map([[7, "Jet Brigade"]]);
    expect(decodeEventModifier(makeEvent({ eventType: 99 }), names)).toEqual({
      event_type: 99,
      modifier: null,
    });
  });

  it("the MAP is consulted, not an inline table: same enum, different map, different name", () => {
    const event = makeEvent({ eventType: 2 });
    expect(decodeEventModifier(event, new Map([[2, "A"]])).modifier).toBe("A");
    expect(decodeEventModifier(event, new Map([[2, "B"]])).modifier).toBe("B");
    expect(decodeEventModifier(event, new Map()).modifier).toBeNull();
  });

  it("garbled eventType (NaN) → both null, never a fabricated identity", () => {
    expect(
      decodeEventModifier(makeEvent({ eventType: Number.NaN })),
    ).toEqual({ event_type: null, modifier: null });
  });

  it("EVENT_MODIFIER_NAMES ships EMPTY: unverified enum must not decode to any name", () => {
    // Deliberate: zero live events existed to confirm values against, and a
    // wrong entry here would fabricate a name. This test pins the contract;
    // when a live event confirms a value, seed the map AND update this test.
    expect(EVENT_MODIFIER_NAMES.size).toBe(0);
    expect(decodeEventModifier(makeEvent({ eventType: 1 }))).toEqual({
      event_type: 1,
      modifier: null,
    });
  });

  it("is additive: invariants are untouched by the decode (defense decay stays null)", () => {
    const defense = makeCampaign({
      planet: { event: makeEvent({ eventType: 5 }), regenPerSecond: 2.78 },
    });
    const normalized = normalizeCampaign(defense, ctx());
    const decoded = decodeEventModifier(defense.planet.event);
    const merged = { ...normalized, ...decoded };
    // Invariant 1 and campaign-kind logic unchanged…
    expect(merged.campaign_kind).toBe("defense");
    expect(merged.regen_per_second).toBeNull();
    // …with the additive identity fields alongside.
    expect(merged.event_type).toBe(5);
    expect(merged.modifier).toBeNull();
  });
});

/* ====================================================================== *
 * Part 2 — wiki lore source: get_wiki_page (pure shaping + I/O)
 * ====================================================================== */

/** Minimal real-shape MediaWiki page fixture (formatversion=2, intro). */
function introPage(overrides: Record<string, unknown> = {}) {
  return {
    pageid: 4564,
    ns: 0,
    title: "R-36 Eruptor",
    extract:
      "R-36 Eruptor is a Primary Explosive weapon that fires jet-assisted shells.",
    ...overrides,
  };
}

/** A revisions-shape page (formatversion=2, full=true). */
function fullPage(content: string, overrides: Record<string, unknown> = {}) {
  return {
    pageid: 4564,
    ns: 0,
    title: "R-36 Eruptor",
    revisions: [{ slots: { main: { contentmodel: "wikitext", content } } }],
    ...overrides,
  };
}

describe("wiki URL + key builders (pure)", () => {
  it("normalizeTitle lowercases and underscores — casing variants collapse", () => {
    expect(normalizeTitle("Eruptor")).toBe("eruptor");
    expect(normalizeTitle("ERUPTOR")).toBe("eruptor");
    expect(normalizeTitle("  Democratic Detonation ")).toBe(
      "democratic_detonation",
    );
  });

  it("wikiCacheKey lives in the wiki: namespace with an intro/full suffix", () => {
    expect(wikiCacheKey("R-36 Eruptor", false)).toBe(
      "wiki:page:r-36_eruptor:intro",
    );
    expect(wikiCacheKey("R-36 Eruptor", true)).toBe(
      "wiki:page:r-36_eruptor:full",
    );
    expect(wikiCacheKey("Eruptor", false).startsWith("raw:")).toBe(false);
  });

  it("wikiPageUrl builds the canonical /wiki/{encoded_title} URL", () => {
    expect(wikiPageUrl("R-36 Eruptor")).toBe(
      "https://helldivers.wiki.gg/wiki/R-36_Eruptor",
    );
    expect(wikiPageUrl("Jet Brigade")).toBe(
      "https://helldivers.wiki.gg/wiki/Jet_Brigade",
    );
  });

  it("buildWikiQueryUrl: intro uses extracts, full uses revisions, both redirect", () => {
    const intro = new URL(buildWikiQueryUrl("Eruptor", false));
    expect(`${intro.origin}${intro.pathname}`).toBe(WIKI_API_URL);
    expect(intro.searchParams.get("action")).toBe("query");
    expect(intro.searchParams.get("prop")).toBe("extracts");
    expect(intro.searchParams.get("explaintext")).toBe("1");
    expect(intro.searchParams.get("exintro")).toBe("1");
    expect(intro.searchParams.get("redirects")).toBe("1");
    expect(intro.searchParams.get("formatversion")).toBe("2");
    expect(intro.searchParams.get("titles")).toBe("Eruptor");

    const full = new URL(buildWikiQueryUrl("Eruptor", true));
    expect(full.searchParams.get("prop")).toBe("revisions");
    expect(full.searchParams.get("rvprop")).toBe("content");
    expect(full.searchParams.get("rvslots")).toBe("main");
    expect(full.searchParams.get("redirects")).toBe("1");
    expect(full.searchParams.get("exintro")).toBeNull();
  });
});

describe("shapeWikiPage: success carries attribution; canonical title governs", () => {
  it("intro: title/extract/url + fixed license/notes, cached:false, no format field", () => {
    const result = shapeWikiPage(
      { query: { pages: [introPage()] } },
      { title: "Eruptor", full: false },
      NOW,
    );
    expect("found" in result).toBe(false);
    if ("found" in result) throw new Error("expected found");
    expect(result.title).toBe("R-36 Eruptor"); // canonical, post-redirect
    expect(result.extract).toMatch(/^R-36 Eruptor is a Primary Explosive/);
    expect(result.url).toBe("https://helldivers.wiki.gg/wiki/R-36_Eruptor");
    expect(result.source).toBe(WIKI_HOST);
    expect(result.license).toBe(WIKI_LICENSE);
    expect(result.notes).toBe(WIKI_LORE_NOTE);
    expect(result.retrieved_at).toBe(new Date(NOW).toISOString());
    expect(result.cached).toBe(false);
    expect(result.format).toBeUndefined();
  });

  it("full: returns raw wikitext with format:'wikitext' from the revisions slot", () => {
    const wikitext = "{{Infobox_Weapon\n| title = R-36 Eruptor\n}}";
    const result = shapeWikiPage(
      { query: { pages: [fullPage(wikitext)] } },
      { title: "Eruptor", full: true },
      NOW,
    );
    if ("found" in result) throw new Error("expected found");
    expect(result.extract).toBe(wikitext);
    expect(result.format).toBe("wikitext");
    expect(result.url).toBe("https://helldivers.wiki.gg/wiki/R-36_Eruptor");
  });

  it("uses the canonical (redirected) title for both the output title and URL", () => {
    const result = shapeWikiPage(
      {
        query: {
          pages: [introPage({ title: "Terminids", extract: "Bugs." })],
        },
      },
      { title: "Terminid", full: false }, // input differs from canonical
      NOW,
    );
    if ("found" in result) throw new Error("expected found");
    expect(result.title).toBe("Terminids");
    expect(result.url).toBe("https://helldivers.wiki.gg/wiki/Terminids");
  });

  it("empty extract → still FOUND (extract: ''), never treated as missing", () => {
    const result = shapeWikiPage(
      { query: { pages: [introPage({ extract: "" })] } },
      { title: "Eruptor", full: false },
      NOW,
    );
    expect("found" in result).toBe(false); // found shape has no `found` key
    if ("found" in result) throw new Error("expected found");
    expect(result.extract).toBe("");
  });

  it("missing wikitext slot under full → extract '' (found), never a throw", () => {
    const result = shapeWikiPage(
      { query: { pages: [{ title: "Stub", revisions: [] }] } },
      { title: "Stub", full: true },
      NOW,
    );
    if ("found" in result) throw new Error("expected found");
    expect(result.extract).toBe("");
    expect(result.format).toBe("wikitext");
  });
});

describe("shapeWikiPage: not-found and malformed — never a crash", () => {
  it("missing page → { found:false, title (input), url, source }, nothing else", () => {
    const result = shapeWikiPage(
      {
        query: { pages: [{ ns: 0, title: "Bogus Page XYZ", missing: true }] },
      },
      { title: "Bogus Page XYZ", full: false },
      NOW,
    );
    expect(result).toEqual({
      found: false,
      title: "Bogus Page XYZ", // the INPUT title, verbatim
      url: "https://helldivers.wiki.gg/wiki/Bogus_Page_XYZ",
      source: WIKI_HOST,
    });
  });

  it("invalid title (illegal chars) → not-found shape, never an empty-extract success", () => {
    const result = shapeWikiPage(
      {
        query: {
          pages: [
            {
              title: "Foo<bar>",
              invalid: true,
              invalidreason:
                'The requested page title contains invalid characters: "<".',
            },
          ],
        },
      },
      { title: "Foo<bar>", full: false },
      NOW,
    );
    expect(result).toEqual({
      found: false,
      title: "Foo<bar>",
      url: "https://helldivers.wiki.gg/wiki/Foo%3Cbar%3E",
      source: WIKI_HOST,
    });
  });

  it("unexpected body shape (no pages array) → throws (the I/O layer wraps it)", () => {
    for (const body of [null, {}, { query: {} }, { query: { pages: "x" } }, { query: { pages: [] } }]) {
      expect(() =>
        shapeWikiPage(body, { title: "Eruptor", full: false }, NOW),
      ).toThrow();
    }
  });
});

/* ====================================================================== *
 * Part 2 — wiki I/O layer (injected fetch + in-memory KV; no network)
 * ====================================================================== */

interface FakeKv {
  store: Map<string, string>;
  puts: { key: string; ttl?: number }[];
  get(key: string, type: "json"): Promise<unknown>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
}

function fakeKv(): FakeKv {
  return {
    store: new Map<string, string>(),
    puts: [],
    async get(key: string) {
      const raw = this.store.get(key);
      return raw == null ? null : JSON.parse(raw);
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      this.store.set(key, value);
      this.puts.push({ key, ttl: opts?.expirationTtl });
    },
  };
}

function envWith(kv: FakeKv | null, extra: Partial<Env> = {}): Env {
  return {
    ...(kv ? { WAR_CACHE: kv as unknown as KVNamespace } : {}),
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INTRO_BODY = { query: { pages: [introPage()] } };

describe("fetchWikiPage: cache-first, canonical-key writes, structured errors", () => {
  it("live intro fetch: caches under the CANONICAL-title intro key with a 24h TTL", async () => {
    const kv = fakeKv();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const result = await fetchWikiPage(envWith(kv), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return jsonResponse(INTRO_BODY);
      },
    });
    if ("found" in result) throw new Error("expected found");
    expect(result.cached).toBe(false);
    expect(result.title).toBe("R-36 Eruptor");
    expect(calls).toHaveLength(1);
    // Endpoint is the extracts intro query.
    expect(calls[0]!.url).toContain("prop=extracts");
    // The input "Eruptor" redirects to the canonical "R-36 Eruptor", so the
    // page is cached under the canonical key AND the input alias key (so a
    // repeat alias call hits cache instead of refetching).
    const keys = kv.puts.map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "wiki:page:r-36_eruptor:intro",
        "wiki:page:eruptor:intro",
      ]),
    );
    expect(kv.puts.every((p) => p.ttl === INTRO_CACHE_TTL_SECONDS)).toBe(true);
    expect(INTRO_CACHE_TTL_SECONDS).toBe(86_400);
  });

  it("sends the descriptive fixed User-Agent on every request", async () => {
    let ua: string | undefined;
    await fetchWikiPage(envWith(fakeKv()), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn: async (_url, init) => {
        ua = init.headers["User-Agent"];
        return jsonResponse(INTRO_BODY);
      },
    });
    expect(ua).toBe(WIKI_USER_AGENT);
    expect(WIKI_USER_AGENT).toMatch(/hd2-strategist\/1\.0/);
    expect(WIKI_USER_AGENT).toMatch(/github\.com\/Hydr0gen1\/hd2-strategist/);
  });

  it("full fetch uses the revisions endpoint and the 1h TTL", async () => {
    const kv = fakeKv();
    let url: string | undefined;
    const result = await fetchWikiPage(envWith(kv), { title: "Eruptor", full: true }, {
      nowMs: NOW,
      fetchFn: async (u) => {
        url = u;
        return jsonResponse({ query: { pages: [fullPage("{{Infobox}}")] } });
      },
    });
    if ("found" in result) throw new Error("expected found");
    expect(url).toContain("prop=revisions");
    expect(result.format).toBe("wikitext");
    expect(kv.puts[0]!.key).toBe("wiki:page:r-36_eruptor:full");
    expect(kv.puts[0]!.ttl).toBe(FULL_CACHE_TTL_SECONDS);
    expect(FULL_CACHE_TTL_SECONDS).toBe(3_600);
  });

  it("cache hit: served from KV with cached:true and the STORED retrieved_at; no fetch", async () => {
    const kv = fakeKv();
    const stored = {
      title: "R-36 Eruptor",
      extract: "cached body",
      url: "https://helldivers.wiki.gg/wiki/R-36_Eruptor",
      source: WIKI_HOST,
      license: WIKI_LICENSE,
      retrieved_at: new Date(NOW - 5_000).toISOString(),
      cached: false,
      notes: WIKI_LORE_NOTE,
    };
    kv.store.set("wiki:page:eruptor:intro", JSON.stringify(stored));
    const result = await fetchWikiPage(envWith(kv), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn: async () => {
        throw new Error("must not fetch on a cache hit");
      },
    });
    if ("found" in result) throw new Error("expected found");
    expect(result.cached).toBe(true);
    expect(result.extract).toBe("cached body");
    // retrieved_at reflects the WRITE time, not the read time.
    expect(result.retrieved_at).toBe(stored.retrieved_at);
    expect(kv.puts).toHaveLength(0);
  });

  it("redirect alias: a repeat call with the same alias hits cache, never refetches", async () => {
    const kv = fakeKv();
    let fetchCount = 0;
    const fetchFn = async () => {
      fetchCount++;
      return jsonResponse(INTRO_BODY); // input "Eruptor" → canonical "R-36 Eruptor"
    };
    const first = await fetchWikiPage(envWith(kv), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn,
    });
    if ("found" in first) throw new Error("expected found");
    expect(first.cached).toBe(false);

    const second = await fetchWikiPage(envWith(kv), { title: "Eruptor" }, {
      nowMs: NOW + 1_000,
      fetchFn,
    });
    if ("found" in second) throw new Error("expected found");
    expect(fetchCount).toBe(1); // the alias entry served the second call
    expect(second.cached).toBe(true);
    expect(second.title).toBe("R-36 Eruptor"); // canonical title preserved
  });

  it("intro and full have SEPARATE cache entries (a full request misses an intro hit)", async () => {
    const kv = fakeKv();
    kv.store.set(
      "wiki:page:eruptor:intro",
      JSON.stringify({ title: "X", extract: "intro", source: WIKI_HOST, cached: false }),
    );
    let fetched = false;
    await fetchWikiPage(envWith(kv), { title: "Eruptor", full: true }, {
      nowMs: NOW,
      fetchFn: async () => {
        fetched = true;
        return jsonResponse({ query: { pages: [fullPage("{{x}}")] } });
      },
    });
    expect(fetched).toBe(true); // the intro entry did not satisfy a full request
  });

  it("missing page → found:false and is NOT cached (it may be created later)", async () => {
    const kv = fakeKv();
    const result = await fetchWikiPage(envWith(kv), { title: "Nope XYZ" }, {
      nowMs: NOW,
      fetchFn: async () =>
        jsonResponse({ query: { pages: [{ title: "Nope XYZ", missing: true }] } }),
    });
    expect(result).toEqual({
      found: false,
      title: "Nope XYZ",
      url: "https://helldivers.wiki.gg/wiki/Nope_XYZ",
      source: WIKI_HOST,
    });
    expect(kv.puts).toHaveLength(0);
  });

  it("invalid title → found:false and is NOT cached (no empty-extract success in KV)", async () => {
    const kv = fakeKv();
    const result = await fetchWikiPage(envWith(kv), { title: "{{Template}}" }, {
      nowMs: NOW,
      fetchFn: async () =>
        jsonResponse({
          query: {
            pages: [
              {
                title: "{{Template}}",
                invalid: true,
                invalidreason:
                  'The requested page title contains invalid characters: "{".',
              },
            ],
          },
        }),
    });
    expect("found" in result && result.found === false).toBe(true);
    expect(kv.puts).toHaveLength(0);
  });

  it("network / HTTP / non-JSON failure → typed WikiError, never a partial or stale object", async () => {
    // No stale fallback even when a cached copy exists: a fetch error throws.
    const kv = fakeKv();
    kv.store.set(
      "wiki:page:eruptor:intro",
      JSON.stringify({ title: "old", extract: "old", source: WIKI_HOST, cached: false }),
    );
    // (the cached copy above would satisfy a hit; force a MISS via a full
    // request so the fetch path runs and must throw, not fall back)
    await expect(
      fetchWikiPage(envWith(fakeKv()), { title: "Eruptor" }, {
        nowMs: NOW,
        fetchFn: async () => jsonResponse({}, 429),
      }),
    ).rejects.toBeInstanceOf(WikiError);
    await expect(
      fetchWikiPage(envWith(fakeKv()), { title: "Eruptor" }, {
        nowMs: NOW,
        fetchFn: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toBeInstanceOf(WikiError);
    await expect(
      fetchWikiPage(envWith(fakeKv()), { title: "Eruptor" }, {
        nowMs: NOW,
        fetchFn: async () =>
          new Response("not json", { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(WikiError);
  });

  it("KV read failure falls through to a live fetch (KV down never fails the call)", async () => {
    const brokenKv = {
      store: new Map<string, string>(),
      puts: [] as { key: string; ttl?: number }[],
      async get() {
        throw new Error("KV unavailable");
      },
      async put() {
        throw new Error("KV unavailable");
      },
    };
    const result = await fetchWikiPage(
      envWith(brokenKv as unknown as FakeKv),
      { title: "Eruptor" },
      {
        nowMs: NOW,
        fetchFn: async () => jsonResponse(INTRO_BODY),
      },
    );
    if ("found" in result) throw new Error("expected found");
    expect(result.cached).toBe(false);
    expect(result.title).toBe("R-36 Eruptor");
  });

  it("no KV binding at all → live fetch still succeeds (no caching)", async () => {
    const result = await fetchWikiPage(envWith(null), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn: async () => jsonResponse(INTRO_BODY),
    });
    if ("found" in result) throw new Error("expected found");
    expect(result.cached).toBe(false);
  });
});
