/**
 * Stage 11 tests: the Galactic Impact Multiplier (raw upstream
 * war.impactMultiplier, war-payload root — verified live 2026-06-11) and the
 * active-campaign count co-sampled into the EXISTING global statistics
 * series. Raw observed values + raw consecutive deltas only — no correlation,
 * model, or prediction relating the multiplier to population is ever
 * computed; the relationship is for the consumer to read off the curves.
 * Handler tests follow the sanctioned stage6 KV-stub pattern.
 */
import { afterEach, describe, expect, it } from "vitest";

import { samplePlanetRates } from "../src/client";
import { buildGlobalHistoryPoints } from "../src/enrichment";
import {
  MAX_GLOBAL_SAMPLES,
  MIN_SAMPLE_INTERVAL_MS,
  advanceGlobalSeries,
  coerceStore,
  type GlobalSample,
  type SampleStore,
} from "../src/sampling";
import { getGlobalHistory, getWarStatus } from "../src/tools";
import type {
  Env,
  RawAssignment,
  RawCampaign,
  RawPlanet,
  RawStatistics,
  RawWar,
} from "../src/types";

const NOW = 1_780_000_000_000;

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
 * advanceGlobalSeries: the co-sampled extras
 * ====================================================================== */

describe("advanceGlobalSeries: impact_multiplier + active_campaign_count", () => {
  it("records both extras on a sampled point", () => {
    const out = advanceGlobalSeries(undefined, stats(), NOW, {
      impactMultiplier: 0.031186422,
      activeCampaignCount: 41,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.impact_multiplier).toBe(0.031186422);
    expect(out[0]!.active_campaign_count).toBe(41);
    // The pre-existing fields are untouched by the extras.
    expect(out[0]!.player_count).toBe(40_000);
  });

  it("absent/null/non-finite extras → null at that point, never 0", () => {
    const omitted = advanceGlobalSeries(undefined, stats(), NOW);
    expect(omitted[0]!.impact_multiplier).toBeNull();
    expect(omitted[0]!.active_campaign_count).toBeNull();

    const explicit = advanceGlobalSeries(undefined, stats(), NOW, {
      impactMultiplier: null,
      activeCampaignCount: Number.NaN,
    });
    expect(explicit[0]!.impact_multiplier).toBeNull();
    expect(explicit[0]!.active_campaign_count).toBeNull();
  });

  it("extras never create a sample alone — the stats gate is unchanged", () => {
    const existing = advanceGlobalSeries(undefined, stats(), NOW);
    const out = advanceGlobalSeries(existing, null, NOW + 3_600_000, {
      impactMultiplier: 0.03,
      activeCampaignCount: 41,
    });
    expect(out).toBe(existing);
  });

  it("the 60s guard is unchanged with extras present", () => {
    const seeded = advanceGlobalSeries(undefined, stats(), NOW, {
      impactMultiplier: 0.02,
      activeCampaignCount: 40,
    });
    const out = advanceGlobalSeries(seeded, stats(), NOW + 5_000, {
      impactMultiplier: 0.03,
      activeCampaignCount: 41,
    });
    expect(out).toBe(seeded);
  });
});

/* ====================================================================== *
 * Back-compat: points stored before Stage 11
 * ====================================================================== */

describe("coerceStore: pre-Stage-11 global points", () => {
  it("historical points without the new keys coerce to null — never backfilled", () => {
    const preStage11 = {
      planets: {},
      campaignsFirstSeen: {},
      global: [
        {
          t: NOW,
          player_count: 50_000,
          missions_won: 1,
          missions_lost: 1,
          deaths: 1,
          terminid_kills: 1,
          automaton_kills: 1,
          illuminate_kills: 1,
        },
      ],
    };
    const out = coerceStore(preStage11);
    expect(out.global).toHaveLength(1);
    expect(out.global![0]!.impact_multiplier).toBeNull();
    expect(out.global![0]!.active_campaign_count).toBeNull();
    expect(out.global![0]!.player_count).toBe(50_000);
  });

  it("new-shape points round-trip with both values intact", () => {
    const global = advanceGlobalSeries(undefined, stats(), NOW, {
      impactMultiplier: 0.024,
      activeCampaignCount: 41,
    });
    const out = coerceStore(
      JSON.parse(
        JSON.stringify({ planets: {}, campaignsFirstSeen: {}, global }),
      ),
    );
    expect(out.global).toEqual(global);
  });
});

/* ====================================================================== *
 * Folded write: the extras ride the existing single KV put
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

describe("samplePlanetRates: Stage 11 fields ride the single existing write", () => {
  const INPUTS = [{ planetIndex: 175, health: 600_000, campaignId: 42 }];

  it("exactly ONE put, with the global point carrying both new fields", async () => {
    const kv = fakeKv();
    await samplePlanetRates(
      { WAR_CACHE: kv as unknown as KVNamespace },
      INPUTS,
      NOW,
      {
        globalStatistics: stats(),
        globalImpactMultiplier: 0.031186422,
        globalActiveCampaignCount: 41,
      },
    );
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]!.key).toBe("samples:planets");
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(stored.global).toHaveLength(1);
    expect(stored.global![0]!.impact_multiplier).toBe(0.031186422);
    expect(stored.global![0]!.active_campaign_count).toBe(41);
  });

  it("a later poll without the extras appends a point with nulls — never 0", async () => {
    const kv = fakeKv();
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    await samplePlanetRates(env, INPUTS, NOW, {
      globalStatistics: stats(),
      globalImpactMultiplier: 0.024,
      globalActiveCampaignCount: 40,
    });
    await samplePlanetRates(env, INPUTS, NOW + 2 * MIN_SAMPLE_INTERVAL_MS, {
      globalStatistics: stats(),
    });
    expect(kv.puts).toHaveLength(2); // one per cycle — never more
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(stored.global).toHaveLength(2);
    expect(stored.global![1]!.impact_multiplier).toBeNull();
    expect(stored.global![1]!.active_campaign_count).toBeNull();
  });
});

/* ====================================================================== *
 * buildGlobalHistoryPoints: observed deltas, null-propagating
 * ====================================================================== */

describe("buildGlobalHistoryPoints: Stage 11 deltas", () => {
  it("exact consecutive deltas for both new fields", () => {
    const series: GlobalSample[] = [
      base(NOW, { impact_multiplier: 0.02, active_campaign_count: 38 }),
      base(NOW + 3_600_000, {
        impact_multiplier: 0.035,
        active_campaign_count: 41,
      }),
    ];
    const [first, second] = buildGlobalHistoryPoints(series);
    expect(first!.impact_multiplier).toBe(0.02);
    expect(first!.active_campaign_count).toBe(38);
    expect(first!.delta_impact_multiplier).toBeNull(); // no predecessor
    expect(first!.delta_active_campaign_count).toBeNull();
    expect(second!.delta_impact_multiplier).toBeCloseTo(0.015, 12);
    expect(second!.delta_active_campaign_count).toBe(3);
  });

  it("a null end (incl. a pre-Stage-11 historical point) → null delta, never 0", () => {
    const series: GlobalSample[] = [
      base(NOW), // pre-Stage-11 shape: fields absent
      base(NOW + 3_600_000, {
        impact_multiplier: 0.03,
        active_campaign_count: 41,
      }),
      base(NOW + 7_200_000, { active_campaign_count: 42 }), // multiplier absent
    ];
    const [first, second, third] = buildGlobalHistoryPoints(series);
    expect(first!.impact_multiplier).toBeNull();
    expect(first!.active_campaign_count).toBeNull();
    expect(second!.delta_impact_multiplier).toBeNull(); // prior end null
    expect(second!.delta_active_campaign_count).toBeNull();
    expect(third!.impact_multiplier).toBeNull();
    expect(third!.delta_impact_multiplier).toBeNull();
    expect(third!.delta_active_campaign_count).toBe(1);
  });

  it("negative deltas pass through as observed", () => {
    const series: GlobalSample[] = [
      base(NOW, { impact_multiplier: 0.05, active_campaign_count: 45 }),
      base(NOW + 3_600_000, {
        impact_multiplier: 0.02,
        active_campaign_count: 39,
      }),
    ];
    const [, second] = buildGlobalHistoryPoints(series);
    expect(second!.delta_impact_multiplier).toBeCloseTo(-0.03, 12);
    expect(second!.delta_active_campaign_count).toBe(-6);
  });

  function base(t: number, over: Partial<GlobalSample> = {}): GlobalSample {
    return {
      t,
      player_count: 40_000,
      missions_won: 1,
      missions_lost: 1,
      deaths: 1,
      terminid_kills: 1,
      automaton_kills: 1,
      illuminate_kills: 1,
      ...over,
    };
  }
});

/* ====================================================================== *
 * Store size: the two extra numbers stay negligible
 * ====================================================================== */

describe("store size with Stage 11 fields", () => {
  it("a full global series including both new fields stays far under the 5MB KV limit", () => {
    const global: GlobalSample[] = [];
    for (let i = 0; i < MAX_GLOBAL_SAMPLES; i++) {
      global.push({
        t: NOW + i * MIN_SAMPLE_INTERVAL_MS,
        player_count: 123_456,
        missions_won: 987_654_321,
        missions_lost: 12_345_678,
        deaths: 1_234_567_890,
        terminid_kills: 123_456_789_012,
        automaton_kills: 123_456_789_012,
        illuminate_kills: 123_456_789_012,
        impact_multiplier: 0.031186422,
        active_campaign_count: 41,
      });
    }
    const bytes = JSON.stringify({
      planets: {},
      campaignsFirstSeen: {},
      global,
    }).length;
    expect(bytes).toBeLessThan(64 * 1024); // ~25KB in practice — negligible
  });
});

/* ----------- Handler end-to-end (sanctioned stage6 KV-stub pattern) ----- */

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
  impactMultiplier: 0.031186422,
  statistics: stats(),
};

function seedRaw(kv: FakeKv, path: string, body: unknown): void {
  kv.store.set(
    `raw:${path}`,
    JSON.stringify({ fetchedAt: Date.now() - 1_000, body }),
  );
}

function seededEnv(kv: FakeKv): Env {
  seedRaw(kv, "/api/v1/planets", [makeRawPlanet()]);
  seedRaw(kv, "/api/v1/campaigns", [makeRawCampaign()]);
  seedRaw(kv, "/api/v1/assignments", [] satisfies RawAssignment[]);
  seedRaw(kv, "/api/v1/war", WAR);
  return { WAR_CACHE: kv as unknown as KVNamespace };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidNetwork(): void {
  globalThis.fetch = (() => {
    throw new Error("network touched — the shared cache should have served this");
  }) as unknown as typeof fetch;
}

describe("handlers (cache-served)", () => {
  it("get_war_status exposes the current raw impact_multiplier", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    forbidNetwork();

    const status = (await getWarStatus(env)) as Record<string, unknown>;
    expect(status.impact_multiplier).toBe(0.031186422);
    // Budget unchanged: still exactly one samples:planets put per poll.
    expect(kv.puts.map((p) => p.key)).toEqual(["samples:planets"]);
  });

  it("get_global_history serves the new fields, read-only, with no conclusion field", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    forbidNetwork();

    await getWarStatus(env); // accrues one global sample (one write)
    kv.puts.length = 0;
    const history = (await getGlobalHistory(env)) as {
      samples: Array<Record<string, unknown>>;
    } & Record<string, unknown>;

    expect(kv.puts).toHaveLength(0); // history is read-only
    expect(history.samples).toHaveLength(1);
    expect(history.samples[0]!.impact_multiplier).toBe(0.031186422);
    expect(history.samples[0]!.active_campaign_count).toBe(1);
    expect(history.samples[0]!.delta_impact_multiplier).toBeNull();
    expect(history.samples[0]!.delta_active_campaign_count).toBeNull();

    // Prime directive pin: no correlation/model/prediction key anywhere.
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
    walk(history);
    for (const key of keys) {
      expect(key).not.toMatch(
        /correlation|regression|predict|forecast|model|formula|expected_multiplier/i,
      );
    }
  });
});
