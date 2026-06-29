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
  cleanInfoboxValue,
  extractWikitextContent,
  parseInfobox,
  wikiWikitextCacheKey,
} from "../src/wiki";
import {
  FULL_CACHE_TTL_SECONDS,
  INTRO_CACHE_TTL_SECONDS,
  WIKITEXT_CACHE_TTL_SECONDS,
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
  get(key: string, type?: "json" | "text"): Promise<unknown>;
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
    // Mirrors KV's typed get: "text" returns the raw string, "json" parses.
    async get(key: string, type: "json" | "text" = "json") {
      const raw = this.store.get(key);
      if (raw == null) return null;
      return type === "text" ? raw : JSON.parse(raw);
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

/* Real-shape wikitext fixtures from the spec's concrete examples. */
const ERUPTOR_WIKITEXT = `{{Infobox_Weapon
| title = R-36 Eruptor
| damage = {{Damage|Ballistic|230 Projectile|notext}}<br> {{Damage|Explosion|225}}
| penetration = {{Armor|4|AP}} (Projectile)<br> {{Armor|3|AP}} (Explosion)
| capacity = 5
| recoil = 75
| fire_rate = 32 rpm
| dps = 853.12
| weapon_traits = Explosive {{*}} Heavy Armor Penetrating
| source = [[Democratic Detonation Premium Warbond#Page 2|Democratic Detonation]] <small>{{Tooltip|P2|Page 2}}</small>
| cost = {{Currency|Medals|60}}
| spare_mags = 6
| firing_modes = Bolt-Action
| scope_options = 50m {{*}} 100m {{*}} 200m
| weapon_category = Primary Weapons
| weapon_type = Explosives
| supply_box_refill = 6
| ammo_box_refill = 3
| image = R-36 Eruptor.png
}}

The '''R-36 Eruptor''' is a primary weapon.`;

const ERUPTOR_FIELDS: Record<string, string> = {
  title: "R-36 Eruptor",
  damage: "230 / 225",
  penetration: "AP4 (Projectile) / AP3 (Explosion)",
  capacity: "5",
  recoil: "75",
  fire_rate: "32 rpm",
  dps: "853.12",
  weapon_traits: "Explosive, Heavy Armor Penetrating",
  source: "Democratic Detonation",
  cost: "60 Medals",
  spare_mags: "6",
  firing_modes: "Bolt-Action",
  scope_options: "50m, 100m, 200m",
  weapon_category: "Primary Weapons",
  weapon_type: "Explosives",
  supply_box_refill: "6",
  ammo_box_refill: "3",
};

const WARBOND_WIKITEXT = `{{Infobox Warbond
|title=Democratic Detonation
|date=April 11th, 2024
|cost={{Currency|SC|1,000}}
|credit-claim={{Currency|SC|300}}
|all-pages={{Currency|Medals|230}}
|all-items={{Currency|Medals|699}}
|image=Democratic Detonation.png
}}`;

const WARBOND_FIELDS: Record<string, string> = {
  title: "Democratic Detonation",
  date: "April 11th, 2024",
  cost: "1,000 SC",
  "credit-claim": "300 SC",
  "all-pages": "230 Medals",
  "all-items": "699 Medals",
};

describe("fetchWikiPage: cache-first, canonical-key writes, structured errors", () => {
  it("live intro fetch: caches under the CANONICAL-title intro key with a 24h TTL", async () => {
    const kv = fakeKv();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const result = await fetchWikiPage(envWith(kv), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn: async (url, init) => {
        calls.push({ url, headers: init.headers });
        // A default request now also pulls the wikitext (for the infobox).
        return url.includes("prop=revisions")
          ? jsonResponse({ query: { pages: [fullPage(ERUPTOR_WIKITEXT)] } })
          : jsonResponse(INTRO_BODY);
      },
    });
    if ("found" in result) throw new Error("expected found");
    expect(result.cached).toBe(false);
    expect(result.title).toBe("R-36 Eruptor");
    // Two fetches now: the extracts intro AND the revisions wikitext (infobox).
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("prop=extracts");
    expect(calls[1]!.url).toContain("prop=revisions");
    // The input "Eruptor" redirects to the canonical "R-36 Eruptor", so the
    // page is cached under the canonical key AND the input alias key (so a
    // repeat alias call hits cache instead of refetching).
    const introPuts = kv.puts.filter((p) => p.key.endsWith(":intro"));
    expect(introPuts.map((p) => p.key)).toEqual(
      expect.arrayContaining([
        "wiki:page:r-36_eruptor:intro",
        "wiki:page:eruptor:intro",
      ]),
    );
    expect(introPuts.every((p) => p.ttl === INTRO_CACHE_TTL_SECONDS)).toBe(true);
    expect(INTRO_CACHE_TTL_SECONDS).toBe(86_400);
    // The raw wikitext is cached separately under the :wikitext key (1h TTL),
    // NOT baked into the intro entry.
    const wikitextPuts = kv.puts.filter((p) => p.key.endsWith(":wikitext"));
    expect(wikitextPuts.map((p) => p.key)).toEqual(
      expect.arrayContaining([
        "wiki:page:r-36_eruptor:wikitext",
        "wiki:page:eruptor:wikitext",
      ]),
    );
    expect(wikitextPuts.every((p) => p.ttl === WIKITEXT_CACHE_TTL_SECONDS)).toBe(
      true,
    );
    expect(WIKITEXT_CACHE_TTL_SECONDS).toBe(3_600);
    // The intro cache entry stays infobox-free (the field is assembled per call
    // from the wikitext cache).
    expect(JSON.parse(kv.store.get("wiki:page:r-36_eruptor:intro")!)).not.toHaveProperty(
      "infobox",
    );
    // The served response carries the parsed weapon infobox.
    expect(result.infobox).toEqual({ type: "weapon", fields: ERUPTOR_FIELDS });
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
    // Pre-seed the wikitext cache too, so the infobox is assembled with NO
    // network at all (the intro and its infobox both come from KV).
    kv.store.set("wiki:page:eruptor:wikitext", ERUPTOR_WIKITEXT);
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
    // Infobox assembled from the cached wikitext, no fetch, no write.
    expect(result.infobox).toEqual({ type: "weapon", fields: ERUPTOR_FIELDS });
    expect(kv.puts).toHaveLength(0);
  });

  it("redirect alias: a repeat call with the same alias hits cache, never refetches", async () => {
    const kv = fakeKv();
    let introFetches = 0;
    let wikitextFetches = 0;
    const fetchFn = async (url: string) => {
      if (url.includes("prop=revisions")) {
        wikitextFetches++;
        return jsonResponse({ query: { pages: [fullPage(ERUPTOR_WIKITEXT)] } });
      }
      introFetches++;
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
    // Both the intro alias AND the wikitext alias entry serve the second call.
    expect(introFetches).toBe(1);
    expect(wikitextFetches).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.title).toBe("R-36 Eruptor"); // canonical title preserved
    // The infobox is reassembled from the cached wikitext, identical both times.
    expect(second.infobox).toEqual({ type: "weapon", fields: ERUPTOR_FIELDS });
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
      // Route: extracts → intro, revisions → wikitext.
      fetchFn: async (url) =>
        url.includes("prop=revisions")
          ? jsonResponse({ query: { pages: [fullPage(ERUPTOR_WIKITEXT)] } })
          : jsonResponse(INTRO_BODY),
    });
    if ("found" in result) throw new Error("expected found");
    expect(result.cached).toBe(false);
    // Infobox still parsed (from the live wikitext fetch), just not cached.
    expect(result.infobox).toEqual({ type: "weapon", fields: ERUPTOR_FIELDS });
  });
});

/* ====================================================================== *
 * Part 3 — infobox parsing (pure) + its I/O wiring
 * ====================================================================== */

describe("wikiWikitextCacheKey + extractWikitextContent (pure)", () => {
  it("wikitext key lives in the wiki: namespace with a :wikitext suffix", () => {
    expect(wikiWikitextCacheKey("R-36 Eruptor")).toBe(
      "wiki:page:r-36_eruptor:wikitext",
    );
    expect(wikiWikitextCacheKey("ERUPTOR")).toBe("wiki:page:eruptor:wikitext");
  });

  it("extractWikitextContent pulls the revisions slot content, '' when absent", () => {
    expect(
      extractWikitextContent({ query: { pages: [fullPage("{{Infobox}}")] } }),
    ).toBe("{{Infobox}}");
    expect(extractWikitextContent({ query: { pages: [] } })).toBe("");
    expect(extractWikitextContent({ query: { pages: [{ revisions: [] }] } })).toBe(
      "",
    );
    expect(extractWikitextContent(null)).toBe("");
    expect(extractWikitextContent({})).toBe("");
  });
});

describe("parseInfobox: the concrete spec examples (must be exact)", () => {
  it("R-36 Eruptor weapon infobox → every documented field value", () => {
    const result = parseInfobox(ERUPTOR_WIKITEXT);
    expect(result.type).toBe("weapon");
    expect(result.fields).toEqual(ERUPTOR_FIELDS);
    // image/caption-image filenames are skipped, never surfaced.
    expect(result.fields).not.toHaveProperty("image");
  });

  it("Democratic Detonation warbond infobox → every documented field value", () => {
    const result = parseInfobox(WARBOND_WIKITEXT);
    expect(result.type).toBe("warbond");
    expect(result.fields).toEqual(WARBOND_FIELDS);
    // The hyphenated key keeps its hyphen (never normalized to underscore).
    expect(result.fields["credit-claim"]).toBe("300 SC");
  });
});

describe("parseInfobox: type detection", () => {
  it("recognizes the four families, underscore or space, case-insensitive", () => {
    expect(parseInfobox("{{Infobox_Weapon\n|a=1\n}}").type).toBe("weapon");
    expect(parseInfobox("{{Infobox Weapon\n|a=1\n}}").type).toBe("weapon");
    expect(parseInfobox("{{infobox armor\n|a=1\n}}").type).toBe("armor");
    expect(parseInfobox("{{Infobox Stratagem\n|a=1\n}}").type).toBe("stratagem");
    expect(parseInfobox("{{Infobox Warbond\n|a=1\n}}").type).toBe("warbond");
  });

  it("unrecognized infobox or no infobox → { type: null, fields: {} }", () => {
    expect(parseInfobox("{{Infobox Planet\n|a=1\n}}")).toEqual({
      type: null,
      fields: {},
    });
    expect(parseInfobox("Just prose, no template.")).toEqual({
      type: null,
      fields: {},
    });
    expect(parseInfobox("")).toEqual({ type: null, fields: {} });
  });
});

describe("parseInfobox: edge cases", () => {
  it("brace-depth boundary: closing }} shares a line with nested templates", () => {
    const wt =
      "{{Infobox_Weapon|title=X|cost={{Currency|Medals|60}}}}\nbody {{Other}}";
    const result = parseInfobox(wt);
    expect(result.type).toBe("weapon");
    // The block ends at the matched depth-0 }}, not the first }} (inside Currency).
    expect(result.fields).toEqual({ title: "X", cost: "60 Medals" });
  });

  it("only the FIRST infobox is used", () => {
    const wt =
      "{{Infobox_Weapon\n|title=First\n}}\n{{Infobox Warbond\n|title=Second\n}}";
    const result = parseInfobox(wt);
    expect(result.type).toBe("weapon");
    expect(result.fields).toEqual({ title: "First" });
  });

  it("recognized type with no usable fields → fields {} (never a throw)", () => {
    expect(parseInfobox("{{Infobox_Weapon\n|image=foo.png\n}}")).toEqual({
      type: "weapon",
      fields: {},
    });
  });

  it("unmatched {{ in a value → stripped to next }} or end, never throws", () => {
    expect(() => parseInfobox("{{Infobox_Weapon\n|a={{Broken\n}}")).not.toThrow();
    const result = parseInfobox("{{Infobox_Weapon\n|title=X\n|a={{Broken\n}}");
    // The dangling {{Broken cleans to empty and is dropped; title survives.
    expect(result.fields).toEqual({ title: "X" });
  });

  it("empty wikitext → { type: null, fields: {} }", () => {
    expect(parseInfobox("")).toEqual({ type: null, fields: {} });
  });
});

describe("cleanInfoboxValue: each transform rule", () => {
  it("Damage → second segment first token; <br> joins with ' / '", () => {
    expect(
      cleanInfoboxValue(
        "{{Damage|Ballistic|230 Projectile|notext}}<br> {{Damage|Explosion|225}}",
      ),
    ).toBe("230 / 225");
  });

  it("Armor → type+number; Currency → amount + kind", () => {
    expect(cleanInfoboxValue("{{Armor|4|AP}}")).toBe("AP4");
    expect(cleanInfoboxValue("{{Currency|Medals|60}}")).toBe("60 Medals");
    expect(cleanInfoboxValue("{{Currency|SC|1,000}}")).toBe("1,000 SC");
  });

  it("{{*}} → ', ' list separator with surrounding whitespace absorbed", () => {
    expect(cleanInfoboxValue("Explosive {{*}} Heavy Armor Penetrating")).toBe(
      "Explosive, Heavy Armor Penetrating",
    );
    expect(cleanInfoboxValue("50m {{*}} 100m {{*}} 200m")).toBe(
      "50m, 100m, 200m",
    );
  });

  it("[[Link|Display]] keeps display; [[Link]] keeps target", () => {
    expect(cleanInfoboxValue("[[Foo Bar#Sec|Foo Bar]]")).toBe("Foo Bar");
    expect(cleanInfoboxValue("[[Plain Link]]")).toBe("Plain Link");
  });

  it("strips <small> wrapper, italic markup, and unmatched templates", () => {
    expect(cleanInfoboxValue("[[A|B]] <small>{{Tooltip|P2|Page 2}}</small>")).toBe(
      "B",
    );
    expect(cleanInfoboxValue("''italic'' and '''bold'''")).toBe("italic and bold");
    expect(cleanInfoboxValue("{{UnknownTemplate|x|y}}")).toBe("");
  });
});

describe("fetchWikiPage infobox wiring (injected fetch + KV stub)", () => {
  it("full: true is UNCHANGED — no infobox, no wikitext fetch", async () => {
    const kv = fakeKv();
    let revisionsForInfobox = 0;
    const result = await fetchWikiPage(
      envWith(kv),
      { title: "Eruptor", full: true },
      {
        nowMs: NOW,
        fetchFn: async (url) => {
          if (url.includes("prop=revisions")) revisionsForInfobox++;
          return jsonResponse({ query: { pages: [fullPage(ERUPTOR_WIKITEXT)] } });
        },
      },
    );
    if ("found" in result) throw new Error("expected found");
    expect(result.format).toBe("wikitext");
    expect(result).not.toHaveProperty("infobox");
    // Exactly ONE revisions fetch — the full request itself; none for infobox.
    expect(revisionsForInfobox).toBe(1);
    // No wikitext cache entry written on a full request.
    expect(kv.puts.some((p) => p.key.endsWith(":wikitext"))).toBe(false);
  });

  it("default: warbond page surfaces a warbond infobox + caches wikitext", async () => {
    const kv = fakeKv();
    const result = await fetchWikiPage(
      envWith(kv),
      { title: "Democratic Detonation" },
      {
        nowMs: NOW,
        fetchFn: async (url) =>
          url.includes("prop=revisions")
            ? jsonResponse({
                query: {
                  pages: [
                    fullPage(WARBOND_WIKITEXT, { title: "Democratic Detonation" }),
                  ],
                },
              })
            : jsonResponse({
                query: {
                  pages: [
                    introPage({ title: "Democratic Detonation", extract: "A warbond." }),
                  ],
                },
              }),
      },
    );
    if ("found" in result) throw new Error("expected found");
    expect(result.infobox).toEqual({ type: "warbond", fields: WARBOND_FIELDS });
    expect(kv.store.get("wiki:page:democratic_detonation:wikitext")).toBe(
      WARBOND_WIKITEXT,
    );
  });

  it("wikitext fetch failure → empty infobox, the intro response still succeeds", async () => {
    const kv = fakeKv();
    const result = await fetchWikiPage(envWith(kv), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn: async (url) => {
        if (url.includes("prop=revisions")) throw new Error("wikitext down");
        return jsonResponse(INTRO_BODY);
      },
    });
    if ("found" in result) throw new Error("expected found");
    expect(result.title).toBe("R-36 Eruptor");
    expect(result.infobox).toEqual({ type: null, fields: {} });
    // The intro page is still cached; no wikitext entry (nothing to cache).
    expect(kv.store.has("wiki:page:r-36_eruptor:intro")).toBe(true);
    expect(kv.store.has("wiki:page:r-36_eruptor:wikitext")).toBe(false);
  });

  it("wikitext HTTP error → empty infobox, never throws", async () => {
    const result = await fetchWikiPage(envWith(fakeKv()), { title: "Eruptor" }, {
      nowMs: NOW,
      fetchFn: async (url) =>
        url.includes("prop=revisions")
          ? jsonResponse({}, 500)
          : jsonResponse(INTRO_BODY),
    });
    if ("found" in result) throw new Error("expected found");
    expect(result.infobox).toEqual({ type: null, fields: {} });
  });
});
