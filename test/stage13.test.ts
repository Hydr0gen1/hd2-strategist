/**
 * Fabel feature tests: supply-line graph + reverse adjacency (feature 1),
 * defense gambit origin (feature 2), per-player effective rates (feature 3),
 * planet regions/cities (feature 4), and the warm bulk-snapshot fallback
 * (feature 5). Pure builders are tested directly; the handlers reuse the same
 * sanctioned in-memory-KV pattern as the stage6 tests (raw cache pre-seeded,
 * the network forbidden) so a fallback is proven without ever touching the
 * network.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAdjacencySummary,
  buildGambitOrigins,
  buildInboundNeighbors,
  buildNeighbors,
  buildSupplyGraph,
  perPlayerRates,
  selectRegions,
} from "../src/enrichment";
import { RAW_STATUS_PATH } from "../src/crosscheck";
import {
  campaignView,
  type CampaignProvenance,
  type CampaignView,
} from "../src/provenance";
import { getPlanet, getSupplyGraph, runScheduledSample } from "../src/tools";
import type { Env, RawAssignment, RawCampaign, RawPlanet, RawWar } from "../src/types";

/** Test helper: wrap a kind map (+ optional MO set / provenance) in the
 * tri-state campaign accessor the builders now consume. */
function cview(
  kinds: Map<number, "liberation" | "defense">,
  mo: Set<number> = new Set(),
  provenance: CampaignProvenance = "ok",
): CampaignView {
  return campaignView(kinds, mo, provenance);
}

/* ------------------------------ fixtures ------------------------------ */

function planet(over: Partial<RawPlanet> = {}): RawPlanet {
  return {
    index: 0,
    name: "P0",
    sector: "SECTOR",
    maxHealth: 1_000_000,
    health: 1_000_000,
    disabled: false,
    initialOwner: "Humans",
    currentOwner: "Humans",
    regenPerSecond: 0,
    event: null,
    attacking: [],
    waypoints: [],
    statistics: null,
    biome: null,
    hazards: null,
    ...over,
  };
}

function defenseEvent(over: Record<string, unknown> = {}) {
  return {
    id: 5604,
    eventType: 1,
    faction: "Illuminate",
    health: 867_280,
    maxHealth: 900_000,
    startTime: "2026-06-16T09:16:00Z",
    endTime: "2026-06-18T09:16:00Z",
    campaignId: 51602,
    ...over,
  } as RawPlanet["event"];
}

// A small galaxy modeled on the live Karlia (185) shape verified 2026-06-17.
const KARLIA = planet({
  index: 185,
  name: "KARLIA",
  currentOwner: "Humans",
  waypoints: [273], // outbound
  attacking: [184], // Karlia is a source toward 184 (irrelevant to its defense)
  event: defenseEvent(),
});
const SANGIS = planet({
  index: 273,
  name: "SANGIS",
  currentOwner: "Illuminate",
  health: 555_000,
  waypoints: [185], // inbound neighbor of Karlia
  attacking: [185], // Sangis attacks Karlia → Karlia's gambit origin
});
const ALATHFAR = planet({
  index: 50,
  name: "ALATHFAR IV",
  currentOwner: "Humans",
  waypoints: [185], // inbound neighbor of Karlia, Human-owned
  attacking: [],
});
const GALAXY = [KARLIA, SANGIS, ALATHFAR];

function byIndex(planets: RawPlanet[]): Map<number, RawPlanet> {
  return new Map(planets.map((p) => [p.index, p]));
}

/* ----------------------- feature 1: adjacency ------------------------- */

describe("feature 1 — inbound neighbors + adjacency summary", () => {
  const kinds = new Map<number, "liberation" | "defense">([[273, "liberation"]]);

  it("inbound_neighbors inverts observed waypoints (Sangis + Alathfar point into Karlia)", () => {
    const inbound = buildInboundNeighbors(KARLIA, byIndex(GALAXY), cview(kinds));
    expect(inbound.map((n) => n.index)).toEqual([50, 273]); // sorted by index
    expect(inbound.find((n) => n.index === 273)).toMatchObject({
      name: "SANGIS",
      owner: "Illuminate",
      has_active_campaign: true,
      campaign_kind: "liberation",
    });
    expect(inbound.find((n) => n.index === 50)).toMatchObject({
      owner: "Humans",
      has_active_campaign: false,
      campaign_kind: null,
    });
  });

  it("existing outbound neighbors are unchanged by the inbound addition", () => {
    const out = buildNeighbors(KARLIA, byIndex(GALAXY), cview(kinds));
    expect(out.neighbors.map((n) => n.index)).toEqual([273]); // upstream order
  });

  it("adjacency_summary reports counts + borders_super_earth from a Human neighbor", () => {
    const out = buildNeighbors(KARLIA, byIndex(GALAXY), cview(kinds));
    const inbound = buildInboundNeighbors(KARLIA, byIndex(GALAXY), cview(kinds));
    const summary = buildAdjacencySummary(out.neighbors, inbound);
    expect(summary).toEqual({
      outbound: 1,
      inbound: 2,
      super_earth_neighbors: [50],
      borders_super_earth: true,
    });
  });

  it("borders_super_earth is false with no Human neighbor", () => {
    const lone = planet({ index: 9, currentOwner: "Terminids", waypoints: [] });
    const map = byIndex([lone]);
    const out = buildNeighbors(lone, map, cview(new Map()));
    const inbound = buildInboundNeighbors(lone, map, cview(new Map()));
    expect(buildAdjacencySummary(out.neighbors, inbound).borders_super_earth).toBe(
      false,
    );
  });
});

/* --------------------- feature 1: supply graph ------------------------ */

describe("feature 1 — buildSupplyGraph", () => {
  const kinds = new Map<number, "liberation" | "defense">([
    [185, "defense"],
    [273, "liberation"],
  ]);

  it("default subgraph seeds active-campaign planets + one-hop neighbors, observed edges only", () => {
    const { nodes, edges } = buildSupplyGraph(GALAXY, cview(kinds), {
      depth: 1,
      activeOnly: false,
      full: false,
    });
    // 185 + 273 are active; one hop pulls in Alathfar (50, points into 185).
    expect(nodes.map((n) => n.index)).toEqual([50, 185, 273]);
    // Only observed waypoints: 185→273, 273→185, 50→185. No implied reverses.
    expect(edges).toEqual([
      { from: 50, to: 185, observed: true },
      { from: 185, to: 273, observed: true },
      { from: 273, to: 185, observed: true },
    ]);
    expect(nodes.find((n) => n.index === 185)?.borders_super_earth).toBe(true);
  });

  it("active_only narrows nodes to active-campaign planets", () => {
    const { nodes } = buildSupplyGraph(GALAXY, cview(kinds), {
      depth: 1,
      activeOnly: true,
      full: false,
    });
    expect(nodes.map((n) => n.index)).toEqual([185, 273]); // Alathfar dropped
  });

  it("full returns the whole galaxy", () => {
    const { nodes } = buildSupplyGraph(GALAXY, cview(kinds), {
      depth: 1,
      activeOnly: false,
      full: true,
    });
    expect(nodes.map((n) => n.index)).toEqual([50, 185, 273]);
  });

  it("dangling waypoint targets are never promoted to nodes or edges", () => {
    const dangling = planet({ index: 7, waypoints: [999], attacking: [] });
    const { nodes, edges } = buildSupplyGraph([dangling], cview(new Map()), {
      rootIndex: 7,
      depth: 2,
      activeOnly: false,
      full: false,
    });
    expect(nodes.map((n) => n.index)).toEqual([7]);
    expect(edges).toEqual([]); // 7→999 dropped (999 is not a planet)
  });
});

/* ----------------------- feature 2: gambit ---------------------------- */

describe("feature 2 — buildGambitOrigins", () => {
  it("resolves the attacker of a defense and joins MO membership", () => {
    const origins = buildGambitOrigins(
      KARLIA,
      byIndex(GALAXY),
      cview(new Map([[273, "liberation"]]), new Set([273])),
    );
    expect(origins).toHaveLength(1);
    expect(origins[0]).toEqual({
      index: 273,
      name: "SANGIS",
      owner: "Illuminate",
      has_active_campaign: true,
      campaign_kind: "liberation",
      raw_hp: 555_000,
      is_major_order_target: true,
    });
  });

  it("returns multiple origins sorted by index, no viability verdict key", () => {
    const a = planet({ index: 184, attacking: [185], currentOwner: "Illuminate" });
    const origins = buildGambitOrigins(
      KARLIA,
      byIndex([KARLIA, SANGIS, a]),
      cview(new Map()),
    );
    expect(origins.map((o) => o.index)).toEqual([184, 273]);
    for (const o of origins) {
      expect(Object.keys(o)).not.toContain("gambit_viable");
      expect(Object.keys(o)).not.toContain("recommended");
    }
  });

  it("no attacker → empty list", () => {
    const quiet = planet({ index: 1, attacking: [] });
    expect(
      buildGambitOrigins(quiet, byIndex([quiet]), cview(new Map())),
    ).toEqual([]);
  });
});

/* ------------------- feature 3: per-player rates ---------------------- */

describe("feature 3 — perPlayerRates", () => {
  it("validation checkpoint: liberation gross is positive (~2.35k per 1k)", () => {
    // Basquine VIII shape: ~30.2k players, +51k hp/h, ~20k/h decay.
    const r = perPlayerRates({
      hpPerHour: 51_000,
      decayPerHour: 20_000,
      campaignKind: "liberation",
      playerCount: 30_200,
    });
    expect(r.gross_depletion_per_hour).toBe(71_000);
    expect(r.gross_depletion_per_1k_players).toBeGreaterThan(2_300);
    expect(r.gross_depletion_per_1k_players).toBeLessThan(2_400);
    expect(r.net_hp_per_hour_per_1k_players).toBeGreaterThan(0); // sign positive
    expect(r.reason).toBeUndefined();
  });

  it("defense nulls gross with the invariant-1 reason; net still present", () => {
    const r = perPlayerRates({
      hpPerHour: 51_000,
      decayPerHour: null,
      campaignKind: "defense",
      playerCount: 30_200,
    });
    expect(r.gross_depletion_per_hour).toBeNull();
    expect(r.gross_depletion_per_1k_players).toBeNull();
    expect(r.net_hp_per_hour_per_1k_players).not.toBeNull();
    expect(r.reason).toBe("defense_decay_nulled_invariant_1");
  });

  it("zero players nulls every per-player field (no divide-by-zero)", () => {
    const r = perPlayerRates({
      hpPerHour: 51_000,
      decayPerHour: 20_000,
      campaignKind: "liberation",
      playerCount: 0,
    });
    expect(r.net_hp_per_hour_per_1k_players).toBeNull();
    expect(r.gross_depletion_per_1k_players).toBeNull();
    expect(r.reason).toBe("no_players");
  });

  it("missing rate → net null with no_current_rate gross reason", () => {
    const r = perPlayerRates({
      hpPerHour: null,
      decayPerHour: 20_000,
      campaignKind: "liberation",
      playerCount: 1_000,
    });
    expect(r.net_hp_per_hour_per_1k_players).toBeNull();
    expect(r.gross_depletion_per_hour).toBeNull();
    expect(r.reason).toBe("no_current_rate");
  });
});

/* ----------------------- feature 4: regions --------------------------- */

describe("feature 4 — selectRegions", () => {
  it("passes through raw region fields and detects a City via upstream size", () => {
    const out = selectRegions([
      {
        id: 0,
        name: "ADNAN",
        description: "null", // literal sentinel coerced to null
        health: 392_780,
        maxHealth: 400_000,
        size: "City",
        regenPerSecond: 0,
        availabilityFactor: 1,
        isAvailable: true,
        players: 166,
      },
    ]);
    expect(out.regions_available).toBe(true);
    expect(out.has_city_region).toBe(true);
    expect(out.regions[0]).toEqual({
      id: 0,
      name: "ADNAN",
      description: null,
      health: 392_780,
      max_health: 400_000,
      size: "City",
      regen_per_second: 0,
      availability_factor: 1,
      is_available: true,
      players: 166,
    });
  });

  it("no region array → regions_available false, nothing fabricated", () => {
    expect(selectRegions(undefined)).toEqual({
      regions: [],
      regions_available: false,
      has_city_region: false,
    });
    expect(selectRegions([])).toMatchObject({ regions_available: false });
  });

  it("a non-City region does not set has_city_region", () => {
    const out = selectRegions([{ id: 1, size: "Settlement", health: 10 }]);
    expect(out.has_city_region).toBe(false);
    expect(out.regions_available).toBe(true);
  });
});

/* ----------------------- handler harness (KV) ------------------------- */

interface FakeKv {
  store: Map<string, string>;
  puts: { key: string; ttl?: number }[];
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
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

function rawCampaign(over: Partial<RawCampaign> = {}): RawCampaign {
  return { id: 1, planet: KARLIA, type: 0, count: 1, faction: "Illuminate", ...over };
}

const MO_ASSIGNMENT: RawAssignment = {
  id: 1703871073,
  progress: [0, 0],
  title: "MAJOR ORDER",
  briefing: null,
  description: null,
  tasks: [{ type: 11, values: [1, 1, 273], valueTypes: [3, 11, 12] }],
  reward: null,
  rewards: [],
  expiration: "2026-06-20T09:01:35Z",
  flags: 0,
};

function seededEnv(kv: FakeKv): Env {
  seedRaw(kv, "/api/v1/planets", GALAXY);
  seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS, type: 0 })]);
  seedRaw(kv, "/api/v1/assignments", [MO_ASSIGNMENT]);
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
    throw new Error("network touched — the cache/snapshot should have served this");
  }) as unknown as typeof fetch;
  return counter;
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

const FORBIDDEN_KEYS =
  /viable|recommend|priority|^rank$|verdict|should|optimal|winner|authoritative|can_liberate|gambit_recommended/i;

/* ----------------------- feature 1/2: get_planet ---------------------- */

describe("get_planet — feature 1 + 2 + 3 + 4 (cache-served)", () => {
  it("surfaces inbound_neighbors, adjacency_summary, gambit_origin, per_player_rates, regions", async () => {
    const kv = fakeKv();
    // Karlia carries regions for feature 4.
    const karliaWithRegions = planet({
      ...KARLIA,
      statistics: {
        playerCount: 439,
        missionsWon: 1,
        missionsLost: 1,
        missionSuccessRate: 50,
        terminidKills: 1,
        automatonKills: 1,
        illuminateKills: 1,
        deaths: 1,
        accuracy: 90,
      },
      regions: [{ id: 0, name: "ADNAN", size: "City", health: 392_780, players: 166 }],
    });
    seedRaw(kv, "/api/v1/planets", [karliaWithRegions, SANGIS, ALATHFAR]);
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", [MO_ASSIGNMENT]);
    seedRaw(kv, RAW_STATUS_PATH, {}); // cross_check probes /raw — keep it cache-served
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    const fetches = forbidNetwork();

    const out = (await getPlanet(env, { index: 185 })) as Record<string, any>;

    expect(fetches.calls).toBe(0);
    // Feature 1
    expect(out.inbound_neighbors.map((n: any) => n.index)).toEqual([50, 273]);
    expect(out.adjacency_summary.borders_super_earth).toBe(true);
    expect(out.adjacency_summary.super_earth_neighbors).toEqual([50]);
    expect(out.neighbors.map((n: any) => n.index)).toEqual([273]); // outbound unchanged
    // Feature 2 (gambit lives on defense_event)
    expect(out.defense_event.gambit_origin).toMatchObject({
      index: 273,
      name: "SANGIS",
      is_major_order_target: true,
    });
    // Feature 3
    expect(out.per_player_rates).toBeTruthy();
    expect(out.per_player_rates.net_hp_per_hour_per_1k_players ?? null).not.toBe(
      undefined,
    );
    // Feature 4
    expect(out.regions_available).toBe(true);
    expect(out.has_city_region).toBe(true);
    expect(out.regions[0].size).toBe("City");

    // Prime directive: no interpretive/verdict key anywhere in the payload.
    for (const k of collectKeys(out)) expect(k).not.toMatch(FORBIDDEN_KEYS);
  });

  it("defense gross_* fields are null with the invariant-1 reason", async () => {
    const kv = fakeKv();
    // per_player_rates reads player_count from the PLANETS-list planet, so
    // Karlia (a defense via its event) needs players there for the gross path
    // to reach the invariant-1 null rather than the no_players null.
    const karliaWithPlayers = planet({
      ...KARLIA,
      statistics: { playerCount: 100 } as any,
    });
    seedRaw(kv, "/api/v1/planets", [karliaWithPlayers, SANGIS, ALATHFAR]);
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", [MO_ASSIGNMENT]);
    seedRaw(kv, RAW_STATUS_PATH, {});
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 185 })) as Record<string, any>;
    expect(out.campaign_kind).toBe("defense");
    expect(out.per_player_rates.gross_depletion_per_hour).toBeNull();
    expect(out.per_player_rates.reason).toBe("defense_decay_nulled_invariant_1");
  });
});

/* ----------------------- feature 1: get_supply_graph ------------------ */

describe("get_supply_graph handler", () => {
  it("default returns the active-campaign subgraph with observed edges, READ-ONLY (zero writes)", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv); // active campaign on Sangis (273)
    forbidNetwork();

    const out = (await getSupplyGraph(env, {})) as Record<string, any>;

    expect(out.scope).toBe("active_campaign_subgraph");
    expect(out.nodes.map((n: any) => n.index)).toContain(273);
    expect(out.edge_count).toBe(out.edges.length);
    for (const e of out.edges) expect(e.observed).toBe(true);
    expect(out.provenance).toMatchObject({
      planet_source: "live",
      campaigns: "ok",
      planet_snapshot_used: false,
      campaign_outage: false,
    });
    expect(out.active_campaign_overlay).toBe("complete");
    expect(out.stale).toBeUndefined();
    // Read-only: a topology/overlay query never drives the sampling cadence.
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(0);
    for (const k of collectKeys(out)) expect(k).not.toMatch(FORBIDDEN_KEYS);
  });

  it("root by name + full both resolve; full spans the galaxy", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    forbidNetwork();

    const rooted = (await getSupplyGraph(env, { root: "karlia" })) as Record<
      string,
      any
    >;
    expect(rooted.scope).toBe("root_subgraph");
    expect(rooted.root_index).toBe(185);

    const full = (await getSupplyGraph(env, { full: true })) as Record<string, any>;
    expect(full.scope).toBe("full_galaxy");
    expect(full.nodes.map((n: any) => n.index).sort((a: number, b: number) => a - b)).toEqual([
      50, 185, 273,
    ]);
  });
});

/* ----------------------- feature 5: warm cache ------------------------ */

describe("feature 5 — warm bulk-snapshot fallback", () => {
  it("get_planet serves the bulk snapshot (stale: true) when live fetch fails", async () => {
    const kv = fakeKv();
    // No raw: cache at all — every fetchUpstream would throw. Only the durable
    // snapshot exists (as a prior good cron/poll would have written it).
    kv.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 600_000, body: GALAXY }),
    );
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 185 })) as Record<string, any>;
    // Served, not thrown — adjacency context resolved from the snapshot.
    expect(out.planet_index).toBe(185);
    expect(out.inbound_neighbors.map((n: any) => n.index)).toEqual([50, 273]);
    expect(out.stale).toBe(true);
  });

  it("a genuine planets fetch refreshes the durable snapshot; a cache hit does not", async () => {
    // Genuine fetch path: stub fetch to return data so fetchUpstream is cached:false.
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    globalThis.fetch = (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes("/api/v1/planets") ? GALAXY : [],
    })) as unknown as typeof fetch;

    await getSupplyGraph(env, {});
    expect(kv.puts.map((p) => p.key)).toContain("snapshot:planets");

    // Now the raw cache is warm: a second call is a cache hit → no new snapshot put.
    const before = kv.puts.filter((p) => p.key === "snapshot:planets").length;
    await getSupplyGraph(env, {});
    const after = kv.puts.filter((p) => p.key === "snapshot:planets").length;
    expect(after).toBe(before); // cache hit wrote no snapshot
  });
});

/* ------------- P1: provenance-gated persistence (Codex fix) ------------ */

// Minimal D1 stub: archiveSampleTick rides kvCommitted, so when persistence is
// gated off it is never reached and batchCalls stays 0. On a live tick it runs.
class FakeD1 {
  batchCalls = 0;
  prepare(_sql: string) {
    return { bind: (..._a: unknown[]) => ({}) };
  }
  async batch(_stmts: unknown[]) {
    this.batchCalls += 1;
    return [];
  }
}

function seedRawAged(
  kv: FakeKv,
  path: string,
  body: unknown,
  ageMs: number,
): void {
  kv.store.set(
    `raw:${path}`,
    JSON.stringify({ fetchedAt: Date.now() - ageMs, body }),
  );
}

const P1_WAR: RawWar = {
  started: "2024-01-23T20:05:13Z",
  ended: "2028-02-08T20:04:55Z",
  now: "1972-04-26T00:00:00Z",
  clientVersion: "0.3.0",
  factions: ["Humans", "Terminids", "Automaton", "Illuminate"],
  impactMultiplier: 0.02,
  statistics: {
    missionsWon: 1,
    missionsLost: 1,
    missionSuccessRate: 50,
    terminidKills: 1,
    automatonKills: 1,
    illuminateKills: 1,
    deaths: 1,
    playerCount: 50_000,
    accuracy: 60,
  },
};

const samplePuts = (kv: FakeKv) =>
  kv.puts.filter((p) => p.key === "samples:planets").length;

describe("P1 — provenance-gated persistence", () => {
  it("1. getPlanet during campaign-fetch failure (planets from snapshot): stale, zero writes", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    // Only the durable snapshot exists; every raw: fetch fails (no cache).
    kv.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 300_000, body: GALAXY }),
    );
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;

    expect(out.stale).toBe(true);
    expect(out.campaign_state_known).toBe(false);
    expect(samplePuts(kv)).toBe(0); // no KV append
    expect(d1.batchCalls).toBe(0); // no D1 archive row
  });

  it("2. cron tick during the same outage: no KV append, no D1 row", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    // Campaign/assignment/war caches exist but are EXPIRED (>45s); the network
    // is down, so fetchUpstream serves them stale — a non-live observation.
    seedRawAged(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })], 60_000);
    seedRawAged(kv, "/api/v1/assignments", [], 60_000);
    seedRawAged(kv, "/api/v1/war", P1_WAR, 60_000);
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    await runScheduledSample(env);

    expect(samplePuts(kv)).toBe(0); // archive/ring buffer untouched
    expect(d1.batchCalls).toBe(0);
  });

  it("3. fully-live fetch: samples and persists normally (gate did not over-block)", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    seedRaw(kv, RAW_STATUS_PATH, {});
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;

    expect(out.stale).toBeUndefined(); // live → not stale
    expect(out.campaign_state_known).toBe(true);
    expect(samplePuts(kv)).toBeGreaterThanOrEqual(1); // persisted
    expect(d1.batchCalls).toBeGreaterThanOrEqual(1);
  });

  it("4. active planet during a campaign outage: not has_active_campaign:false; campaign_state_known:false; no quiet sampling", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    // Planets endpoint is up (live), campaigns endpoint is down (no cache).
    seedRaw(kv, "/api/v1/planets", GALAXY);
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    // 185 (Karlia) would be an active defense if campaigns resolved.
    const out = (await getPlanet(env, { index: 185 })) as Record<string, any>;

    expect(out.has_active_campaign).toBeNull(); // never asserted false
    expect(out.campaign_state_known).toBe(false);
    expect(out.stale).toBe(true);
    expect(samplePuts(kv)).toBe(0); // unknown ≠ quiet → no sampling
    expect(d1.batchCalls).toBe(0);
  });

  it("5. genuinely empty live result (ok:true, empty): writes allowed", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    seedRaw(kv, "/api/v1/campaigns", []); // LIVE empty — a real 'no campaigns'
    seedRaw(kv, "/api/v1/assignments", []);
    seedRaw(kv, RAW_STATUS_PATH, {});
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;

    expect(out.campaign_state_known).toBe(true);
    expect(out.has_active_campaign).toBe(false); // real quiet, not unknown
    expect(out.stale).toBeUndefined();
    expect(samplePuts(kv)).toBeGreaterThanOrEqual(1); // empty-but-live records
  });

  it("6. predicate unity: stale ⟺ no write (both directions)", async () => {
    // Degraded: campaigns down, planets from snapshot → stale, no write.
    const kvA = fakeKv();
    kvA.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 300_000, body: GALAXY }),
    );
    const envA: Env = { WAR_CACHE: kvA as unknown as KVNamespace };
    forbidNetwork();
    const a = (await getPlanet(envA, { index: 50 })) as Record<string, any>;
    expect(a.stale).toBe(true);
    expect(samplePuts(kvA)).toBe(0); // stale ⟹ no write

    // Live: everything fresh → not stale, wrote.
    const kvB = fakeKv();
    seedRaw(kvB, "/api/v1/planets", GALAXY);
    seedRaw(kvB, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kvB, "/api/v1/assignments", []);
    seedRaw(kvB, RAW_STATUS_PATH, {});
    const envB: Env = { WAR_CACHE: kvB as unknown as KVNamespace };
    const b = (await getPlanet(envB, { index: 50 })) as Record<string, any>;
    expect(b.stale).toBeUndefined(); // wrote ⟹ not stale
    expect(samplePuts(kvB)).toBeGreaterThanOrEqual(1);
  });
});

/* --------- supply-graph split provenance (campaign vs planet) --------- */

describe("get_supply_graph — split provenance (campaign vs planet outage)", () => {
  const everyNode = (out: Record<string, any>) =>
    out.nodes as Array<Record<string, any>>;

  it("1. campaign-only outage: campaigns 'unavailable', overlay 'unavailable', planet_source live, flagged unknown (not bare empty)", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRaw(kv, "/api/v1/planets", GALAXY); // planets LIVE
    // No campaigns/assignments cache → loadNormalizedCampaigns throws → ok:false.
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getSupplyGraph(env, {})) as Record<string, any>;

    expect(out.provenance.planet_source).toBe("live");
    expect(out.provenance.campaigns).toBe("unavailable");
    expect(out.provenance.planet_snapshot_used).toBe(false);
    expect(out.provenance.campaign_outage).toBe(true);
    expect(out.active_campaign_overlay).toBe("unavailable");
    expect(out.stale).toBe(true);
    // Not a bare empty "no campaigns": topology returned, flagged unknown.
    expect(out.scope).toBe("active_campaign_subgraph_unknown");
    expect(out.node_count).toBeGreaterThan(0);
    for (const n of everyNode(out)) {
      expect(n.campaign_state_known).toBe(false);
      expect(n.has_active_campaign).toBeNull();
    }
    // Tool note no longer equates stale with the snapshot fallback.
    expect(out.notes.supply_graph).toContain("provenance");
    // Read-only on every path.
    expect(samplePuts(kv)).toBe(0);
    expect(d1.batchCalls).toBe(0);
  });

  it("2. planet-snapshot-only: planet_snapshot_used true, campaigns 'ok', overlay 'complete'", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    // Planets: only the durable snapshot (no raw cache) → source 'snapshot'.
    kv.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 120_000, body: GALAXY }),
    );
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getSupplyGraph(env, {})) as Record<string, any>;

    expect(out.provenance.planet_source).toBe("snapshot");
    expect(out.provenance.planet_snapshot_used).toBe(true);
    expect(out.provenance.campaigns).toBe("ok");
    expect(out.provenance.campaign_outage).toBe(false);
    expect(out.active_campaign_overlay).toBe("complete");
    expect(out.stale).toBe(true);
    for (const n of everyNode(out)) expect(n.campaign_state_known).toBe(true);
    expect(samplePuts(kv)).toBe(0); // read-only
    expect(d1.batchCalls).toBe(0);
  });

  it("3. both nominal: stale false, overlay complete, campaigns ok, no snapshot", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    forbidNetwork();

    const out = (await getSupplyGraph(env, {})) as Record<string, any>;
    expect(out.stale).toBeUndefined();
    expect(out.active_campaign_overlay).toBe("complete");
    expect(out.provenance).toMatchObject({
      campaigns: "ok",
      planet_source: "live",
      planet_snapshot_used: false,
      campaign_outage: false,
    });
  });

  it("4. both degraded: planet_snapshot_used AND campaign_outage true; reasons lists both", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    kv.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 120_000, body: GALAXY }),
    );
    // No campaigns cache → outage.
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getSupplyGraph(env, {})) as Record<string, any>;
    expect(out.provenance.planet_snapshot_used).toBe(true);
    expect(out.provenance.campaign_outage).toBe(true);
    expect(out.provenance.reasons.length).toBeGreaterThanOrEqual(2);
    expect(out.provenance.reasons.some((r: string) => r.includes("snapshot"))).toBe(true);
    expect(out.provenance.reasons.some((r: string) => r.includes("campaign"))).toBe(true);
    expect(samplePuts(kv)).toBe(0);
    expect(d1.batchCalls).toBe(0);
  });

  it("5. full:true during campaign outage: topology complete, per-node campaign_state_known false, overlay unavailable", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRaw(kv, "/api/v1/planets", GALAXY); // planets live
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getSupplyGraph(env, { full: true })) as Record<string, any>;
    expect(out.scope).toBe("full_galaxy");
    expect(out.nodes.map((n: any) => n.index).sort((a: number, b: number) => a - b)).toEqual([
      50, 185, 273,
    ]);
    expect(out.active_campaign_overlay).toBe("unavailable");
    expect(out.stale).toBe(true);
    for (const n of out.nodes as any[]) {
      expect(n.campaign_state_known).toBe(false);
      expect(n.has_active_campaign).toBeNull();
    }
    expect(samplePuts(kv)).toBe(0);
    expect(d1.batchCalls).toBe(0);
  });

  it("6. no node asserts has_active_campaign:false while campaigns unknown", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getSupplyGraph(env, { full: true })) as Record<string, any>;
    for (const n of out.nodes as any[]) expect(n.has_active_campaign).not.toBe(false);
  });

  it("7. no persistence on any degraded path (snapshot or campaign outage)", async () => {
    forbidNetwork();
    // Campaign outage:
    const kvA = fakeKv();
    const d1A = new FakeD1();
    seedRaw(kvA, "/api/v1/planets", GALAXY);
    await getSupplyGraph(
      {
        WAR_CACHE: kvA as unknown as KVNamespace,
        HISTORY_DB: d1A as unknown as D1Database,
      },
      {},
    );
    expect(samplePuts(kvA)).toBe(0);
    expect(d1A.batchCalls).toBe(0);

    // Planet snapshot:
    const kvB = fakeKv();
    const d1B = new FakeD1();
    kvB.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 120_000, body: GALAXY }),
    );
    seedRaw(kvB, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kvB, "/api/v1/assignments", []);
    forbidNetwork();
    await getSupplyGraph(
      {
        WAR_CACHE: kvB as unknown as KVNamespace,
        HISTORY_DB: d1B as unknown as D1Database,
      },
      {},
    );
    expect(samplePuts(kvB)).toBe(0);
    expect(d1B.batchCalls).toBe(0);
  });
});

/* ---- P1 round 2: decoupled persistence (loaders pure, one writer) ----- */

describe("P1 round 2 — side-effect-free loaders + single gated write", () => {
  it("1. planets SNAPSHOT + campaigns FRESH: get_planet writes nothing (reviewer's case)", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    // Planets only from the durable snapshot; campaigns/assignments are FRESH.
    kv.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 120_000, body: GALAXY }),
    );
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    // Query a quiet planet so a campaign batch (Sangis) exists to (not) write.
    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;

    expect(out.stale).toBe(true);
    // The loader recorded nothing; the gate suppressed the commit.
    expect(samplePuts(kv)).toBe(0); // zero campaign-sample AND planet-sample writes
    expect(d1.batchCalls).toBe(0);
  });

  it("2. planets live + campaigns ok: persists normally (regression guard)", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    seedRaw(kv, RAW_STATUS_PATH, {});
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;
    expect(out.stale).toBeUndefined();
    expect(samplePuts(kv)).toBeGreaterThanOrEqual(1);
    expect(d1.batchCalls).toBeGreaterThanOrEqual(1);
  });

  it("3. planets live + campaigns ok:false: no writes, degraded", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRaw(kv, "/api/v1/planets", GALAXY); // planets live
    // campaigns down → resilient-empty (ok:false)
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;
    expect(out.stale).toBe(true);
    expect(out.campaign_state_known).toBe(false);
    expect(samplePuts(kv)).toBe(0);
    expect(d1.batchCalls).toBe(0);
  });

  it("4. loader purity: a live get_supply_graph commits NOTHING (only the terminal step writes)", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    // Fully-live seeds (so the loader DOES compute a tick) — but get_supply_graph
    // never commits, proving the loader itself wrote nothing.
    seedRaw(kv, "/api/v1/planets", GALAXY);
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    forbidNetwork();

    await getSupplyGraph(env, {});
    expect(samplePuts(kv)).toBe(0);
    expect(d1.batchCalls).toBe(0);
  });

  it("5. cron tick over a stale campaign cache records nothing (cron's degraded path)", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRawAged(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })], 60_000);
    seedRawAged(kv, "/api/v1/assignments", [], 60_000);
    seedRawAged(kv, "/api/v1/war", P1_WAR, 60_000);
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    await runScheduledSample(env);
    expect(samplePuts(kv)).toBe(0);
    expect(d1.batchCalls).toBe(0);
  });
});

/* ------ P2: active_only preserves topology under campaign outage ------- */

describe("get_supply_graph — active_only under campaign outage (P2)", () => {
  it("1. {full:true, active_only:true} during outage: non-empty topology, overlay unavailable, active_only_applied false", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY); // planets live; campaigns down
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getSupplyGraph(env, {
      full: true,
      active_only: true,
    })) as Record<string, any>;

    expect(out.node_count).toBe(3); // topology NOT emptied
    expect(out.active_campaign_overlay).toBe("unavailable");
    expect(out.active_only_applied).toBe(false);
    expect(
      out.provenance.reasons.some((r: string) => r.includes("active_only")),
    ).toBe(true);
    for (const n of out.nodes as any[]) {
      expect(n.campaign_state_known).toBe(false);
      expect(n.has_active_campaign).toBeNull();
    }
  });

  it("2. active_only:true, campaigns ok: filter applies; active_only_applied true", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv); // Sangis (273) active
    forbidNetwork();

    const out = (await getSupplyGraph(env, { active_only: true })) as Record<
      string,
      any
    >;
    expect(out.active_only_applied).toBe(true);
    expect(out.active_campaign_overlay).toBe("complete");
    // Only active campaign planets survive the filter.
    for (const n of out.nodes as any[]) expect(n.has_active_campaign).toBe(true);
    expect(out.nodes.map((n: any) => n.index)).toContain(273);
  });

  it("3. active_only:true, campaigns stale: filter applies on last-known; overlay degraded", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY); // planets live
    // Campaigns served from an EXPIRED cache → stale (ok:true, stale:true).
    seedRawAged(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })], 60_000);
    seedRawAged(kv, "/api/v1/assignments", [], 60_000);
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getSupplyGraph(env, { active_only: true })) as Record<
      string,
      any
    >;
    expect(out.provenance.campaigns).toBe("stale");
    expect(out.active_campaign_overlay).toBe("degraded");
    expect(out.active_only_applied).toBe(true);
    for (const n of out.nodes as any[]) expect(n.has_active_campaign).toBe(true);
  });

  it("4. an empty graph is never a silent stand-in for 'no active campaigns' under outage", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getSupplyGraph(env, { active_only: true })) as Record<
      string,
      any
    >;
    // Default+active_only under outage → full topology flagged unknown.
    expect(out.node_count).toBeGreaterThan(0);
    expect(out.active_campaign_overlay).toBe("unavailable");
    expect(out.active_only_applied).toBe(false);
  });
});

/* ============ PR #17 consolidation: one provenance contract ============ */

import {
  allFresh,
  anyDegraded,
  planetProvenanceOf,
} from "../src/provenance";

/** Read a repo-relative source file at runtime (node), untyped to avoid a
 * @types/node dependency the Worker build deliberately omits. */
async function readSource(rel: string): Promise<string> {
  const fsName = "node:fs";
  const fs: any = await import(fsName);
  const cwd: string = (globalThis as any).process.cwd();
  return fs.readFileSync(`${cwd}/${rel}`, "utf8") as string;
}

describe("provenance module — predicates + tri-state accessor", () => {
  it("planetProvenanceOf maps source/stale to the three states", () => {
    expect(planetProvenanceOf("live", false)).toBe("live_fresh");
    expect(planetProvenanceOf("live", true)).toBe("live_expired_cache");
    expect(planetProvenanceOf("snapshot", true)).toBe("snapshot_fallback");
  });

  it("allFresh iff both fresh; anyDegraded is its negation", () => {
    const planet = ["live_fresh", "live_expired_cache", "snapshot_fallback"] as const;
    const camp = ["ok", "stale", "unavailable"] as const;
    for (const p of planet)
      for (const c of camp) {
        const fresh = p === "live_fresh" && c === "ok";
        expect(allFresh(p, c)).toBe(fresh);
        expect(anyDegraded(p, c)).toBe(!fresh);
      }
  });

  it("campaignView is tri-state: unknown under 'unavailable', never silently false", () => {
    const kinds = new Map<number, "liberation" | "defense">([[1, "liberation"]]);
    const mo = new Set([1]);
    const ok = campaignView(kinds, mo, "ok");
    expect(ok.status(1)).toBe("active");
    expect(ok.status(2)).toBe("inactive");
    expect(ok.hasActiveCampaign(2)).toBe(false);
    expect(ok.moMembership(2)).toBe(false);

    const out = campaignView(kinds, mo, "unavailable");
    expect(out.known).toBe(false);
    expect(out.status(1)).toBe("unknown");
    expect(out.hasActiveCampaign(1)).toBeNull();
    expect(out.kind(1)).toBeNull();
    expect(out.moMembership(1)).toBe("unknown");
  });
});

describe("nested unknown — get_planet during a campaign outage (the new P2)", () => {
  it("every neighbor + gambit_origin is null, never false", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY); // planets live
    seedRaw(kv, RAW_STATUS_PATH, {});
    // No campaigns/assignments cache → campaign_provenance 'unavailable'.
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 185 })) as Record<string, any>;

    expect(out.campaign_state_known).toBe(false);
    expect(out.has_active_campaign).toBeNull();

    const nested = [
      ...(out.neighbors as any[]),
      ...(out.inbound_neighbors as any[]),
    ];
    expect(nested.length).toBeGreaterThan(0);
    for (const n of nested) {
      expect(n.has_active_campaign).toBeNull();
      expect(n.has_active_campaign).not.toBe(false);
    }
    const origin = out.defense_event.gambit_origin;
    expect(origin).toBeTruthy();
    expect(origin.has_active_campaign).toBeNull();
    expect(origin.is_major_order_target).toBeNull();
    expect(origin.has_active_campaign).not.toBe(false);
    expect(origin.is_major_order_target).not.toBe(false);
  });
});

describe("expired planet cache — three-state planet provenance", () => {
  it("get_supply_graph: live_expired_cache → stale:true, planet_stale:true, snapshot_used:false", async () => {
    const kv = fakeKv();
    seedRawAged(kv, "/api/v1/planets", GALAXY, 60_000); // expired raw cache
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getSupplyGraph(env, {})) as Record<string, any>;
    expect(out.provenance.planet_provenance).toBe("live_expired_cache");
    expect(out.provenance.planet_stale).toBe(true);
    expect(out.provenance.planet_snapshot_used).toBe(false);
    expect(out.provenance.campaigns).toBe("ok");
    expect(out.stale).toBe(true);
  });

  it("get_planet: live_expired_cache planets + fresh campaigns → writes nothing", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRawAged(kv, "/api/v1/planets", GALAXY, 60_000);
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    seedRaw(kv, RAW_STATUS_PATH, {});
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: d1 as unknown as D1Database,
    };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;
    expect(out.stale).toBe(true);
    expect(samplePuts(kv)).toBe(0); // expired cache is NOT recorded
    expect(d1.batchCalls).toBe(0);
  });
});

describe("predicate audit — per-site checks were deleted, not duplicated", () => {
  it("no `.source === 'live'` freshness checks outside the provenance module", async () => {
    for (const rel of ["src/tools.ts", "src/enrichment.ts"]) {
      expect(await readSource(rel)).not.toMatch(/\.source === ['"]live['"]/);
    }
  });

  it("no raw campaign-map `.has()` lookups outside the accessor", async () => {
    for (const rel of ["src/tools.ts", "src/enrichment.ts"]) {
      const src = await readSource(rel);
      expect(src).not.toMatch(/campaignKindByIndex\.has\(/);
      expect(src).not.toMatch(/campaignKindByPlanetIndex\.has\(/);
      expect(src).not.toMatch(/moPlanetIndices\.has\(/);
      expect(src).not.toMatch(/moMap\.has\(/);
    }
  });
});

/** Build an env for a (planet × campaign) provenance combination. */
function comboEnv(
  kv: FakeKv,
  planet: "live_fresh" | "live_expired_cache" | "snapshot_fallback",
  campaign: "ok" | "stale" | "unavailable",
): Env {
  if (planet === "live_fresh") seedRaw(kv, "/api/v1/planets", GALAXY);
  else if (planet === "live_expired_cache")
    seedRawAged(kv, "/api/v1/planets", GALAXY, 60_000);
  else
    kv.store.set(
      "snapshot:planets",
      JSON.stringify({ fetchedAt: Date.now() - 120_000, body: GALAXY }),
    );

  if (campaign === "ok") {
    seedRaw(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })]);
    seedRaw(kv, "/api/v1/assignments", []);
    seedRaw(kv, "/api/v1/war", P1_WAR);
  } else if (campaign === "stale") {
    seedRawAged(kv, "/api/v1/campaigns", [rawCampaign({ id: 51, planet: SANGIS })], 60_000);
    seedRawAged(kv, "/api/v1/assignments", [], 60_000);
    seedRawAged(kv, "/api/v1/war", P1_WAR, 60_000);
  }
  // 'unavailable' → seed nothing (fetch fails → resilient-empty).
  seedRaw(kv, RAW_STATUS_PATH, {});
  return { WAR_CACHE: kv as unknown as KVNamespace };
}

const PLANET_STATES = [
  "live_fresh",
  "live_expired_cache",
  "snapshot_fallback",
] as const;
const CAMPAIGN_STATES = ["ok", "stale", "unavailable"] as const;

describe("persist matrix — writes iff allFresh (get_planet)", () => {
  for (const p of PLANET_STATES)
    for (const c of CAMPAIGN_STATES) {
      it(`planet=${p} campaign=${c} → ${allFresh(p, c) ? "writes" : "no write"}`, async () => {
        const kv = fakeKv();
        const env = comboEnv(kv, p, c);
        forbidNetwork();
        await getPlanet(env, { index: 50 });
        expect(samplePuts(kv) > 0).toBe(allFresh(p, c));
      });
    }
});

describe("rollup matrix — stale iff anyDegraded (get_supply_graph)", () => {
  for (const p of PLANET_STATES)
    for (const c of CAMPAIGN_STATES) {
      it(`planet=${p} campaign=${c} → stale ${anyDegraded(p, c)}`, async () => {
        const kv = fakeKv();
        const env = comboEnv(kv, p, c);
        forbidNetwork();
        const out = (await getSupplyGraph(env, {})) as Record<string, any>;
        expect(Boolean(out.stale)).toBe(anyDegraded(p, c));
      });
    }
});

/* ----- null campaign-derived fields on the synthetic outage record ----- */

describe("get_planet — campaign-derived fields null under a campaign outage", () => {
  // The classification fields sourced from the synthetic normalized record;
  // each defaults a value and must be nulled when campaign state is unknown.
  const CAMPAIGN_DERIVED = [
    "campaign_kind",
    "win_condition",
    "direction",
    "alert",
    "stabilizing",
    "hpc",
    "hpc_note",
  ];

  it("1. non-event planet during outage: campaign_kind null (not liberation/defense)", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY); // planets live
    seedRaw(kv, RAW_STATUS_PATH, {});
    // No campaigns/assignments cache → campaign_provenance 'unavailable'.
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    // ALATHFAR (50): Human-owned, NO event — previously defaulted to liberation.
    const out = (await getPlanet(env, { index: 50 })) as Record<string, any>;

    expect(out.campaign_state_known).toBe(false);
    expect(out.has_active_campaign).toBeNull();
    expect(out.campaign_kind).toBeNull();
    expect(out.campaign_kind).not.toBe("liberation");
    expect(out.campaign_kind).not.toBe("defense");
  });

  it("2. field-sweep: NO campaign-derived field is non-null while campaign_state_known is false", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    seedRaw(kv, RAW_STATUS_PATH, {});
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    // Sweep an event planet (185, defense) AND a non-event planet (50).
    for (const index of [50, 185]) {
      const out = (await getPlanet(env, { index })) as Record<string, any>;
      expect(out.campaign_state_known).toBe(false);
      for (const field of CAMPAIGN_DERIVED) {
        // Either absent (hpc_note) or explicitly null — never a defaulted value.
        if (field in out) {
          expect(out[field], `${field} on planet ${index}`).toBeNull();
        }
      }
    }
  });

  it("3. regression: fully-live get_planet still reports the real campaign_kind", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv); // planets live, campaign on Sangis (273) liberation
    forbidNetwork();

    const lib = (await getPlanet(env, { index: 273 })) as Record<string, any>;
    expect(lib.campaign_state_known).toBe(true);
    expect(lib.campaign_kind).toBe("liberation");
    expect(lib.win_condition).toBe("raw_hp_to_zero");

    // Karlia (185) carries an event → defense, campaign state known.
    const def = (await getPlanet(env, { index: 185 })) as Record<string, any>;
    expect(def.campaign_state_known).toBe(true);
    expect(def.campaign_kind).toBe("defense");
  });
});
