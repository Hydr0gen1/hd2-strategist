/**
 * Stage 4 tests: live event/modifier decode (pure, src/enrichment.ts) and
 * the get_planet_wiki lore source (pure shaping in src/wiki.ts; the I/O
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
  WIKI_EXTRACT_MAX_CHARS,
  WIKI_HOST,
  WIKI_LICENSE,
  planWikiQuery,
  shapeWikiResult,
  titleCaseWords,
} from "../src/wiki";
import {
  WIKI_CACHE_TTL_SECONDS,
  WikiError,
  fetchWikiQuery,
  wikiUserAgent,
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
 * Part 2 — wiki lore source (pure shaping)
 * ====================================================================== */

/** Minimal real-shape MediaWiki page fixture (formatversion=2). */
function wikiPage(overrides: Record<string, unknown> = {}) {
  return {
    pageid: 13914,
    ns: 0,
    title: "Hive Lord",
    extract: "The Hive Lord is a colossal, worm-like Terminid.",
    fullurl: "https://helldivers.wiki.gg/wiki/Hive_Lord",
    canonicalurl: "https://helldivers.wiki.gg/wiki/Hive_Lord",
    ...overrides,
  };
}

const ATTRIBUTION_KEYS = [
  "source",
  "license",
  "license_url",
  "retrieved_at",
  "notes",
  "url",
] as const;

function expectAttribution(result: Record<string, unknown>): void {
  for (const key of ATTRIBUTION_KEYS) expect(result).toHaveProperty(key);
  expect(result.source).toBe(WIKI_HOST);
  expect(result.license).toBe(WIKI_LICENSE);
  expect(result.retrieved_at).toBe(new Date(NOW).toISOString());
  expect(String(result.notes)).toMatch(/authoritative/);
}

describe("planWikiQuery: deterministic title candidates + one request", () => {
  it("title-cases each word for the lookup key only", () => {
    expect(titleCaseWords("GRAND ERRANT")).toBe("Grand Errant");
    expect(titleCaseWords("  aesir   pass ")).toBe("Aesir Pass");
  });

  it("planet name → as-sent and title-cased candidates, deduped, in one URL", () => {
    const plan = planWikiQuery({ name: "GRAND ERRANT" });
    expect(plan.candidates).toEqual(["GRAND ERRANT", "Grand Errant"]);
    const url = new URL(plan.url);
    expect(`${url.origin}${url.pathname}`).toBe(WIKI_API_URL);
    expect(url.searchParams.get("action")).toBe("query");
    expect(url.searchParams.get("prop")).toBe("extracts|info");
    expect(url.searchParams.get("explaintext")).toBe("1");
    expect(url.searchParams.get("exintro")).toBe("1");
    expect(url.searchParams.get("redirects")).toBe("1");
    expect(url.searchParams.get("formatversion")).toBe("2");
    expect(url.searchParams.get("titles")).toBe("GRAND ERRANT|Grand Errant");
  });

  it("already-cased name (RD-4 style would break under naive casing) dedupes to itself plus variant", () => {
    expect(planWikiQuery({ name: "RD-4" }).candidates).toEqual([
      "RD-4",
      "Rd-4",
    ]);
    expect(planWikiQuery({ name: "Hive Lord" }).candidates).toEqual([
      "Hive Lord",
    ]);
  });

  it("explicit title is tried verbatim and alone, and wins over name", () => {
    const plan = planWikiQuery({ name: "GACRUX", title: "Jet Brigade" });
    expect(plan.requested).toBe("Jet Brigade");
    expect(plan.candidates).toEqual(["Jet Brigade"]);
  });

  it("cache key lives in the wiki: namespace, never raw:", () => {
    const plan = planWikiQuery({ name: "Gacrux" });
    expect(plan.cacheKey).toBe("wiki:gacrux");
    expect(plan.cacheKey.startsWith("raw:")).toBe(false);
  });
});

describe("shapeWikiResult: success, attribution mandatory", () => {
  it("returns title/extract/url plus full attribution", () => {
    const result = shapeWikiResult(
      { query: { pages: [wikiPage()] } },
      { requested: "Hive Lord", candidates: ["Hive Lord"] },
      NOW,
    );
    expect(result.found).toBe(true);
    expect(result.title).toBe("Hive Lord");
    expect(result.extract).toBe(
      "The Hive Lord is a colossal, worm-like Terminid.",
    );
    expect(result.url).toBe("https://helldivers.wiki.gg/wiki/Hive_Lord");
    expect(result.truncated).toBe(false);
    expect(result.redirected_from).toBeNull();
    expectAttribution(result as unknown as Record<string, unknown>);
  });

  it("resolves the title-cased candidate when the all-caps one misses (case variant, not substitution)", () => {
    const body = {
      query: {
        pages: [
          { ns: 0, title: "GRAND ERRANT", missing: true },
          wikiPage({
            title: "Grand Errant",
            extract: "Grand Errant is a Scorched Moor Planet.",
            canonicalurl: "https://helldivers.wiki.gg/wiki/Grand_Errant",
          }),
        ],
      },
    };
    const result = shapeWikiResult(
      body,
      { requested: "GRAND ERRANT", candidates: ["GRAND ERRANT", "Grand Errant"] },
      NOW,
    );
    expect(result.found).toBe(true);
    expect(result.title).toBe("Grand Errant");
    expect(result.requested).toBe("GRAND ERRANT");
  });

  it("follows redirects and reports redirected_from — never silently", () => {
    const body = {
      query: {
        redirects: [{ from: "Terminid", to: "Terminids" }],
        pages: [
          wikiPage({
            title: "Terminids",
            extract: "The Terminids are an insectoid species.",
            canonicalurl: "https://helldivers.wiki.gg/wiki/Terminids",
          }),
        ],
      },
    };
    const result = shapeWikiResult(
      body,
      { requested: "Terminid", candidates: ["Terminid"] },
      NOW,
    );
    expect(result.found).toBe(true);
    expect(result.title).toBe("Terminids");
    expect(result.redirected_from).toBe("Terminid");
  });

  it("caps very long extracts at WIKI_EXTRACT_MAX_CHARS with truncated: true", () => {
    const long = "x".repeat(WIKI_EXTRACT_MAX_CHARS * 3);
    const result = shapeWikiResult(
      { query: { pages: [wikiPage({ extract: long })] } },
      { requested: "Hive Lord", candidates: ["Hive Lord"] },
      NOW,
    );
    expect(result.found).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.extract).toHaveLength(WIKI_EXTRACT_MAX_CHARS + 1); // + "…"
    expect(result.extract!.endsWith("…")).toBe(true);
    expect(result.url).not.toBeNull(); // the full page stays reachable
  });
});

describe("shapeWikiResult: not-found and degraded shapes — never a crash", () => {
  it("missing page → found:false with the attempted title, a hint, and attribution", () => {
    const body = {
      query: {
        pages: [
          {
            ns: 0,
            title: "Totally Bogus Page",
            missing: true,
            canonicalurl: "https://helldivers.wiki.gg/wiki/Totally_Bogus_Page",
          },
        ],
      },
    };
    const result = shapeWikiResult(
      body,
      { requested: "Totally Bogus Page", candidates: ["Totally Bogus Page"] },
      NOW,
    );
    expect(result.found).toBe(false);
    expect(result.title).toBe("Totally Bogus Page");
    expect(result.extract).toBeNull();
    expect(result.hint).toMatch(/no alternative page was substituted/i);
    expect(result.url).toBe(
      "https://helldivers.wiki.gg/wiki/Totally_Bogus_Page",
    );
    expectAttribution(result as unknown as Record<string, unknown>);
  });

  it("existing page with an EMPTY extract → found:false with the page URL and a hint", () => {
    const result = shapeWikiResult(
      { query: { pages: [wikiPage({ extract: "   " })] } },
      { requested: "Hive Lord", candidates: ["Hive Lord"] },
      NOW,
    );
    expect(result.found).toBe(false);
    expect(result.extract).toBeNull();
    expect(result.url).toBe("https://helldivers.wiki.gg/wiki/Hive_Lord");
    expect(result.hint).toMatch(/no plain-text intro/i);
    expectAttribution(result as unknown as Record<string, unknown>);
  });

  it("malformed API body → found:false with a hint, never a throw", () => {
    for (const body of [null, {}, { query: {} }, { query: { pages: "x" } }]) {
      const result = shapeWikiResult(
        body,
        { requested: "Hive Lord", candidates: ["Hive Lord"] },
        NOW,
      );
      expect(result.found).toBe(false);
      expectAttribution(result as unknown as Record<string, unknown>);
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

const PLAN = { url: `${WIKI_API_URL}?x=1`, cacheKey: "wiki:hive lord" };
const WIKI_BODY = { query: { pages: [wikiPage()] } };

describe("fetchWikiQuery: cache-first, stale fallback, structured errors", () => {
  it("success: returns the body, caches it under the wiki: namespace with a long TTL", async () => {
    const kv = fakeKv();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const result = await fetchWikiQuery(envWith(kv), PLAN, {
      nowMs: NOW,
      fetchFn: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return jsonResponse(WIKI_BODY);
      },
    });
    expect(result.stale).toBe(false);
    expect(result.body).toEqual(WIKI_BODY);
    expect(calls).toHaveLength(1);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]!.key).toBe("wiki:hive lord");
    // Aggressive retention: days, far beyond the 45s war-state raw cache.
    expect(kv.puts[0]!.ttl).toBe(604_800);
  });

  it("sends a descriptive User-Agent built from the env identity secrets", async () => {
    let ua: string | undefined;
    await fetchWikiQuery(
      envWith(fakeKv(), { SUPER_CLIENT: "my-app", SUPER_CONTACT: "me@x.dev" }),
      PLAN,
      {
        nowMs: NOW,
        fetchFn: async (_url, init) => {
          ua = init.headers["User-Agent"];
          return jsonResponse(WIKI_BODY);
        },
      },
    );
    expect(ua).toBe("my-app (me@x.dev)");
    // And the fallback identifies the app even with no secrets configured.
    expect(wikiUserAgent({})).toMatch(/^hd2-strategist \(.+\)$/);
  });

  it("fresh cache hit: served from KV without touching the wiki", async () => {
    const kv = fakeKv();
    kv.store.set(
      PLAN.cacheKey,
      JSON.stringify({ fetchedAt: NOW - 1_000, body: WIKI_BODY }),
    );
    const result = await fetchWikiQuery(envWith(kv), PLAN, {
      nowMs: NOW,
      fetchFn: async () => {
        throw new Error("must not fetch on a fresh cache hit");
      },
    });
    expect(result).toEqual({ body: WIKI_BODY, stale: false });
  });

  it("wiki down with an expired cached copy → stale: true fallback", async () => {
    const kv = fakeKv();
    kv.store.set(
      PLAN.cacheKey,
      JSON.stringify({
        fetchedAt: NOW - (WIKI_CACHE_TTL_SECONDS + 60) * 1000,
        body: WIKI_BODY,
      }),
    );
    for (const fetchFn of [
      async () => jsonResponse({ error: "x" }, 503),
      async () => {
        throw new Error("network down");
      },
    ]) {
      const result = await fetchWikiQuery(envWith(kv), PLAN, {
        nowMs: NOW,
        fetchFn,
      });
      expect(result).toEqual({ body: WIKI_BODY, stale: true });
    }
  });

  it("wiki down with NO cached copy → typed WikiError (structured MCP error), never a raw crash", async () => {
    await expect(
      fetchWikiQuery(envWith(fakeKv()), PLAN, {
        nowMs: NOW,
        fetchFn: async () => jsonResponse({}, 429),
      }),
    ).rejects.toBeInstanceOf(WikiError);
    await expect(
      fetchWikiQuery(envWith(null), PLAN, {
        nowMs: NOW,
        fetchFn: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toBeInstanceOf(WikiError);
  });

  it("expired cache + healthy wiki → refetches (stale copy is a fallback, not the source)", async () => {
    const kv = fakeKv();
    kv.store.set(
      PLAN.cacheKey,
      JSON.stringify({
        fetchedAt: NOW - (WIKI_CACHE_TTL_SECONDS + 60) * 1000,
        body: { old: true },
      }),
    );
    const result = await fetchWikiQuery(envWith(kv), PLAN, {
      nowMs: NOW,
      fetchFn: async () => jsonResponse(WIKI_BODY),
    });
    expect(result).toEqual({ body: WIKI_BODY, stale: false });
  });
});
