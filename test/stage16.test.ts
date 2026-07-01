/**
 * Stage 16 tests — Tier 2 of the next-features wave:
 *
 * Item 3: get_mo_pace / buildMoPace — observed vs required rate, side by side,
 * no verdict.
 * Item 4: isolation facts — soleHumanLinkDependents / buildIsolationRisk on
 * get_planet and per-node on the supply graph (the Karlia→Sangis case).
 * Item 5: get_gambits — the defense board with attack origins, facts only.
 * Item 6: get_war_diff / buildWarDiff — first-vs-last archive arithmetic.
 *
 * Pure builders tested directly; handlers ride the sanctioned stage6 KV-stub
 * pattern (raw cache pre-seeded, network forbidden) and a small in-memory D1
 * stub answering the window-edge queries (stage12 FakeD1 spirit).
 */
import { afterEach, describe, expect, it } from "vitest";

import type {
  GlobalArchiveRow,
  MoArchiveRow,
  PlanetArchiveRow,
} from "../src/archive";
import {
  buildIsolationRisk,
  buildMoPace,
  buildReverseAdjacency,
  buildSupplyGraph,
  buildWarDiff,
  shapeMajorOrders,
  soleHumanLinkDependents,
} from "../src/enrichment";
import { RAW_STATUS_PATH } from "../src/crosscheck";
import {
  campaignView,
  type CampaignProvenance,
  type CampaignView,
} from "../src/provenance";
import { getGambits, getMoPace, getPlanet, getWarDiff, ToolError } from "../src/tools";
import type { Env, RawAssignment, RawCampaign, RawPlanet } from "../src/types";
import type { MoObjectiveSeries } from "../src/sampling";

const HOUR = 3_600_000;

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
    endTime: new Date(Date.now() + 24 * HOUR).toISOString(),
    campaignId: 51602,
    ...over,
  } as RawPlanet["event"];
}

// The Karlia→Sangis shape: Karlia (Human) is Sangis's ONLY Human-owned
// neighbor; Sangis attacks Karlia's defense.
const KARLIA = planet({
  index: 185,
  name: "KARLIA",
  currentOwner: "Humans",
  waypoints: [273],
  event: defenseEvent(),
});
const SANGIS = planet({
  index: 273,
  name: "SANGIS",
  currentOwner: "Illuminate",
  health: 555_000,
  waypoints: [185],
  attacking: [185],
});
const ALATHFAR = planet({
  index: 50,
  name: "ALATHFAR IV",
  currentOwner: "Humans",
  waypoints: [185],
});
const GALAXY = [KARLIA, SANGIS, ALATHFAR];

function byIndex(planets: RawPlanet[]): Map<number, RawPlanet> {
  return new Map(planets.map((p) => [p.index, p]));
}

function assignment(over: Partial<RawAssignment> = {}): RawAssignment {
  return {
    id: 777,
    progress: [100],
    title: "MAJOR ORDER",
    briefing: null,
    description: null,
    // type 9 = complete_operations (cumulative); valueType 3 = goal.
    tasks: [{ type: 9, values: [1000], valueTypes: [3] }],
    reward: null,
    rewards: [],
    expiration: new Date(Date.now() + 45 * HOUR).toISOString(),
    flags: 0,
    ...over,
  } as RawAssignment;
}

/* ------------------------- item 3: MO pace ---------------------------- */

describe("buildMoPace (item 3)", () => {
  const NOW = Date.now();

  function shaped(a: RawAssignment) {
    return shapeMajorOrders([a], NOW)[0]!;
  }

  it("required_rate = remaining ÷ time_left for a cumulative objective at 10%", () => {
    const order = shaped(assignment());
    const [pace] = buildMoPace(order, []);
    expect(pace!.remaining).toBe(900);
    expect(pace!.time_left_hours).toBeCloseTo(45, 1);
    expect(pace!.required_rate_per_hour).toBeCloseTo(900 / pace!.time_left_hours!, 6);
    expect(pace!.required_rate_reason).toBeNull();
  });

  it("observed rates come from the sampled progress deltas (latest + mean)", () => {
    const order = shaped(assignment());
    const series: MoObjectiveSeries[] = [
      {
        major_order_id: 777,
        objective_index: 0,
        task_type: 9,
        samples: [
          { t: NOW - 4 * HOUR, progress: 60, target: 1000 },
          { t: NOW - 2 * HOUR, progress: 80, target: 1000 }, // +10/h
          { t: NOW, progress: 120, target: 1000 }, // +20/h
        ],
      },
    ];
    const [pace] = buildMoPace(order, series);
    expect(pace!.observed_rate_per_hour_latest).toBeCloseTo(20, 6);
    expect(pace!.observed_rate_per_hour_mean).toBeCloseTo(15, 6);
    expect(pace!.observed_rate_reason).toBeNull();
    expect(pace!.sample_count).toBe(3);
  });

  it("a hold_planet objective nulls both rates with the state reason", () => {
    const order = shaped(
      assignment({ tasks: [{ type: 13, values: [3], valueTypes: [3] }], progress: [2] }),
    );
    const [pace] = buildMoPace(order, []);
    expect(pace!.required_rate_per_hour).toBeNull();
    expect(pace!.required_rate_reason).toBe(
      "state_objective_progress_not_cumulative",
    );
    expect(pace!.observed_rate_per_hour_latest).toBeNull();
    expect(pace!.observed_rate_reason).toBe(
      "state_objective_progress_not_cumulative",
    );
    // The facts still ride: remaining/time_left are reported.
    expect(pace!.remaining).toBe(1);
  });

  it("an expired order nulls the required rate with order_expired, never divides", () => {
    const order = shaped(
      assignment({ expiration: new Date(NOW - HOUR).toISOString() }),
    );
    const [pace] = buildMoPace(order, []);
    expect(pace!.time_left_hours).toBe(0);
    expect(pace!.required_rate_per_hour).toBeNull();
    expect(pace!.required_rate_reason).toBe("order_expired");
  });

  it("no retained samples → insufficient_history, never 0", () => {
    const [pace] = buildMoPace(shaped(assignment()), []);
    expect(pace!.observed_rate_per_hour_latest).toBeNull();
    expect(pace!.observed_rate_per_hour_mean).toBeNull();
    expect(pace!.observed_rate_reason).toBe("insufficient_history");
  });

  it("prime-directive pin: no on-track/verdict key anywhere", () => {
    const [pace] = buildMoPace(shaped(assignment()), []);
    for (const k of Object.keys(pace!)) {
      expect(k).not.toMatch(/on_track|behind|forecast|verdict|recommend|will_/i);
    }
  });
});

/* ---------------------- item 4: isolation facts ----------------------- */

describe("soleHumanLinkDependents / buildIsolationRisk (item 4)", () => {
  const kinds = new Map<number, "liberation" | "defense">([
    [185, "defense"],
    [273, "liberation"],
  ]);

  it("Karlia is Sangis's sole Super Earth link — the Karlia→Sangis case", () => {
    const deps = soleHumanLinkDependents(
      185,
      byIndex(GALAXY),
      buildReverseAdjacency(GALAXY),
      cview(kinds),
    );
    expect(deps).toEqual([273]);
  });

  it("a second Human neighbor removes the sole-link dependency", () => {
    const otherHuman = planet({
      index: 60,
      name: "OTHER",
      currentOwner: "Humans",
      waypoints: [273], // a second observed Human link into Sangis
    });
    const galaxy = [...GALAXY, otherHuman];
    const deps = soleHumanLinkDependents(
      185,
      byIndex(galaxy),
      buildReverseAdjacency(galaxy),
      cview(kinds),
    );
    expect(deps).toEqual([]);
  });

  it("a non-Human planet has no dependents ([]), and an outage yields null", () => {
    expect(
      soleHumanLinkDependents(
        273,
        byIndex(GALAXY),
        buildReverseAdjacency(GALAXY),
        cview(kinds),
      ),
    ).toEqual([]);
    expect(
      soleHumanLinkDependents(
        185,
        byIndex(GALAXY),
        buildReverseAdjacency(GALAXY),
        cview(kinds, new Set(), "unavailable"),
      ),
    ).toBeNull();
  });

  it("buildIsolationRisk joins name and campaign kind; outage → null list, known false", () => {
    const block = buildIsolationRisk(
      KARLIA,
      byIndex(GALAXY),
      buildReverseAdjacency(GALAXY),
      cview(kinds),
    );
    expect(block).toEqual({
      planet_is_human_owned: true,
      campaign_state_known: true,
      dependent_active_campaigns: [
        { index: 273, name: "SANGIS", campaign_kind: "liberation" },
      ],
    });
    const outage = buildIsolationRisk(
      KARLIA,
      byIndex(GALAXY),
      buildReverseAdjacency(GALAXY),
      cview(kinds, new Set(), "unavailable"),
    );
    expect(outage.dependent_active_campaigns).toBeNull();
    expect(outage.campaign_state_known).toBe(false);
  });

  it("supply-graph nodes carry sole_link_dependents (null under outage)", () => {
    const { nodes } = buildSupplyGraph(GALAXY, cview(kinds), {
      depth: 1,
      activeOnly: false,
      full: true,
    });
    expect(nodes.find((n) => n.index === 185)?.sole_link_dependents).toEqual([
      273,
    ]);
    expect(nodes.find((n) => n.index === 273)?.sole_link_dependents).toEqual([]);
    const outage = buildSupplyGraph(GALAXY, cview(kinds, new Set(), "unavailable"), {
      depth: 1,
      activeOnly: false,
      full: true,
    });
    for (const n of outage.nodes) expect(n.sole_link_dependents).toBeNull();
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
  progress: [0],
  title: "MAJOR ORDER",
  briefing: null,
  description: null,
  tasks: [{ type: 11, values: [1, 1, 273], valueTypes: [3, 11, 12] }],
  reward: null,
  rewards: [],
  expiration: new Date(Date.now() + 48 * HOUR).toISOString(),
  flags: 0,
} as RawAssignment;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidNetwork(): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (() => {
    counter.calls += 1;
    throw new Error("network touched — the cache should have served this");
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
  /viable|recommend|priority|^rank$|verdict|should|optimal|winner|on_track|behind|forecast|can_liberate/i;

/* ------------------ item 4 acceptance: get_planet --------------------- */

describe("get_planet isolation_risk (item 4, cache-served)", () => {
  it("Karlia lists Sangis as the campaign that loses its warp link if Karlia falls", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    seedRaw(kv, "/api/v1/campaigns", [
      rawCampaign({ id: 51, planet: SANGIS, type: 0 }),
      rawCampaign({ id: 52, planet: KARLIA, type: 0 }),
    ]);
    seedRaw(kv, "/api/v1/assignments", [MO_ASSIGNMENT]);
    seedRaw(kv, RAW_STATUS_PATH, {});
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getPlanet(env, { index: 185 })) as Record<string, any>;
    expect(out.isolation_risk).toEqual({
      planet_is_human_owned: true,
      campaign_state_known: true,
      dependent_active_campaigns: [
        { index: 273, name: "SANGIS", campaign_kind: "liberation" },
      ],
    });
  });
});

/* --------------------- item 5: get_gambits ---------------------------- */

describe("get_gambits (item 5, cache-served)", () => {
  function seededEnv(kv: FakeKv): Env {
    seedRaw(kv, "/api/v1/planets", GALAXY);
    seedRaw(kv, "/api/v1/campaigns", [
      rawCampaign({ id: 52, planet: KARLIA, type: 0 }), // defense (event present)
      rawCampaign({ id: 51, planet: SANGIS, type: 0 }), // origin's liberation
    ]);
    seedRaw(kv, "/api/v1/assignments", [MO_ASSIGNMENT]);
    return { WAR_CACHE: kv as unknown as KVNamespace };
  }

  it("shows each defense with its origin's liberation state and MO membership; read-only", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    forbidNetwork();

    const out = (await getGambits(env)) as Record<string, any>;
    expect(out.campaign_state_known).toBe(true);
    expect(out.defense_count).toBe(1);
    const d = out.defenses[0];
    expect(d.planet_index).toBe(185);
    expect(d.attacker).toBe("Illuminate");
    const origin = d.gambit_origins[0];
    expect(origin.index).toBe(273);
    expect(origin.name).toBe("SANGIS");
    expect(origin.is_major_order_target).toBe(true); // joined against the live MO
    expect(origin.raw_hp).toBe(555_000);
    expect(origin.max_hp).toBe(1_000_000);
    // liberation % joined from the origin's own active campaign (invariant-2
    // display value): (1,000,000 − 555,000) / 1,000,000 × 100.
    expect(origin.liberation_pct_display_only).toBeCloseTo(44.5, 1);

    // READ-ONLY: no samples:planets put on any path.
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(0);

    // Facts only — no viability/verdict key anywhere.
    for (const k of collectKeys(out)) expect(k).not.toMatch(FORBIDDEN_KEYS);
  });

  it("campaign outage → defenses null (unknown, never an empty board) + stale", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY); // campaigns/assignments NOT seeded
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getGambits(env)) as Record<string, any>;
    expect(out.campaign_state_known).toBe(false);
    expect(out.defenses).toBeNull();
    expect(out.defense_count).toBeNull();
    expect(out.stale).toBe(true);
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(0);
  });
});

/* --------------------- item 3: get_mo_pace handler -------------------- */

describe("get_mo_pace handler (cache-served, read-only)", () => {
  it("serves pace blocks with zero KV writes", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/assignments", [assignment()]);
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    const out = (await getMoPace(env)) as Record<string, any>;
    expect(out.active).toBe(true);
    const pace = out.major_orders[0].objectives[0];
    expect(pace.required_rate_per_hour).toBeCloseTo(900 / pace.time_left_hours, 6);
    expect(pace.observed_rate_reason).toBe("insufficient_history");
    expect(kv.puts).toHaveLength(0);
    for (const k of collectKeys(out)) expect(k).not.toMatch(FORBIDDEN_KEYS);
  });

  it("no active MO → active false, not an error", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/assignments", []);
    forbidNetwork();
    const out = (await getMoPace({
      WAR_CACHE: kv as unknown as KVNamespace,
    })) as Record<string, any>;
    expect(out.active).toBe(false);
  });
});

/* ------------------------ item 6: war diff ---------------------------- */

describe("buildWarDiff (item 6, pure)", () => {
  const T0 = 1_780_000_000_000;
  const T1 = T0 + 24 * HOUR;

  const karliaFirst: PlanetArchiveRow = {
    planet_index: 185,
    sampled_at: T0,
    health: 100_000,
    max_health: 1_000_000,
    hp_per_hour: null,
    campaign_id: 52,
    campaign_kind: "defense",
    faction: "Humans",
  };
  const karliaLast: PlanetArchiveRow = {
    planet_index: 185,
    sampled_at: T1,
    health: 950_000,
    max_health: 1_000_000,
    hp_per_hour: null,
    campaign_id: 99,
    campaign_kind: "liberation",
    faction: "Illuminate",
  };

  it("lists the Karlia flip with before/after tracked factions and the campaign turnover", () => {
    const diff = buildWarDiff({
      planetFirst: [karliaFirst],
      planetLast: [karliaLast],
      moFirst: [],
      moLast: [],
      globalFirst: null,
      globalLast: null,
      planetNames: new Map([[185, "KARLIA"]]),
    });
    expect(diff.planets_changed).toHaveLength(1);
    const change = diff.planets_changed[0]!;
    expect(change.planet_name).toBe("KARLIA");
    expect(change.faction_changed).toBe(true);
    expect(change.first.faction).toBe("Humans");
    expect(change.last.faction).toBe("Illuminate");
    expect(change.campaign_kind_changed).toBe(true);
    expect(change.delta_health).toBe(850_000);
    expect(diff.campaigns_closed).toEqual([
      { planet_index: 185, planet_name: "KARLIA", campaign_id: 52, campaign_kind: "defense" },
    ]);
    expect(diff.campaigns_opened).toEqual([
      { planet_index: 185, planet_name: "KARLIA", campaign_id: 99, campaign_kind: "liberation" },
    ]);
    expect(diff.net_health_delta_by_faction).toEqual({
      Illuminate: { delta_health_sum: 850_000, planets_counted: 1 },
    });
  });

  it("MO progress and global counters diff as raw subtractions, null-propagating", () => {
    const moFirst: MoArchiveRow[] = [
      { major_order_id: 7, objective_index: 0, sampled_at: T0, progress: 10, target: 100 },
    ];
    const moLast: MoArchiveRow[] = [
      { major_order_id: 7, objective_index: 0, sampled_at: T1, progress: 40, target: 100 },
    ];
    const g = (t: number, players: number | null): GlobalArchiveRow => ({
      sampled_at: t,
      player_count: players,
      impact_multiplier: 1,
      active_campaign_count: 4,
      missions_won: 10,
      missions_lost: 2,
      deaths: 100,
      terminid_kills: 5,
      automaton_kills: 5,
      illuminate_kills: null,
    });
    const diff = buildWarDiff({
      planetFirst: [],
      planetLast: [],
      moFirst,
      moLast,
      globalFirst: g(T0, 40_000),
      globalLast: g(T1, null),
    });
    expect(diff.major_order_deltas[0]!.delta_progress).toBe(30);
    expect(diff.global.deltas!.delta_player_count).toBeNull(); // null is never 0
    expect(diff.global.deltas!.delta_missions_won).toBe(0);
    expect(diff.global.deltas!.delta_illuminate_kills).toBeNull();
  });

  it("health-only movement on an ongoing campaign is listed per-planet (health_changed)", () => {
    // Same campaign/faction across the window — only health moved.
    const ongoingLast: PlanetArchiveRow = {
      ...karliaFirst,
      sampled_at: T1,
      health: 60_000,
    };
    const diff = buildWarDiff({
      planetFirst: [karliaFirst],
      planetLast: [ongoingLast],
      moFirst: [],
      moLast: [],
      globalFirst: null,
      globalLast: null,
      planetNames: new Map([[185, "KARLIA"]]),
    });
    expect(diff.planets_changed).toHaveLength(1);
    const change = diff.planets_changed[0]!;
    expect(change.health_changed).toBe(true);
    expect(change.faction_changed).toBe(false);
    expect(change.campaign_id_changed).toBe(false);
    expect(change.delta_health).toBe(-40_000);
    // An unchanged planet (identical rows apart from time) is NOT listed.
    const still = buildWarDiff({
      planetFirst: [karliaFirst],
      planetLast: [{ ...karliaFirst, sampled_at: T1 }],
      moFirst: [],
      moLast: [],
      globalFirst: null,
      globalLast: null,
    });
    expect(still.planets_changed).toHaveLength(0);
    expect(still.subjects_with_two_observations).toBe(1);
  });

  it("a single-observation window computes no deltas and reports zero two-observation subjects", () => {
    // One sample in the window: both edge reads return the SAME row.
    const diff = buildWarDiff({
      planetFirst: [karliaFirst],
      planetLast: [karliaFirst],
      moFirst: [
        { major_order_id: 7, objective_index: 0, sampled_at: T0, progress: 10, target: 100 },
      ],
      moLast: [
        { major_order_id: 7, objective_index: 0, sampled_at: T0, progress: 10, target: 100 },
      ],
      globalFirst: null,
      globalLast: null,
    });
    expect(diff.subjects_with_two_observations).toBe(0);
    expect(diff.planets_changed).toHaveLength(0);
    expect(diff.major_order_deltas).toHaveLength(0);
  });

  it("the Karlia flip counts as a two-observation subject", () => {
    const diff = buildWarDiff({
      planetFirst: [karliaFirst],
      planetLast: [karliaLast],
      moFirst: [],
      moLast: [],
      globalFirst: null,
      globalLast: null,
    });
    expect(diff.subjects_with_two_observations).toBe(1);
  });

  it("a planet observed only at one edge is membership, not a change", () => {
    const diff = buildWarDiff({
      planetFirst: [],
      planetLast: [karliaLast],
      moFirst: [],
      moLast: [],
      globalFirst: null,
      globalLast: null,
    });
    expect(diff.planets_changed).toHaveLength(0);
    expect(diff.planets_first_observed[0]!.planet_index).toBe(185);
    expect(diff.campaigns_opened[0]!.campaign_id).toBe(99);
  });
});

/* -------------- item 6: getWarDiff handler over a D1 stub ------------- */

interface AnyRow {
  id: number;
  sampled_at: number;
  [k: string]: number | string | null;
}

/** Answers the window-edge queries: GROUP BY with a single MIN/MAX aggregate
 * (bare columns from the min/max row — the documented SQLite semantics),
 * ORDER-BY-LIMIT-1 global edges, and the coverage MIN/MAX. */
class EdgeFakeD1 {
  rows: Record<string, AnyRow[]> = {
    global_samples: [],
    planet_samples: [],
    mo_progress_samples: [],
  };
  sqls: string[] = [];

  prepare(sql: string) {
    const db = this;
    let binds: unknown[] = [];
    const table = (sql.match(/FROM (\w+)/) ?? [])[1] ?? "";
    const exec = (): AnyRow[] => {
      db.sqls.push(sql);
      let rows = db.rows[table] ?? [];
      if (sql.includes("AS earliest")) {
        const ts = rows.map((r) => r.sampled_at);
        return [
          {
            earliest: ts.length ? Math.min(...ts) : null,
            latest: ts.length ? Math.max(...ts) : null,
          } as unknown as AnyRow,
        ];
      }
      const b = [...binds];
      if (sql.includes("sampled_at >=")) {
        const since = b.shift() as number;
        const until = b.shift() as number;
        rows = rows.filter((r) => r.sampled_at >= since && r.sampled_at <= until);
      }
      const groupBy = sql.match(/GROUP BY (.+)$/);
      if (groupBy) {
        const keys = groupBy[1]!.split(",").map((s) => s.trim());
        const agg = sql.includes("MIN(sampled_at)") ? "min" : "max";
        const groups = new Map<string, AnyRow>();
        for (const r of rows) {
          const key = keys.map((k) => r[k]).join("|");
          const cur = groups.get(key);
          if (
            !cur ||
            (agg === "min"
              ? r.sampled_at < cur.sampled_at
              : r.sampled_at > cur.sampled_at)
          ) {
            groups.set(key, r);
          }
        }
        return [...groups.values()];
      }
      if (sql.includes("LIMIT 1")) {
        const sorted = [...rows].sort((x, y) =>
          sql.includes("DESC")
            ? y.sampled_at - x.sampled_at
            : x.sampled_at - y.sampled_at,
        );
        return sorted.slice(0, 1);
      }
      return rows;
    };
    return {
      bind(...vals: unknown[]) {
        binds = vals;
        return this;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: exec() as unknown as T[] };
      },
      async first<T>(): Promise<T | null> {
        return (exec()[0] ?? null) as unknown as T;
      },
    };
  }
}

describe("getWarDiff handler (item 6)", () => {
  it("diffs a seeded owner flip from the archive, joining names from the cached planets list", async () => {
    const db = new EdgeFakeD1();
    const base = Date.now();
    db.rows.planet_samples = [
      {
        id: 1,
        sampled_at: base - 20 * HOUR,
        planet_index: 185,
        health: 100_000,
        max_health: 1_000_000,
        hp_per_hour: null,
        campaign_id: 52,
        campaign_kind: "defense",
        faction: "Humans",
      },
      {
        id: 2,
        sampled_at: base - 10 * HOUR,
        planet_index: 185,
        health: 500_000,
        max_health: 1_000_000,
        hp_per_hour: null,
        campaign_id: 52,
        campaign_kind: "defense",
        faction: "Humans",
      },
      {
        id: 3,
        sampled_at: base - 1 * HOUR,
        planet_index: 185,
        health: 950_000,
        max_health: 1_000_000,
        hp_per_hour: null,
        campaign_id: 99,
        campaign_kind: "liberation",
        faction: "Illuminate",
      },
    ];
    db.rows.global_samples = [
      {
        id: 1,
        sampled_at: base - 20 * HOUR,
        player_count: 40_000,
        impact_multiplier: 1,
        active_campaign_count: 3,
        missions_won: 10,
        missions_lost: 1,
        deaths: 5,
        terminid_kills: 1,
        automaton_kills: 1,
        illuminate_kills: 1,
      },
      {
        id: 2,
        sampled_at: base - 1 * HOUR,
        player_count: 55_000,
        impact_multiplier: 1,
        active_campaign_count: 4,
        missions_won: 20,
        missions_lost: 2,
        deaths: 9,
        terminid_kills: 2,
        automaton_kills: 2,
        illuminate_kills: 2,
      },
    ];
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/planets", GALAXY);
    const env: Env = {
      WAR_CACHE: kv as unknown as KVNamespace,
      HISTORY_DB: db as unknown as Env["HISTORY_DB"],
    };
    forbidNetwork();

    const out = (await getWarDiff(env, { since_hours: 24 })) as Record<string, any>;
    expect(out.insufficient_history).toBe(false);
    expect(out.planets_changed).toHaveLength(1);
    expect(out.planets_changed[0].planet_name).toBe("KARLIA");
    expect(out.planets_changed[0].first.faction).toBe("Humans");
    expect(out.planets_changed[0].last.faction).toBe("Illuminate");
    expect(out.campaigns_opened[0].campaign_id).toBe(99);
    expect(out.global.deltas.delta_player_count).toBe(15_000);
    // Read-only on KV.
    expect(kv.puts).toHaveLength(0);
    for (const k of collectKeys(out)) expect(k).not.toMatch(FORBIDDEN_KEYS);
  });

  it("a window holding a SINGLE tick is insufficient_history, never an apparently-valid empty diff", async () => {
    const db = new EdgeFakeD1();
    const base = Date.now();
    // Exactly one archived tick inside the window.
    db.rows.planet_samples = [
      {
        id: 1,
        sampled_at: base - 2 * HOUR,
        planet_index: 185,
        health: 100_000,
        max_health: 1_000_000,
        hp_per_hour: null,
        campaign_id: 52,
        campaign_kind: "defense",
        faction: "Humans",
      },
    ];
    db.rows.global_samples = [
      {
        id: 1,
        sampled_at: base - 2 * HOUR,
        player_count: 40_000,
        impact_multiplier: 1,
        active_campaign_count: 3,
        missions_won: 10,
        missions_lost: 1,
        deaths: 5,
        terminid_kills: 1,
        automaton_kills: 1,
        illuminate_kills: 1,
      },
    ];
    forbidNetwork();
    const out = (await getWarDiff(
      { HISTORY_DB: db as unknown as Env["HISTORY_DB"] },
      { since_hours: 24 },
    )) as Record<string, any>;
    expect(out.subjects_with_two_observations).toBe(0);
    expect(out.insufficient_history).toBe(true);
    expect(out.note).toMatch(/no subject has TWO distinct/i);
  });

  it("empty archive → insufficient_history with a non-error note", async () => {
    const env: Env = {
      HISTORY_DB: new EdgeFakeD1() as unknown as Env["HISTORY_DB"],
    };
    forbidNetwork();
    const out = (await getWarDiff(env, { since_hours: 24 })) as Record<string, any>;
    expect(out.insufficient_history).toBe(true);
    expect(out.note).toBeTruthy();
    expect(out.planet_names_joined).toBe(false); // planets fetch degraded, not an error
  });

  it("rejects an inverted window loudly", async () => {
    const env: Env = {
      HISTORY_DB: new EdgeFakeD1() as unknown as Env["HISTORY_DB"],
    };
    await expect(
      getWarDiff(env, { since_hours: 10, until_hours: 20 }),
    ).rejects.toThrow(ToolError);
  });
});
