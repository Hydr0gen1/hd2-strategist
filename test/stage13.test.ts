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
import { getPlanet, getSupplyGraph } from "../src/tools";
import type { Env, RawAssignment, RawCampaign, RawPlanet } from "../src/types";

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
    const inbound = buildInboundNeighbors(KARLIA, byIndex(GALAXY), kinds);
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
    const out = buildNeighbors(KARLIA, byIndex(GALAXY), kinds);
    expect(out.neighbors.map((n) => n.index)).toEqual([273]); // upstream order
  });

  it("adjacency_summary reports counts + borders_super_earth from a Human neighbor", () => {
    const out = buildNeighbors(KARLIA, byIndex(GALAXY), kinds);
    const inbound = buildInboundNeighbors(KARLIA, byIndex(GALAXY), kinds);
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
    const out = buildNeighbors(lone, map, new Map());
    const inbound = buildInboundNeighbors(lone, map, new Map());
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
    const { nodes, edges } = buildSupplyGraph(GALAXY, kinds, {
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
    const { nodes } = buildSupplyGraph(GALAXY, kinds, {
      depth: 1,
      activeOnly: true,
      full: false,
    });
    expect(nodes.map((n) => n.index)).toEqual([185, 273]); // Alathfar dropped
  });

  it("full returns the whole galaxy", () => {
    const { nodes } = buildSupplyGraph(GALAXY, kinds, {
      depth: 1,
      activeOnly: false,
      full: true,
    });
    expect(nodes.map((n) => n.index)).toEqual([50, 185, 273]);
  });

  it("dangling waypoint targets are never promoted to nodes or edges", () => {
    const dangling = planet({ index: 7, waypoints: [999], attacking: [] });
    const { nodes, edges } = buildSupplyGraph([dangling], new Map(), {
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
      new Map([[273, "liberation"]]),
      new Set([273]),
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
      new Map(),
      new Set(),
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
      buildGambitOrigins(quiet, byIndex([quiet]), new Map(), new Set()),
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
  it("default returns the active-campaign subgraph with observed edges, one KV put", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv); // active campaign on Sangis (273)
    forbidNetwork();

    const out = (await getSupplyGraph(env, {})) as Record<string, any>;

    expect(out.scope).toBe("active_campaign_subgraph");
    expect(out.nodes.map((n: any) => n.index)).toContain(273);
    expect(out.edge_count).toBe(out.edges.length);
    for (const e of out.edges) expect(e.observed).toBe(true);
    // Reuses the campaign loader → exactly one samples:planets write.
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(1);
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
