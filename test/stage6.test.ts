/**
 * Stage 6 tests: consumption ergonomics — the get_war_brief digest (pure
 * assembly, never a conclusion), get_campaigns filtering, planet name
 * resolution, freshness metadata (as_of / fetched_at / cache_age_seconds),
 * and the Part F unit-consistency aliases. Pure throughout, except the
 * sanctioned in-memory-KV test of getWarBrief's fetch budget (the KV raw
 * cache is pre-seeded fresh, so the network must never be touched — a
 * throwing fetch stub proves it).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  buildActiveEvents,
  buildMajorOrderTargets,
  defenseTiming,
  filterCampaigns,
  freshnessFrom,
  humanizeSeconds,
  levenshtein,
  resolvePlanetName,
  RESOLVE_MAX_CANDIDATES,
  shapeMajorOrders,
} from "../src/enrichment";
import { getCampaigns, getWarBrief, resolvePlanetTool } from "../src/tools";
import type {
  EnrichedCampaign,
  Env,
  RawAssignment,
  RawCampaign,
  RawPlanet,
  RawWar,
} from "../src/types";

const NOW = 1_750_000_000_000;

/* ------------------------------ fixtures ------------------------------ */

function makeRawPlanet(over: Partial<RawPlanet> = {}): RawPlanet {
  return {
    index: 175,
    name: "GRAND ERRANT",
    sector: "SECTOR",
    maxHealth: 1_000_000,
    health: 600_000,
    disabled: false,
    initialOwner: "Humans",
    currentOwner: "Terminids",
    regenPerSecond: 1.5,
    event: null,
    attacking: [],
    waypoints: [],
    statistics: null,
    biome: null,
    hazards: null,
    ...over,
  };
}

function makeEnriched(over: Partial<EnrichedCampaign> = {}): EnrichedCampaign {
  return {
    campaign_id: 1,
    planet_name: "GRAND ERRANT",
    planet_index: 175,
    faction: "Terminids",
    campaign_type: 0,
    campaign_kind: "liberation",
    raw_hp: 600_000,
    max_hp: 1_000_000,
    hp_per_hour: 10_000,
    regen_per_second: 1.5,
    liberation_pct_display_only: 40,
    direction: "liberating",
    alert: null,
    stabilizing: false,
    hpc: false,
    hours_to_resolution: 60,
    status: "projected",
    decay_per_hour: 5_400,
    statistics: {
      player_count: 12_000,
      mission_wins: 10,
      mission_losses: 2,
      mission_success_rate: 83.33,
      kills: { terminid: 1, automaton: null, illuminate: null },
    },
    biome: null,
    hazards: [],
    event_type: null,
    modifier: null,
    is_major_order_target: false,
    major_order_id: null,
    ...over,
  };
}

const PLANET_NAMES = [
  { index: 0, name: "SUPER EARTH" },
  { index: 64, name: "MERIDIA" },
  { index: 125, name: "GACRUX" },
  { index: 126, name: "GAR HAREN" },
  { index: 130, name: "MORT" },
  { index: 131, name: "MORT EPSILON" },
  { index: 199, name: "X-45" },
];

/* ------------------------- Part C: resolution ------------------------- */

describe("resolvePlanetName", () => {
  it("exact case-insensitive match → matched, no fuzzy noise", () => {
    const r = resolvePlanetName("gacrux", PLANET_NAMES);
    expect(r.matched).toBe(true);
    expect(r.planet).toEqual({ index: 125, name: "GACRUX" });
    expect(r.candidates).toEqual([]);
  });

  it("punctuation/space-normalized match → matched (same name, not a substitution)", () => {
    const r = resolvePlanetName("x45", PLANET_NAMES);
    expect(r.matched).toBe(true);
    expect(r.planet).toEqual({ index: 199, name: "X-45" });
  });

  it("returns canonical upstream casing, never re-cased", () => {
    const r = resolvePlanetName("mort epsilon", PLANET_NAMES);
    expect(r.planet!.name).toBe("MORT EPSILON");
  });

  it("fuzzy near-miss → matched: false with ranked candidates, never auto-substituted", () => {
    const r = resolvePlanetName("gacrix", PLANET_NAMES);
    expect(r.matched).toBe(false);
    expect(r.planet).toBeUndefined();
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]).toMatchObject({ index: 125, name: "GACRUX", score: 1 });
    // Ranked ascending by score (lower = closer).
    const scores = r.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  it("prefix queries surface candidates (mort → MORT exact wins; mor → both Morts)", () => {
    const r = resolvePlanetName("mort e", PLANET_NAMES);
    expect(r.matched).toBe(false);
    expect(r.candidates.map((c) => c.name)).toContain("MORT EPSILON");
  });

  it("ambiguous equally-good matches → matched: false, all returned ranked", () => {
    const dupes = [
      { index: 1, name: "T W I N" },
      { index: 2, name: "T.W.I.N" },
    ];
    const r = resolvePlanetName("twin", dupes);
    expect(r.matched).toBe(false);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.every((c) => c.score === 0)).toBe(true);
  });

  it("no match at all → matched: false, empty candidates, with a hint", () => {
    const r = resolvePlanetName("zzzzzzzzzzzz", PLANET_NAMES);
    expect(r.matched).toBe(false);
    expect(r.candidates).toEqual([]);
    expect(r.hint).toBeTruthy();
  });

  it("empty query → matched: false with hint, no throw", () => {
    const r = resolvePlanetName("   ", PLANET_NAMES);
    expect(r.matched).toBe(false);
    expect(r.candidates).toEqual([]);
  });

  it("candidate list is capped", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      index: i,
      name: `AAA${i}`,
    }));
    const r = resolvePlanetName("aaa", many);
    expect(r.candidates.length).toBeLessThanOrEqual(RESOLVE_MAX_CANDIDATES);
  });
});

describe("levenshtein", () => {
  it("computes plain edit distance", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("abc", "abd")).toBe(1);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

/* ------------------------- Part B: filtering -------------------------- */

describe("filterCampaigns", () => {
  const campaigns = [
    makeEnriched({ campaign_id: 1, faction: "Terminids", hp_per_hour: 100 }),
    makeEnriched({
      campaign_id: 2,
      faction: "Automaton",
      hp_per_hour: null,
      is_major_order_target: true,
      hpc: true,
    }),
    makeEnriched({
      campaign_id: 3,
      faction: "Automaton",
      hp_per_hour: -50,
      hpc: true,
    }),
    makeEnriched({ campaign_id: 4, faction: "Illuminate", hp_per_hour: 0 }),
  ];

  it("no args → the full list, untouched objects (backward-compatible)", () => {
    const out = filterCampaigns(campaigns, {});
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(campaigns[0]); // same references — narrowing only
  });

  it("faction filter, case-insensitive on input only", () => {
    expect(filterCampaigns(campaigns, { faction: "automaton" })).toHaveLength(2);
    expect(filterCampaigns(campaigns, { faction: "Terminids" })).toHaveLength(1);
  });

  it("major_order_only / has_rate / hpc_only each narrow correctly", () => {
    expect(
      filterCampaigns(campaigns, { major_order_only: true }).map(
        (c) => c.campaign_id,
      ),
    ).toEqual([2]);
    // has_rate: non-null rate — a 0 rate is a known rate, only null is excluded.
    expect(
      filterCampaigns(campaigns, { has_rate: true }).map((c) => c.campaign_id),
    ).toEqual([1, 3, 4]);
    expect(
      filterCampaigns(campaigns, { hpc_only: true }).map((c) => c.campaign_id),
    ).toEqual([2, 3]);
  });

  it("filters AND-combine", () => {
    expect(
      filterCampaigns(campaigns, {
        faction: "Automaton",
        hpc_only: true,
        has_rate: true,
      }).map((c) => c.campaign_id),
    ).toEqual([3]);
  });

  it("explicit false flags filter nothing (same as unset)", () => {
    expect(
      filterCampaigns(campaigns, {
        major_order_only: false,
        has_rate: false,
        hpc_only: false,
      }),
    ).toHaveLength(4);
  });
});

/* ----------------------- Parts D+E: freshness ------------------------- */

describe("freshnessFrom", () => {
  it("single endpoint: as_of/fetched_at from the cache record, age in seconds", () => {
    const f = freshnessFrom([NOW - 30_000], NOW);
    expect(f.as_of).toBe(new Date(NOW - 30_000).toISOString());
    expect(f.fetched_at).toBe(f.as_of);
    expect(f.cache_age_seconds).toBe(30);
  });

  it("several contributing endpoints: the OLDEST governs (conservative)", () => {
    const f = freshnessFrom([NOW - 5_000, NOW - 44_000, NOW - 1_000], NOW);
    expect(f.fetched_at).toBe(new Date(NOW - 44_000).toISOString());
    expect(f.cache_age_seconds).toBe(44);
  });

  it("empty/garbled input → nulls, never fabricated", () => {
    expect(freshnessFrom([], NOW)).toEqual({
      as_of: null,
      fetched_at: null,
      cache_age_seconds: null,
    });
    expect(freshnessFrom([Number.NaN], NOW).as_of).toBeNull();
  });

  it("age is clamped at 0 (clock skew never yields a negative age)", () => {
    expect(freshnessFrom([NOW + 5_000], NOW).cache_age_seconds).toBe(0);
  });
});

/* ----------------------- Part F: unit aliases ------------------------- */

describe("defenseTiming Part F aliases", () => {
  const event = {
    id: 1,
    eventType: 1,
    faction: "Automaton",
    health: 100,
    maxHealth: 200,
    startTime: new Date(NOW - 3_600_000).toISOString(),
    endTime: new Date(NOW + 5_400_000).toISOString(), // +1.5h
    campaignId: 7,
  };

  it("seconds and humanized aliases agree with the existing hours field", () => {
    const t = defenseTiming(event, NOW);
    expect(t.defense_hours_remaining).toBeCloseTo(1.5, 10);
    expect(t.defense_seconds_remaining).toBe(5_400);
    expect(t.defense_time_remaining).toBe("1h 30m");
    expect(t.defense_expired).toBe(false);
  });

  it("expired → 0s / '0m', hours field unchanged in meaning", () => {
    const t = defenseTiming(
      { ...event, endTime: new Date(NOW - 1_000).toISOString() },
      NOW,
    );
    expect(t.defense_hours_remaining).toBe(0);
    expect(t.defense_seconds_remaining).toBe(0);
    expect(t.defense_time_remaining).toBe("0m");
    expect(t.defense_expired).toBe(true);
  });

  it("missing endTime → all three renderings null, never computed", () => {
    const t = defenseTiming(
      { ...event, endTime: undefined as unknown as string },
      NOW,
    );
    expect(t.defense_hours_remaining).toBeNull();
    expect(t.defense_seconds_remaining).toBeNull();
    expect(t.defense_time_remaining).toBeNull();
  });
});

describe("humanizeSeconds", () => {
  it("renders d/h/m with minutes always present", () => {
    expect(humanizeSeconds(0)).toBe("0m");
    expect(humanizeSeconds(59)).toBe("0m");
    expect(humanizeSeconds(3_660)).toBe("1h 1m");
    expect(humanizeSeconds(90_061)).toBe("1d 1h 1m");
    expect(humanizeSeconds(-5)).toBe("0m");
  });
});

/* ---------------------- Part A: brief assembly ------------------------ */

function makeAssignment(over: Partial<RawAssignment> = {}): RawAssignment {
  return {
    id: 9001,
    progress: [0],
    title: "LIBERATE",
    briefing: "Brief",
    description: "Desc",
    tasks: [{ type: 11, values: [175, 126], valueTypes: [12, 12] }],
    reward: { type: 1, amount: 45 },
    rewards: [],
    expiration: new Date(NOW + 86_400_000).toISOString(),
    flags: 0,
    ...over,
  };
}

describe("shapeMajorOrders", () => {
  it("keeps the exact get_major_order field set incl. the seconds + humanized pair", () => {
    const [order] = shapeMajorOrders([makeAssignment()], NOW);
    expect(order).toMatchObject({
      id: 9001,
      title: "LIBERATE",
      expires_in_seconds: 86_400,
      expires_in: "1d 0m",
    });
    expect(order!.objectives[0]!.planet_indices).toEqual([175, 126]);
  });

  it("clamps past expiration at zero", () => {
    const [order] = shapeMajorOrders(
      [makeAssignment({ expiration: new Date(NOW - 1).toISOString() })],
      NOW,
    );
    expect(order!.expires_in_seconds).toBe(0);
  });
});

describe("buildMajorOrderTargets", () => {
  const campaigns = [makeEnriched({ planet_index: 175 })];
  const planetByIndex = new Map<number, RawPlanet>([
    [175, makeRawPlanet()],
    [126, makeRawPlanet({ index: 126, name: "GAR HAREN", health: 1_000_000 })],
  ]);

  it("joins MO planets to their live campaign trajectory", () => {
    const targets = buildMajorOrderTargets([175, 126], campaigns, planetByIndex);
    expect(targets[0]).toMatchObject({
      index: 175,
      name: "GRAND ERRANT",
      has_active_campaign: true,
      raw_hp: 600_000,
      hp_per_hour: 10_000,
      direction: "liberating",
      hpc: false,
      decay_per_hour: 5_400,
      player_count: 12_000,
    });
  });

  it("a target with no active campaign is included with static state, not dropped", () => {
    const targets = buildMajorOrderTargets([175, 126], campaigns, planetByIndex);
    expect(targets).toHaveLength(2);
    expect(targets[1]).toMatchObject({
      index: 126,
      name: "GAR HAREN",
      has_active_campaign: false,
      raw_hp: 1_000_000,
      hp_per_hour: null,
      direction: "unknown",
      stabilizing: null,
      hpc: null,
      decay_per_hour: null,
    });
  });

  it("a dangling MO index (unknown planet) keeps nulls, never fabricated", () => {
    const [t] = buildMajorOrderTargets([999], campaigns, planetByIndex);
    expect(t).toMatchObject({
      index: 999,
      name: null,
      has_active_campaign: false,
      raw_hp: null,
    });
  });
});

describe("buildActiveEvents", () => {
  it("empty array when no campaign has an event (current reality)", () => {
    expect(buildActiveEvents([makeEnriched()])).toEqual([]);
  });

  it("surfaces event identity facts only", () => {
    const out = buildActiveEvents([
      makeEnriched({
        campaign_kind: "defense",
        event_type: 1,
        modifier: null,
        defense_ends_at: "2026-06-11T00:00:00Z",
        defense_hours_remaining: 12,
      }),
    ]);
    expect(out).toEqual([
      {
        planet_index: 175,
        planet_name: "GRAND ERRANT",
        faction: "Terminids",
        campaign_kind: "defense",
        event_type: 1,
        modifier: null,
        defense_ends_at: "2026-06-11T00:00:00Z",
        defense_hours_remaining: 12,
      },
    ]);
  });
});

/* ----------- Brief + filtered campaigns end-to-end (KV stub) ----------- *
 * Sanctioned exception (see test/CLAUDE.md): the raw KV cache is pre-seeded
 * FRESH for every endpoint, so the handlers must serve entirely from cache —
 * the throwing fetch stub proves get_war_brief adds zero upstream fetch
 * volume beyond what the shared cache already holds, and the puts log
 * proves the single sample-store write budget is unchanged.
 * ---------------------------------------------------------------------- */

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

function seedRaw(kv: FakeKv, path: string, body: unknown): void {
  kv.store.set(
    `raw:${path}`,
    JSON.stringify({ fetchedAt: Date.now() - 1_000, body }),
  );
}

function makeRawCampaign(over: Partial<RawCampaign> = {}): RawCampaign {
  return {
    id: 42,
    planet: makeRawPlanet(),
    type: 0,
    count: 1,
    faction: "Terminids",
    ...over,
  };
}

const WAR: RawWar = {
  started: "2024-01-23T20:05:13Z",
  ended: "2028-02-08T20:04:55Z",
  now: "1972-04-26T00:00:00Z",
  clientVersion: "0.3.0",
  factions: ["Humans", "Terminids", "Automaton", "Illuminate"],
  impactMultiplier: 0.024,
  statistics: {
    missionsWon: 1,
    missionsLost: 1,
    missionSuccessRate: 50,
    terminidKills: 1,
    automatonKills: 1,
    illuminateKills: 1,
    deaths: 1,
    playerCount: 55_000,
    accuracy: 60,
  },
};

function seededEnv(kv: FakeKv, assignments: RawAssignment[]): Env {
  seedRaw(kv, "/api/v1/planets", [
    makeRawPlanet(),
    makeRawPlanet({ index: 126, name: "GAR HAREN", currentOwner: "Automaton" }),
  ]);
  seedRaw(kv, "/api/v1/campaigns", [makeRawCampaign()]);
  seedRaw(kv, "/api/v1/assignments", assignments);
  seedRaw(kv, "/api/v1/war", WAR);
  return { WAR_CACHE: kv as unknown as KVNamespace };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidNetwork(): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (() => {
    counter.calls += 1;
    throw new Error("network touched — the shared cache should have served this");
  }) as unknown as typeof fetch;
  return counter;
}

describe("getWarBrief (cache-served, zero extra upstream volume)", () => {
  it("assembles MO + targets + fronts + events + totals from the shared cache, one KV write", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv, [makeAssignment()]);
    const fetches = forbidNetwork();

    const brief = (await getWarBrief(env)) as Record<string, unknown>;

    expect(fetches.calls).toBe(0);
    // Same single per-cycle write as a get_war_status poll — never a second.
    expect(kv.puts.map((p) => p.key)).toEqual(["samples:planets"]);

    expect(brief.major_order).toMatchObject({ id: 9001, title: "LIBERATE" });
    const targets = brief.major_order_targets as Array<Record<string, unknown>>;
    expect(targets.map((t) => t.index)).toEqual([175, 126]);
    expect(targets[0]!.has_active_campaign).toBe(true);
    expect(targets[1]!.has_active_campaign).toBe(false); // included, not dropped
    expect(brief.active_events).toEqual([]);
    expect(brief.totals).toEqual({
      player_count: 55_000,
      active_campaigns: 1,
      planets_in_play: 1,
    });
    const fronts = brief.fronts as Record<string, Record<string, unknown>>;
    expect(fronts.Terminids).toMatchObject({ active_campaigns: 1 });
    // Parts D+E metadata present.
    expect(typeof brief.as_of).toBe("string");
    expect(typeof brief.fetched_at).toBe("string");
    expect(typeof brief.cache_age_seconds).toBe("number");
    // Prime directive: pure assembly — no interpretive FIELD anywhere
    // (key names checked recursively; prose notes may mention the words to
    // disclaim them).
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(brief);
    for (const key of keys) {
      expect(key).not.toMatch(/recommend|priority|rank|score|verdict|threat/i);
    }
  });

  it("no active MO → major_order null, targets empty, rest still populated", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv, []);
    forbidNetwork();

    const brief = (await getWarBrief(env)) as Record<string, unknown>;
    expect(brief.major_order).toBeNull();
    expect(brief.major_order_targets).toEqual([]);
    expect(brief.totals).toMatchObject({ active_campaigns: 1 });
    expect(brief.fronts).toBeTruthy();
  });
});

describe("getCampaigns filtering end-to-end (cache-served)", () => {
  it("no args → all campaigns with matching counts (backward-compatible)", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv, [makeAssignment()]);
    forbidNetwork();
    const out = (await getCampaigns(env)) as Record<string, unknown>;
    expect(out.count).toBe(1);
    expect(out.total_count).toBe(1);
    expect(out.filtered_count).toBe(1);
    expect(out.filters_applied).toBeUndefined();
  });

  it("filters narrow and report filtered_count vs total_count", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv, [makeAssignment()]);
    forbidNetwork();
    const out = (await getCampaigns(env, {
      faction: "Automaton",
    })) as Record<string, unknown>;
    expect(out.filtered_count).toBe(0);
    expect(out.total_count).toBe(1);
    expect(out.campaigns).toEqual([]);
  });
});

describe("resolve_planet tool (cache-served, read-only)", () => {
  it("fuzzy near-miss returns ranked candidates and writes nothing", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv, []);
    forbidNetwork();
    const out = (await resolvePlanetTool(env, {
      query: "grand errand",
    })) as Record<string, unknown>;
    expect(out.matched).toBe(false);
    const candidates = out.candidates as Array<Record<string, unknown>>;
    expect(candidates[0]).toMatchObject({ index: 175, name: "GRAND ERRANT" });
    expect(kv.puts).toEqual([]); // zero KV writes
  });
});
