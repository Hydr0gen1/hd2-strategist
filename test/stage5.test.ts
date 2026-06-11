/**
 * Stage 5 tests: the passive accumulation layer (observed signatures +
 * global statistics series) folded into the single per-poll KV write,
 * neighbor context on get_planet, observed-only history aggregates, Major
 * Order joins, and faction/sector rollups. Pure throughout, except the
 * sanctioned in-memory-KV test of samplePlanetRates proving the one-write
 * budget (no fetch involved — the function does no network I/O).
 */
import { describe, expect, it } from "vitest";

import {
  SAMPLES_KEY_TTL_SECONDS,
  samplePlanetRates,
} from "../src/client";
import {
  buildFactionRollup,
  buildGlobalHistoryPoints,
  buildNeighbors,
  buildSectorRollup,
  historyRateAggregates,
  moPlanetAssignmentMap,
  shapeObservedSignatures,
  TASK_VALUE_TYPE_PLANET,
} from "../src/enrichment";
import {
  MAX_GLOBAL_SAMPLES,
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLES_PER_PLANET,
  MAX_SIGNATURES,
  MIN_SAMPLE_INTERVAL_MS,
  advanceGlobalSeries,
  coerceStore,
  foldSignatures,
  type GlobalSample,
  type HealthSample,
  type ObservedSignature,
  type SampleStore,
  type SignatureObservation,
} from "../src/sampling";
import type {
  Env,
  PlanetStatistics,
  RawAssignment,
  RawPlanet,
  RawStatistics,
} from "../src/types";

const HOUR_MS = 3_600_000;
const NOW = 1_780_000_000_000;

function obs(
  overrides: Partial<SignatureObservation> = {},
): SignatureObservation {
  return {
    campaign_type: 0,
    event_type: null,
    has_event: false,
    faction: "Terminids",
    ...overrides,
  };
}

function stats(overrides: Partial<RawStatistics> = {}): RawStatistics {
  return {
    missionsWon: 100,
    missionsLost: 20,
    missionSuccessRate: 83,
    terminidKills: 1_000,
    automatonKills: 2_000,
    illuminateKills: 3_000,
    deaths: 500,
    playerCount: 40_000,
    accuracy: 50,
    ...overrides,
  };
}

/* ====================================================================== *
 * Part A — foldSignatures
 * ====================================================================== */

describe("foldSignatures: passive signature accumulation", () => {
  it("appends a new tuple with first_seen = last_seen = now, sample_count 1", () => {
    const out = foldSignatures(undefined, [obs()], NOW);
    expect(out).toEqual([
      {
        campaign_type: 0,
        event_type: null,
        has_event: false,
        faction: "Terminids",
        first_seen: NOW,
        last_seen: NOW,
        sample_count: 1,
      },
    ]);
  });

  it("bumps last_seen and sample_count for a known tuple past the 60s guard", () => {
    const seeded = foldSignatures(undefined, [obs()], NOW);
    const later = NOW + MIN_SAMPLE_INTERVAL_MS;
    const out = foldSignatures(seeded, [obs()], later);
    expect(out).toHaveLength(1);
    expect(out[0]!.first_seen).toBe(NOW);
    expect(out[0]!.last_seen).toBe(later);
    expect(out[0]!.sample_count).toBe(2);
  });

  it("does NOT bump within the 60s guard — cache replays can't inflate counts", () => {
    const seeded = foldSignatures(undefined, [obs()], NOW);
    const out = foldSignatures(seeded, [obs()], NOW + 5_000);
    expect(out[0]!.last_seen).toBe(NOW);
    expect(out[0]!.sample_count).toBe(1);
  });

  it("dedupes observations within one cycle: many campaigns, one tuple, one observation", () => {
    const out = foldSignatures(undefined, [obs(), obs(), obs()], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.sample_count).toBe(1);
  });

  it("a missing field is recorded as null inside the tuple, and null is a distinct identity", () => {
    const withNull = obs({ campaign_type: null });
    const withZero = obs({ campaign_type: 0 });
    const out = foldSignatures(undefined, [withNull, withZero], NOW);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.campaign_type).sort()).toEqual([0, null].sort());
  });

  it("captures a special-faction event signature distinctly from the plain tuple", () => {
    const plain = obs();
    const event = obs({ event_type: 7, has_event: true, faction: "Automaton" });
    const out = foldSignatures(undefined, [plain, event], NOW);
    expect(out).toHaveLength(2);
    const captured = out.find((s) => s.event_type === 7)!;
    expect(captured.has_event).toBe(true);
    expect(captured.first_seen).toBe(NOW);
  });

  it("an empty observation set returns the existing record unchanged", () => {
    const seeded = foldSignatures(undefined, [obs()], NOW);
    expect(foldSignatures(seeded, [], NOW + HOUR_MS)).toBe(seeded);
  });

  it("growth is capped at MAX_SIGNATURES, evicting the oldest last_seen", () => {
    let acc: ObservedSignature[] | undefined;
    for (let i = 0; i < MAX_SIGNATURES + 10; i++) {
      acc = foldSignatures(
        acc,
        [obs({ campaign_type: i })],
        NOW + i * MIN_SAMPLE_INTERVAL_MS,
      );
    }
    expect(acc).toHaveLength(MAX_SIGNATURES);
    // The 10 oldest (campaign_type 0..9) were evicted.
    const types = new Set(acc!.map((s) => s.campaign_type));
    expect(types.has(0)).toBe(false);
    expect(types.has(9)).toBe(false);
    expect(types.has(10)).toBe(true);
    expect(types.has(MAX_SIGNATURES + 9)).toBe(true);
  });
});

/* ====================================================================== *
 * Part E — advanceGlobalSeries
 * ====================================================================== */

describe("advanceGlobalSeries: global statistics ring buffer", () => {
  it("null stats (a poll that never fetched the war) leaves the series untouched", () => {
    const existing: GlobalSample[] = [
      { t: NOW, player_count: 1, missions_won: 2, missions_lost: 3, deaths: 4, terminid_kills: 5, automaton_kills: 6, illuminate_kills: 7 },
    ];
    expect(advanceGlobalSeries(existing, null, NOW + HOUR_MS)).toBe(existing);
    expect(advanceGlobalSeries(undefined, undefined, NOW)).toEqual([]);
  });

  it("seeds the first sample from a stats object with all fields recorded", () => {
    const out = advanceGlobalSeries(undefined, stats(), NOW);
    expect(out).toEqual([
      {
        t: NOW,
        player_count: 40_000,
        missions_won: 100,
        missions_lost: 20,
        deaths: 500,
        terminid_kills: 1_000,
        automaton_kills: 2_000,
        illuminate_kills: 3_000,
        // Stage 11: co-sampled extras not supplied here → null, never 0.
        impact_multiplier: null,
        active_campaign_count: null,
      },
    ]);
  });

  it("does not append while the tail is younger than MIN_SAMPLE_INTERVAL_MS", () => {
    const seeded = advanceGlobalSeries(undefined, stats(), NOW);
    const out = advanceGlobalSeries(seeded, stats(), NOW + 5_000);
    expect(out).toBe(seeded);
  });

  it("missing upstream fields are null at that point — never 0", () => {
    const partial = {
      missionsWon: 100,
      missionsLost: 20,
    } as unknown as RawStatistics;
    const out = advanceGlobalSeries(undefined, partial, NOW);
    expect(out[0]!.player_count).toBeNull();
    expect(out[0]!.deaths).toBeNull();
    expect(out[0]!.missions_won).toBe(100);
  });

  it("bounded by MAX_GLOBAL_SAMPLES and MAX_SAMPLE_AGE_MS; newest always survives", () => {
    let series: GlobalSample[] | undefined;
    for (let i = 0; i < MAX_GLOBAL_SAMPLES + 20; i++) {
      series = advanceGlobalSeries(
        series,
        stats({ playerCount: i }),
        NOW + i * MIN_SAMPLE_INTERVAL_MS,
      );
    }
    expect(series!.length).toBeLessThanOrEqual(MAX_GLOBAL_SAMPLES);
    expect(series![series!.length - 1]!.player_count).toBe(
      MAX_GLOBAL_SAMPLES + 19,
    );

    // Age eviction: a sample older than the window drops on next append.
    const stale: GlobalSample[] = [
      { t: NOW - MAX_SAMPLE_AGE_MS - 1, player_count: 1, missions_won: null, missions_lost: null, deaths: null, terminid_kills: null, automaton_kills: null, illuminate_kills: null },
    ];
    const out = advanceGlobalSeries(stale, stats(), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.t).toBe(NOW);
  });
});

/* ====================================================================== *
 * Store coercion round-trip (back-compat with pre-Stage-5 stores)
 * ====================================================================== */

describe("coerceStore: Stage 5 sections", () => {
  it("a pre-Stage-5 store coerces WITHOUT signatures/global keys", () => {
    const out = coerceStore({ planets: {}, campaignsFirstSeen: {} });
    expect("signatures" in out).toBe(false);
    expect("global" in out).toBe(false);
  });

  it("round-trips stored signatures and global samples", () => {
    const signatures = foldSignatures(undefined, [obs()], NOW);
    const global = advanceGlobalSeries(undefined, stats(), NOW);
    const out = coerceStore(
      JSON.parse(
        JSON.stringify({
          planets: {},
          campaignsFirstSeen: {},
          signatures,
          global,
        }),
      ),
    );
    expect(out.signatures).toEqual(signatures);
    expect(out.global).toEqual(global);
  });

  it("drops garbage entries (no finite timestamps) instead of throwing", () => {
    const out = coerceStore({
      planets: {},
      campaignsFirstSeen: {},
      signatures: [{ campaign_type: 0 }, "junk", null],
      global: [{ player_count: 5 }, 42],
    });
    expect(out.signatures).toEqual([]);
    expect(out.global).toEqual([]);
  });
});

/* ====================================================================== *
 * Folded write: one KV put per samplePlanetRates call (in-memory KV stub)
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

function envWith(kv: FakeKv | null): Env {
  return kv ? { WAR_CACHE: kv as unknown as KVNamespace } : {};
}

describe("samplePlanetRates: accumulation layers ride the single existing write", () => {
  const INPUTS = [{ planetIndex: 175, health: 600_000, campaignId: 42 }];

  it("exactly ONE put per call, on samples:planets, containing folded signatures + global", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW, {
      signatures: [obs()],
      globalStatistics: stats(),
    });
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]!.key).toBe("samples:planets");
    expect(kv.puts[0]!.ttl).toBe(SAMPLES_KEY_TTL_SECONDS);
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(stored.signatures).toHaveLength(1);
    expect(stored.signatures![0]!.first_seen).toBe(NOW);
    expect(stored.global).toHaveLength(1);
    expect(stored.global![0]!.player_count).toBe(40_000);
    expect(stored.planets["175"]).toBeDefined();
  });

  it("a repeat tuple on a later cycle bumps last_seen/sample_count — still one put per cycle", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW, { signatures: [obs()] });
    await samplePlanetRates(
      envWith(kv),
      INPUTS,
      NOW + 2 * MIN_SAMPLE_INTERVAL_MS,
      { signatures: [obs()] },
    );
    expect(kv.puts).toHaveLength(2); // two cycles, one put each — never more
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(stored.signatures).toHaveLength(1);
    expect(stored.signatures![0]!.sample_count).toBe(2);
    expect(stored.signatures![0]!.first_seen).toBe(NOW);
  });

  it("the batch poll (no carryForward) PRESERVES accumulation layers while rebuilding planets", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW, {
      signatures: [obs()],
      globalStatistics: stats(),
    });
    // Next batch: different planet set, no signature/global inputs at all.
    await samplePlanetRates(
      envWith(kv),
      [{ planetIndex: 9, health: 1_000, campaignId: 7 }],
      NOW + 2 * MIN_SAMPLE_INTERVAL_MS,
    );
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(stored.planets["175"]).toBeUndefined(); // planet semantics unchanged
    expect(stored.signatures).toHaveLength(1); // accumulation carried forward
    expect(stored.global).toHaveLength(1);
  });

  it("a single-planet probe (carryForward, no opts) preserves both layers byte-identically", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW, {
      signatures: [obs()],
      globalStatistics: stats(),
    });
    const before = JSON.parse(
      kv.store.get("samples:planets")!,
    ) as SampleStore;
    await samplePlanetRates(
      envWith(kv),
      [{ planetIndex: 64, health: 500, campaignId: null }],
      NOW + 2 * MIN_SAMPLE_INTERVAL_MS,
      { carryForward: true },
    );
    const after = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(after.signatures).toEqual(before.signatures);
    expect(after.global).toEqual(before.global);
    expect(after.planets["175"]).toBeDefined(); // probe carried planets too
  });

  it("a store without accumulation data stays free of empty sections", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW);
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect("signatures" in stored).toBe(false);
    expect("global" in stored).toBe(false);
  });

  it("no KV binding → no throw, rates still computed", async () => {
    const results = await samplePlanetRates(envWith(null), INPUTS, NOW, {
      signatures: [obs()],
      globalStatistics: stats(),
    });
    expect(results.get(175)!.hpPerHour).toBeNull(); // cold start
  });
});

/* ====================================================================== *
 * Part D — Major Order joins
 * ====================================================================== */

function assignment(
  id: number,
  planetIndices: number[],
  extraTask?: { values: number[]; valueTypes: number[] },
): RawAssignment {
  return {
    id,
    progress: [],
    title: null,
    briefing: null,
    description: null,
    tasks: [
      {
        type: 11,
        values: planetIndices,
        valueTypes: planetIndices.map(() => TASK_VALUE_TYPE_PLANET),
      },
      ...(extraTask ? [{ type: 3, ...extraTask }] : []),
    ],
    reward: null,
    rewards: [],
    expiration: "2026-06-12T00:00:00Z",
    flags: 0,
  };
}

describe("moPlanetAssignmentMap: planet → assignment id join", () => {
  it("maps each MO task planet to its assignment id; non-planet valueTypes ignored", () => {
    const map = moPlanetAssignmentMap([
      assignment(900, [175, 64], { values: [3], valueTypes: [1] }),
    ]);
    expect(map.get(175)).toBe(900);
    expect(map.get(64)).toBe(900);
    expect(map.has(3)).toBe(false);
    expect(map.size).toBe(2);
  });

  it("first assignment wins when a planet appears in several (deterministic)", () => {
    const map = moPlanetAssignmentMap([
      assignment(900, [175]),
      assignment(901, [175, 64]),
    ]);
    expect(map.get(175)).toBe(900);
    expect(map.get(64)).toBe(901);
  });

  it("parity: new Set(map.keys()) matches the legacy MO planet set derivation", () => {
    const assignments = [
      assignment(900, [175, 64], { values: [99], valueTypes: [1] }),
      assignment(901, [12]),
    ];
    // Verbatim legacy moPlanetIndicesFrom logic (pre-Stage-5 tools.ts).
    const legacy = new Set<number>();
    for (const a of assignments) {
      for (const task of a.tasks ?? []) {
        const types = task.valueTypes ?? [];
        const values = task.values ?? [];
        for (let i = 0; i < types.length; i++) {
          if (types[i] === TASK_VALUE_TYPE_PLANET && values[i] != null) {
            legacy.add(values[i]!);
          }
        }
      }
    }
    expect(new Set(moPlanetAssignmentMap(assignments).keys())).toEqual(legacy);
  });
});

/* ====================================================================== *
 * Part B — neighbors on get_planet
 * ====================================================================== */

function makePlanet(overrides: Partial<RawPlanet> = {}): RawPlanet {
  return {
    index: 175,
    name: "GRAND ERRANT",
    sector: "SEVIN",
    maxHealth: 1_000_000,
    health: 600_000,
    disabled: false,
    initialOwner: "Humans",
    currentOwner: "Humans",
    regenPerSecond: 2.78,
    event: null,
    attacking: [],
    waypoints: [],
    statistics: null,
    biome: null,
    hazards: null,
    ...overrides,
  };
}

describe("buildNeighbors: waypoint join + factual adjacency", () => {
  const home = makePlanet({ waypoints: [1, 2, 3] });
  const byIndex = new Map<number, RawPlanet>([
    [1, makePlanet({ index: 1, name: "ALPHA", currentOwner: "Humans" })],
    [2, makePlanet({ index: 2, name: "BETA", currentOwner: "Terminids" })],
    // index 3 deliberately missing — a dangling waypoint.
  ]);
  const kinds = new Map<number, "liberation" | "defense">([
    [2, "liberation"],
  ]);

  it("joins name/owner/campaign per waypoint, in upstream order", () => {
    const { neighbors } = buildNeighbors(home, byIndex, kinds);
    expect(neighbors).toEqual([
      { index: 1, name: "ALPHA", owner: "Humans", has_active_campaign: false, campaign_kind: null },
      { index: 2, name: "BETA", owner: "Terminids", has_active_campaign: true, campaign_kind: "liberation" },
      { index: 3, name: null, owner: null, has_active_campaign: false, campaign_kind: null },
    ]);
  });

  it("summary counts include the dangling neighbor in total and the unknown bucket", () => {
    const { neighbor_summary } = buildNeighbors(home, byIndex, kinds);
    expect(neighbor_summary).toEqual({
      total: 3,
      by_owner: { Humans: 1, Terminids: 1, unknown: 1 },
      with_active_campaign: 1,
    });
  });

  it("frontline is true iff a neighbor with a KNOWN owner differs from the planet's owner", () => {
    expect(buildNeighbors(home, byIndex, kinds).frontline).toBe(true);

    const interior = makePlanet({ waypoints: [1] });
    expect(buildNeighbors(interior, byIndex, kinds).frontline).toBe(false);

    // An unknown (dangling) owner never makes a planet frontline.
    const onlyDangling = makePlanet({ waypoints: [3] });
    expect(buildNeighbors(onlyDangling, byIndex, kinds).frontline).toBe(false);
  });

  it("no waypoints → empty neighbors, zeroed summary, frontline false", () => {
    const out = buildNeighbors(makePlanet(), byIndex, kinds);
    expect(out.neighbors).toEqual([]);
    expect(out.neighbor_summary).toEqual({
      total: 0,
      by_owner: { unknown: 0 },
      with_active_campaign: 0,
    });
    expect(out.frontline).toBe(false);
  });
});

/* ====================================================================== *
 * Part C — observed-only history aggregates
 * ====================================================================== */

describe("historyRateAggregates: plain stats over per-interval observed rates", () => {
  it("exact min/max/mean/latest over a known series, hp_per_hour sign convention", () => {
    // Rates: (1000-900)/1h = +100; (900-950)/1h = -50; (950-800)/2h = +75.
    const samples: HealthSample[] = [
      { h: 1_000, t: 0 },
      { h: 900, t: HOUR_MS },
      { h: 950, t: 2 * HOUR_MS },
      { h: 800, t: 4 * HOUR_MS },
    ];
    const out = historyRateAggregates(samples);
    expect(out.rate_min).toBe(-50);
    expect(out.rate_max).toBe(100);
    expect(out.rate_mean).toBeCloseTo((100 - 50 + 75) / 3, 10);
    expect(out.latest_rate).toBe(75);
    expect(out.samples_span_hours).toBe(4);
  });

  it("fewer than 2 points → all aggregates null (insufficient-history honesty)", () => {
    expect(historyRateAggregates([])).toEqual({
      rate_min: null,
      rate_max: null,
      rate_mean: null,
      latest_rate: null,
      samples_span_hours: null,
    });
    expect(historyRateAggregates([{ h: 1, t: NOW }]).rate_mean).toBeNull();
  });

  it("a single usable pair: min = max = mean = latest", () => {
    const out = historyRateAggregates([
      { h: 1_000, t: 0 },
      { h: 900, t: HOUR_MS },
    ]);
    expect(out.rate_min).toBe(100);
    expect(out.rate_max).toBe(100);
    expect(out.rate_mean).toBe(100);
    expect(out.latest_rate).toBe(100);
    expect(out.samples_span_hours).toBe(1);
  });

  it("non-positive time deltas (legacy-store artifacts) are skipped, never divided", () => {
    const out = historyRateAggregates([
      { h: 1_000, t: HOUR_MS },
      { h: 900, t: HOUR_MS }, // Δt = 0 — skipped
      { h: 800, t: 2 * HOUR_MS }, // (900-800)/1h = +100
    ]);
    expect(out.rate_min).toBe(100);
    expect(out.rate_max).toBe(100);
    expect(Number.isFinite(out.rate_mean!)).toBe(true);
  });

  it("emits no trend/forecast field — observed aggregates only", () => {
    const keys = Object.keys(
      historyRateAggregates([
        { h: 1_000, t: 0 },
        { h: 900, t: HOUR_MS },
      ]),
    ).sort();
    expect(keys).toEqual(
      [
        "latest_rate",
        "rate_max",
        "rate_mean",
        "rate_min",
        "samples_span_hours",
      ].sort(),
    );
  });
});

/* ====================================================================== *
 * Part E — global history points
 * ====================================================================== */

describe("buildGlobalHistoryPoints: raw observed deltas", () => {
  it("first point null deltas; later points exact consecutive differences", () => {
    const a = advanceGlobalSeries(undefined, stats(), NOW);
    const b = advanceGlobalSeries(
      a,
      stats({ playerCount: 41_500, missionsWon: 130, deaths: 650 }),
      NOW + HOUR_MS,
    );
    const points = buildGlobalHistoryPoints(b);
    expect(points[0]!.delta_player_count).toBeNull();
    expect(points[0]!.delta_hours).toBeNull();
    expect(points[1]!.delta_hours).toBe(1);
    expect(points[1]!.delta_player_count).toBe(1_500);
    expect(points[1]!.delta_missions_won).toBe(30);
    expect(points[1]!.delta_deaths).toBe(150);
  });

  it("a null end at either side makes the delta null — missing is never 0", () => {
    const series: GlobalSample[] = [
      { t: NOW, player_count: null, missions_won: 10, missions_lost: null, deaths: 1, terminid_kills: null, automaton_kills: null, illuminate_kills: null },
      { t: NOW + HOUR_MS, player_count: 40_000, missions_won: null, missions_lost: 5, deaths: 3, terminid_kills: null, automaton_kills: null, illuminate_kills: null },
    ];
    const points = buildGlobalHistoryPoints(series);
    expect(points[1]!.delta_player_count).toBeNull(); // prev null
    expect(points[1]!.delta_missions_won).toBeNull(); // cur null
    expect(points[1]!.delta_missions_lost).toBeNull(); // prev null
    expect(points[1]!.delta_deaths).toBe(2);
  });

  it("negative deltas (counter reset) are passed through as observed", () => {
    const series: GlobalSample[] = [
      { t: NOW, player_count: 50_000, missions_won: null, missions_lost: null, deaths: null, terminid_kills: null, automaton_kills: null, illuminate_kills: null },
      { t: NOW + HOUR_MS, player_count: 30_000, missions_won: null, missions_lost: null, deaths: null, terminid_kills: null, automaton_kills: null, illuminate_kills: null },
    ];
    expect(buildGlobalHistoryPoints(series)[1]!.delta_player_count).toBe(
      -20_000,
    );
  });
});

/* ====================================================================== *
 * Part A — signature shaping
 * ====================================================================== */

describe("shapeObservedSignatures: newest last_seen first + ISO renderings", () => {
  it("sorts newest last_seen first and renders both timestamps as ISO", () => {
    const sigs: ObservedSignature[] = [
      { ...obs({ campaign_type: 1 }), first_seen: NOW, last_seen: NOW, sample_count: 1 },
      { ...obs({ campaign_type: 2 }), first_seen: NOW, last_seen: NOW + HOUR_MS, sample_count: 3 },
    ];
    const out = shapeObservedSignatures(sigs);
    expect(out.map((s) => s.campaign_type)).toEqual([2, 1]);
    expect(out[0]!.last_seen_at).toBe(new Date(NOW + HOUR_MS).toISOString());
    expect(out[1]!.first_seen_at).toBe(new Date(NOW).toISOString());
    expect(out[0]!.sample_count).toBe(3);
  });
});

/* ====================================================================== *
 * Part F — faction & sector rollups
 * ====================================================================== */

function rollupCampaign(
  faction: string,
  planetIndex: number,
  playerCount: number | null,
): { faction: string; planet_index: number; statistics: PlanetStatistics | null } {
  return {
    faction,
    planet_index: planetIndex,
    statistics:
      playerCount === null
        ? null
        : {
            player_count: playerCount,
            mission_wins: null,
            mission_losses: null,
            mission_success_rate: null,
            kills: { terminid: null, automaton: null, illuminate: null },
          },
  };
}

describe("buildFactionRollup: deterministic counts, echoed rates, null-honesty", () => {
  const planets = [
    makePlanet({ index: 0, currentOwner: "Humans" }),
    makePlanet({ index: 1, currentOwner: "Humans" }),
    makePlanet({ index: 2, currentOwner: "Terminids" }),
    makePlanet({ index: 3, currentOwner: "Automaton" }),
  ];
  const campaigns = [
    rollupCampaign("Terminids", 2, 12_000),
    rollupCampaign("Terminids", 9, null),
    rollupCampaign("Automaton", 3, 8_000),
  ];

  it("counts planets_owned by currentOwner and active_campaigns by campaign faction", () => {
    const out = buildFactionRollup(planets, campaigns, new Map());
    expect(out.Humans!.planets_owned).toBe(2);
    expect(out.Humans!.active_campaigns).toBe(0);
    expect(out.Terminids!.planets_owned).toBe(1);
    expect(out.Terminids!.active_campaigns).toBe(2);
    expect(out.Automaton!.active_campaigns).toBe(1);
  });

  it("net_hp_per_hour is ECHOED from the supplied front aggregates, never recomputed", () => {
    // Sentinel value no recompute over these fixtures could produce.
    const sentinel = -123_456.789;
    const out = buildFactionRollup(
      planets,
      campaigns,
      new Map([["Terminids", sentinel]]),
    );
    expect(out.Terminids!.net_hp_per_hour).toBe(sentinel);
    expect(out.Humans!.net_hp_per_hour).toBeNull(); // no front → null
  });

  it("total_players_on_front sums KNOWN player counts with coverage; null when none known", () => {
    const out = buildFactionRollup(planets, campaigns, new Map());
    expect(out.Terminids!.total_players_on_front).toBe(12_000);
    expect(out.Terminids!.campaigns_with_players).toBe(1);
    expect(out.Terminids!.campaigns_total).toBe(2);
    expect(out.Humans!.total_players_on_front).toBeNull(); // never a fake 0
    expect(out.Humans!.campaigns_total).toBe(0);
  });
});

describe("buildSectorRollup: per-sector counts and owner tallies", () => {
  it("counts planets, owners, and active campaigns per sector", () => {
    const planets = [
      makePlanet({ index: 0, sector: "SEVIN", currentOwner: "Humans" }),
      makePlanet({ index: 1, sector: "SEVIN", currentOwner: "Terminids" }),
      makePlanet({ index: 2, sector: "XZAR", currentOwner: "Terminids" }),
    ];
    const out = buildSectorRollup(planets, [
      rollupCampaign("Terminids", 1, null),
    ]);
    expect(out.SEVIN).toEqual({
      planet_count: 2,
      owners: { Humans: 1, Terminids: 1 },
      active_campaigns: 1,
    });
    expect(out.XZAR).toEqual({
      planet_count: 1,
      owners: { Terminids: 1 },
      active_campaigns: 0,
    });
  });
});

/* ====================================================================== *
 * KV budget: combined worst-case store stays far under the 5MB value limit
 * ====================================================================== */

describe("combined KV value-size budget", () => {
  it("full galaxy at max retention + max signatures + max global samples < 5MB", () => {
    const PLANET_COUNT = 261;
    const store: SampleStore = { planets: {}, campaignsFirstSeen: {} };
    for (let p = 0; p < PLANET_COUNT; p++) {
      const samples: HealthSample[] = [];
      for (let i = 0; i < MAX_SAMPLES_PER_PLANET; i++) {
        samples.push({
          h: 1_000_000 - i * 1_234,
          t: NOW + i * MIN_SAMPLE_INTERVAL_MS,
        });
      }
      store.planets[String(p)] = { samples, lastRate: -12_345.678 };
      store.campaignsFirstSeen[String(50_000 + p)] = NOW;
    }
    store.signatures = [];
    for (let i = 0; i < MAX_SIGNATURES; i++) {
      store.signatures.push({
        campaign_type: i,
        event_type: i % 7,
        has_event: i % 2 === 0,
        faction: "Illuminate",
        first_seen: NOW,
        last_seen: NOW + i * MIN_SAMPLE_INTERVAL_MS,
        sample_count: 1_000 + i,
      });
    }
    store.global = [];
    for (let i = 0; i < MAX_GLOBAL_SAMPLES; i++) {
      store.global.push({
        t: NOW + i * MIN_SAMPLE_INTERVAL_MS,
        player_count: 123_456,
        missions_won: 1_234_567_890,
        missions_lost: 1_234_567_890,
        deaths: 1_234_567_890,
        terminid_kills: 123_456_789_012,
        automaton_kills: 123_456_789_012,
        illuminate_kills: 123_456_789_012,
      });
    }
    const bytes = JSON.stringify(store).length;
    // Same margin as stage2: observed ~1.0 MB — accumulation layers add
    // only ~75 KB to the planet-series worst case.
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
  });
});
