/**
 * Stage 12 tests: the append-only D1 history archive that lives ALONGSIDE the
 * KV ring buffer (never replacing it). Covers the pure archive-point builders,
 * the best-effort batched write path (gated by the SAME 60s interval as KV,
 * failure-isolated from the KV write and the primary response), and the
 * long-range read tools. Pure throughout, except the sanctioned in-memory
 * stubs: the KV stub (proving the unchanged one-write KV budget) and a small
 * in-memory D1 stub (proving the archive batch shape, gating, and reads).
 *
 * The regression guard that the KV path is UNDISTURBED lives in the other
 * stage suites, which all still pass unchanged — this file only adds D1 cover.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  ARCHIVE_DEFAULT_SINCE_HOURS,
  ARCHIVE_MAX_LIMIT,
  archiveSampleTick,
  clampLimit,
  readGlobalArchive,
  readMoArchive,
  readPlanetArchive,
  signatureKeyString,
  sinceCutoffMs,
  type GlobalArchiveRow,
  type MoArchiveRow,
  type PlanetArchiveRow,
} from "../src/archive";
import { SAMPLES_KEY_TTL_SECONDS, samplePlanetRates } from "../src/client";
import {
  buildGlobalArchivePoints,
  buildMoArchiveSeries,
  buildPlanetArchivePoints,
} from "../src/enrichment";
import {
  getGlobalArchive,
  getMajorOrderArchive,
  getPlanetArchive,
} from "../src/tools";
import { MIN_SAMPLE_INTERVAL_MS } from "../src/sampling";
import type { Env, RawCampaign, RawPlanet, RawStatistics } from "../src/types";

const HOUR_MS = 3_600_000;
const NOW = 1_780_000_000_000;

/* ====================================================================== *
 * In-memory stubs (KV + D1)
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

/** A focused in-memory D1: stores rows per table, executes the four INSERTs
 * (with the signature UPSERT) and the three archive SELECTs. It records every
 * batch call (to prove the single-batch budget) and the SELECT SQL (to prove
 * values are bound, never interpolated). */
class FakeD1 {
  planet_samples: PlanetArchiveRow[] = [];
  global_samples: GlobalArchiveRow[] = [];
  mo_progress_samples: MoArchiveRow[] = [];
  observed_signatures: {
    signature: string;
    campaign_type: number | null;
    event_type: number | null;
    has_event: number;
    faction: string | null;
    first_seen: number;
    last_seen: number;
    sample_count: number;
  }[] = [];
  batchCalls = 0;
  failBatch = false;
  lastSelectSql = "";

  prepare(sql: string): FakePrepared {
    return new FakePrepared(this, sql, []);
  }

  async batch(stmts: FakePrepared[]): Promise<unknown[]> {
    this.batchCalls += 1;
    if (this.failBatch) throw new Error("D1 unavailable");
    for (const s of stmts) this.execInsert(s.sql, s.vals);
    return [];
  }

  execInsert(sql: string, v: unknown[]): void {
    if (sql.includes("INTO planet_samples")) {
      this.planet_samples.push({
        planet_index: v[0] as number,
        sampled_at: v[1] as number,
        health: v[2] as number | null,
        max_health: v[3] as number | null,
        hp_per_hour: v[4] as number | null,
        campaign_id: v[5] as number | null,
        campaign_kind: v[6] as string | null,
        faction: v[7] as string | null,
      });
    } else if (sql.includes("INTO global_samples")) {
      this.global_samples.push({
        sampled_at: v[0] as number,
        player_count: v[1] as number | null,
        impact_multiplier: v[2] as number | null,
        active_campaign_count: v[3] as number | null,
        missions_won: v[4] as number | null,
        missions_lost: v[5] as number | null,
        deaths: v[6] as number | null,
        terminid_kills: v[7] as number | null,
        automaton_kills: v[8] as number | null,
        illuminate_kills: v[9] as number | null,
      });
    } else if (sql.includes("INTO mo_progress_samples")) {
      this.mo_progress_samples.push({
        major_order_id: v[0] as number,
        objective_index: v[1] as number,
        sampled_at: v[2] as number,
        progress: v[3] as number | null,
        target: v[4] as number | null,
      });
    } else if (sql.includes("INTO observed_signatures")) {
      const [signature, ct, et, he, faction, firstSeen, lastSeen] = v as [
        string,
        number | null,
        number | null,
        number,
        string | null,
        number,
        number,
      ];
      const existing = this.observed_signatures.find(
        (r) => r.signature === signature,
      );
      if (existing) {
        existing.last_seen = lastSeen; // excluded.last_seen
        existing.sample_count += 1;
      } else {
        this.observed_signatures.push({
          signature,
          campaign_type: ct,
          event_type: et,
          has_event: he,
          faction,
          first_seen: firstSeen,
          last_seen: lastSeen,
          sample_count: 1,
        });
      }
    }
  }

  async all(sql: string, v: unknown[]): Promise<{ results: unknown[] }> {
    this.lastSelectSql = sql;
    if (sql.includes("FROM planet_samples")) {
      const [planetIndex, sinceMs, limit] = v as number[];
      return {
        results: this.planet_samples
          .filter(
            (r) => r.planet_index === planetIndex && r.sampled_at >= sinceMs!,
          )
          .sort((a, b) => a.sampled_at - b.sampled_at)
          .slice(0, limit),
      };
    }
    if (sql.includes("FROM global_samples")) {
      const sinceMs = v[0] as number;
      const limit = v[v.length - 1] as number;
      return {
        results: this.global_samples
          .filter((r) => r.sampled_at >= sinceMs)
          .sort((a, b) => a.sampled_at - b.sampled_at)
          .slice(0, limit),
      };
    }
    if (sql.includes("FROM mo_progress_samples")) {
      const sinceMs = v[0] as number;
      const limit = v[v.length - 1] as number;
      let idx = 1;
      const moId = sql.includes("major_order_id = ?")
        ? (v[idx++] as number)
        : undefined;
      const objIdx = sql.includes("objective_index = ?")
        ? (v[idx++] as number)
        : undefined;
      return {
        results: this.mo_progress_samples
          .filter(
            (r) =>
              r.sampled_at >= sinceMs &&
              (moId == null || r.major_order_id === moId) &&
              (objIdx == null || r.objective_index === objIdx),
          )
          .sort((a, b) => a.sampled_at - b.sampled_at)
          .slice(0, limit),
      };
    }
    return { results: [] };
  }
}

class FakePrepared {
  constructor(
    public db: FakeD1,
    public sql: string,
    public vals: unknown[],
  ) {}
  bind(...vals: unknown[]): FakePrepared {
    return new FakePrepared(this.db, this.sql, vals);
  }
  all<T>(): Promise<{ results: T[] }> {
    return this.db.all(this.sql, this.vals) as Promise<{ results: T[] }>;
  }
}

function envWith(kv: FakeKv | null, d1: FakeD1 | null): Env {
  return {
    ...(kv ? { WAR_CACHE: kv as unknown as KVNamespace } : {}),
    ...(d1 ? { HISTORY_DB: d1 as unknown as D1Database } : {}),
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
 * Pure builders
 * ====================================================================== */

describe("buildPlanetArchivePoints", () => {
  function row(over: Partial<PlanetArchiveRow>): PlanetArchiveRow {
    return {
      planet_index: 175,
      sampled_at: NOW,
      health: 600_000,
      max_health: 1_000_000,
      hp_per_hour: null,
      campaign_id: 42,
      campaign_kind: "liberation",
      faction: "Terminids",
      ...over,
    };
  }

  it("first point has null deltas; later points are exact consecutive diffs", () => {
    const points = buildPlanetArchivePoints([
      row({ sampled_at: NOW, health: 600_000 }),
      row({ sampled_at: NOW + HOUR_MS, health: 550_000, hp_per_hour: 50_000 }),
    ]);
    expect(points[0]!.delta_health).toBeNull();
    expect(points[0]!.delta_hours).toBeNull();
    expect(points[1]!.delta_health).toBe(-50_000); // current − previous
    expect(points[1]!.delta_hours).toBe(1);
    expect(points[1]!.hp_per_hour).toBe(50_000); // stored signed rate carried
  });

  it("a null health propagates to a null delta — never treated as 0", () => {
    const points = buildPlanetArchivePoints([
      row({ sampled_at: NOW, health: 600_000 }),
      row({ sampled_at: NOW + HOUR_MS, health: null }),
      row({ sampled_at: NOW + 2 * HOUR_MS, health: 500_000 }),
    ]);
    expect(points[1]!.delta_health).toBeNull();
    expect(points[2]!.delta_health).toBeNull(); // prev was null
    expect(points[2]!.delta_hours).toBe(1); // time delta still observed
  });
});

describe("buildGlobalArchivePoints", () => {
  function grow(over: Partial<GlobalArchiveRow>): GlobalArchiveRow {
    return {
      sampled_at: NOW,
      player_count: 40_000,
      impact_multiplier: 1.5,
      active_campaign_count: 10,
      missions_won: 100,
      missions_lost: 20,
      deaths: 500,
      terminid_kills: 1_000,
      automaton_kills: 2_000,
      illuminate_kills: 3_000,
      ...over,
    };
  }

  it("reuses the global history delta derivation over archive rows", () => {
    const points = buildGlobalArchivePoints([
      grow({ sampled_at: NOW, player_count: 40_000, impact_multiplier: 1.5 }),
      grow({
        sampled_at: NOW + HOUR_MS,
        player_count: 42_000,
        impact_multiplier: 1.8,
      }),
    ]);
    expect(points[0]!.delta_player_count).toBeNull();
    expect(points[1]!.delta_player_count).toBe(2_000);
    expect(points[1]!.delta_impact_multiplier).toBeCloseTo(0.3, 6);
  });
});

describe("buildMoArchiveSeries", () => {
  it("groups flat rows into per-objective series with exact deltas; objective_kind null", () => {
    const rows: MoArchiveRow[] = [
      { major_order_id: 9001, objective_index: 0, sampled_at: NOW, progress: 1, target: 10 },
      { major_order_id: 9001, objective_index: 1, sampled_at: NOW, progress: 5, target: 50 },
      {
        major_order_id: 9001,
        objective_index: 0,
        sampled_at: NOW + HOUR_MS,
        progress: 4,
        target: 10,
      },
    ];
    const series = buildMoArchiveSeries(rows);
    expect(series).toHaveLength(2);
    const obj0 = series.find((s) => s.objective_index === 0)!;
    expect(obj0.points).toBe(2);
    expect(obj0.samples[1]!.delta_progress).toBe(3);
    expect(obj0.objective_kind).toBeNull(); // task_type not archived
    expect(obj0.insufficient_history).toBe(false);
    const obj1 = series.find((s) => s.objective_index === 1)!;
    expect(obj1.insufficient_history).toBe(true); // single point
  });
});

/* ====================================================================== *
 * archiveSampleTick — best-effort batched write
 * ====================================================================== */

describe("archiveSampleTick", () => {
  it("no D1 binding → no-op, never throws", async () => {
    await expect(
      archiveSampleTick(envWith(null, null), {
        planets: [
          {
            planet_index: 1,
            sampled_at: NOW,
            health: 1,
            max_health: 2,
            hp_per_hour: null,
            campaign_id: null,
            campaign_kind: null,
            faction: null,
          },
        ],
        global: null,
        mo: [],
        signatures: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("an empty tick performs no batch", async () => {
    const d1 = new FakeD1();
    await archiveSampleTick(envWith(null, d1), {
      planets: [],
      global: null,
      mo: [],
      signatures: [],
    });
    expect(d1.batchCalls).toBe(0);
  });

  it("all sections insert in ONE batch; the signature UPSERT seeds first_seen", async () => {
    const d1 = new FakeD1();
    await archiveSampleTick(envWith(null, d1), {
      planets: [
        {
          planet_index: 175,
          sampled_at: NOW,
          health: 600_000,
          max_health: 1_000_000,
          hp_per_hour: 50_000,
          campaign_id: 42,
          campaign_kind: "liberation",
          faction: "Terminids",
        },
      ],
      global: {
        sampled_at: NOW,
        player_count: 40_000,
        impact_multiplier: 1.5,
        active_campaign_count: 10,
        missions_won: 100,
        missions_lost: 20,
        deaths: 500,
        terminid_kills: 1,
        automaton_kills: 2,
        illuminate_kills: 3,
      },
      mo: [
        {
          major_order_id: 9001,
          objective_index: 0,
          sampled_at: NOW,
          progress: 1,
          target: 10,
        },
      ],
      signatures: [
        {
          signature: "type:0|event:null|has_event:0|faction:Terminids",
          campaign_type: 0,
          event_type: null,
          has_event: 0,
          faction: "Terminids",
          seen_at: NOW,
        },
      ],
    });
    expect(d1.batchCalls).toBe(1); // ONE batch, never a per-row loop
    expect(d1.planet_samples).toHaveLength(1);
    expect(d1.global_samples).toHaveLength(1);
    expect(d1.mo_progress_samples).toHaveLength(1);
    expect(d1.observed_signatures).toHaveLength(1);
    expect(d1.observed_signatures[0]!.first_seen).toBe(NOW);
    expect(d1.observed_signatures[0]!.sample_count).toBe(1);
  });

  it("a second observation of a signature preserves first_seen and bumps last_seen/sample_count", async () => {
    const d1 = new FakeD1();
    const sig = {
      signature: signatureKeyString({
        campaign_type: 0,
        event_type: null,
        has_event: false,
        faction: "Terminids",
      }),
      campaign_type: 0,
      event_type: null,
      has_event: 0 as const,
      faction: "Terminids",
      seen_at: NOW,
    };
    await archiveSampleTick(envWith(null, d1), {
      planets: [],
      global: null,
      mo: [],
      signatures: [sig],
    });
    await archiveSampleTick(envWith(null, d1), {
      planets: [],
      global: null,
      mo: [],
      signatures: [{ ...sig, seen_at: NOW + HOUR_MS }],
    });
    expect(d1.observed_signatures).toHaveLength(1);
    expect(d1.observed_signatures[0]!.first_seen).toBe(NOW); // preserved
    expect(d1.observed_signatures[0]!.last_seen).toBe(NOW + HOUR_MS);
    expect(d1.observed_signatures[0]!.sample_count).toBe(2);
  });

  it("FAILURE ISOLATION: a D1 error is swallowed, never thrown", async () => {
    const d1 = new FakeD1();
    d1.failBatch = true;
    await expect(
      archiveSampleTick(envWith(null, d1), {
        planets: [
          {
            planet_index: 1,
            sampled_at: NOW,
            health: 1,
            max_health: 2,
            hp_per_hour: null,
            campaign_id: null,
            campaign_kind: null,
            faction: null,
          },
        ],
        global: null,
        mo: [],
        signatures: [],
      }),
    ).resolves.toBeUndefined();
  });
});

/* ====================================================================== *
 * samplePlanetRates: the D1 archive rides beside the unchanged KV write
 * ====================================================================== */

describe("samplePlanetRates → D1 archive (KV path unchanged)", () => {
  const INPUTS = [
    {
      planetIndex: 175,
      health: 600_000,
      campaignId: 42,
      maxHealth: 1_000_000,
      campaignKind: "liberation",
      faction: "Terminids",
    },
  ];

  it("a fresh tick writes BOTH the single KV put AND the D1 archive rows", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    const results = await samplePlanetRates(envWith(kv, d1), INPUTS, NOW, {
      globalStatistics: stats(),
      globalImpactMultiplier: 1.5,
      globalActiveCampaignCount: 10,
      moProgress: [
        {
          majorOrderId: 9001,
          objectiveIndex: 0,
          taskType: 9,
          progress: 1,
          target: 10,
        },
      ],
      signatures: [
        { campaign_type: 0, event_type: null, has_event: false, faction: "Terminids" },
      ],
    });

    // KV path untouched: exactly one put on the combined key with the 30-day TTL.
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]!.key).toBe("samples:planets");
    expect(kv.puts[0]!.ttl).toBe(SAMPLES_KEY_TTL_SECONDS);
    expect(results.get(175)!.hpPerHour).toBeNull(); // cold seed

    // D1 archive: one batch, the committed planet/global/mo rows + signature.
    expect(d1.batchCalls).toBe(1);
    expect(d1.planet_samples).toHaveLength(1);
    expect(d1.planet_samples[0]).toMatchObject({
      planet_index: 175,
      sampled_at: NOW,
      health: 600_000,
      max_health: 1_000_000,
      hp_per_hour: null,
      campaign_id: 42,
      campaign_kind: "liberation",
      faction: "Terminids",
    });
    expect(d1.global_samples).toHaveLength(1);
    expect(d1.global_samples[0]).toMatchObject({
      player_count: 40_000,
      impact_multiplier: 1.5,
      active_campaign_count: 10,
    });
    expect(d1.mo_progress_samples).toHaveLength(1);
    expect(d1.observed_signatures).toHaveLength(1);
  });

  it("a later tick (>60s) archives the computed signed rate", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    await samplePlanetRates(envWith(kv, d1), INPUTS, NOW);
    await samplePlanetRates(
      envWith(kv, d1),
      [{ ...INPUTS[0]!, health: 500_000 }],
      NOW + 2 * MIN_SAMPLE_INTERVAL_MS,
    );
    expect(d1.planet_samples).toHaveLength(2);
    expect(d1.planet_samples[0]!.hp_per_hour).toBeNull(); // seed
    expect(d1.planet_samples[1]!.hp_per_hour).not.toBeNull(); // computed
    expect(d1.planet_samples[1]!.hp_per_hour!).toBeGreaterThan(0); // depleting
  });

  it("INTERVAL GATING: a within-60s replay inserts NO duplicate D1 rows", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    await samplePlanetRates(envWith(kv, d1), INPUTS, NOW, {
      globalStatistics: stats(),
      signatures: [
        { campaign_type: 0, event_type: null, has_event: false, faction: "Terminids" },
      ],
    });
    expect(d1.planet_samples).toHaveLength(1);
    expect(d1.global_samples).toHaveLength(1);
    expect(d1.observed_signatures[0]!.sample_count).toBe(1);

    // Replay 5s later: nothing crosses the 60s guard, so nothing is archived.
    await samplePlanetRates(envWith(kv, d1), INPUTS, NOW + 5_000, {
      globalStatistics: stats(),
      signatures: [
        { campaign_type: 0, event_type: null, has_event: false, faction: "Terminids" },
      ],
    });
    expect(d1.planet_samples).toHaveLength(1); // no duplicate
    expect(d1.global_samples).toHaveLength(1); // no duplicate
    expect(d1.observed_signatures[0]!.sample_count).toBe(1); // not inflated
    expect(d1.batchCalls).toBe(1); // the replay performed no batch at all
  });

  it("FAILURE ISOLATION: D1 down still yields a normal result AND the KV write", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    d1.failBatch = true;
    const results = await samplePlanetRates(envWith(kv, d1), INPUTS, NOW);
    expect(results.get(175)).toBeDefined(); // primary result unaffected
    expect(kv.puts).toHaveLength(1); // KV write still happened
    expect(kv.store.get("samples:planets")).toBeDefined();
  });

  it("no D1 binding → KV path behaves exactly as before (one put, no throw)", async () => {
    const kv = fakeKv();
    const results = await samplePlanetRates(envWith(kv, null), INPUTS, NOW);
    expect(results.get(175)!.hpPerHour).toBeNull();
    expect(kv.puts).toHaveLength(1);
  });
});

/* ====================================================================== *
 * Read path — archive.ts queries (parameterized) + the handler tools
 * ====================================================================== */

describe("readPlanetArchive / readGlobalArchive / readMoArchive", () => {
  function seedPlanet(d1: FakeD1): void {
    for (let i = 0; i < 5; i++) {
      d1.planet_samples.push({
        planet_index: 175,
        sampled_at: NOW + i * HOUR_MS,
        health: 600_000 - i * 10_000,
        max_health: 1_000_000,
        hp_per_hour: i === 0 ? null : 10_000,
        campaign_id: 42,
        campaign_kind: "liberation",
        faction: "Terminids",
      });
    }
    // A different planet's rows must never leak into the query.
    d1.planet_samples.push({
      planet_index: 9,
      sampled_at: NOW,
      health: 1,
      max_health: 2,
      hp_per_hour: null,
      campaign_id: 7,
      campaign_kind: "liberation",
      faction: "Automaton",
    });
  }

  it("planet rows come back time-ordered, scoped to the planet, honoring since/limit", async () => {
    const d1 = new FakeD1();
    seedPlanet(d1);
    const env = envWith(null, d1);

    const all = await readPlanetArchive(env, 175, NOW - HOUR_MS, 1000);
    expect(all).toHaveLength(5);
    expect(all.every((r) => r.planet_index === 175)).toBe(true);
    expect(all.map((r) => r.sampled_at)).toEqual([
      NOW,
      NOW + HOUR_MS,
      NOW + 2 * HOUR_MS,
      NOW + 3 * HOUR_MS,
      NOW + 4 * HOUR_MS,
    ]);

    // since cutoff drops the older points.
    const recent = await readPlanetArchive(env, 175, NOW + 2 * HOUR_MS, 1000);
    expect(recent.map((r) => r.sampled_at)).toEqual([
      NOW + 2 * HOUR_MS,
      NOW + 3 * HOUR_MS,
      NOW + 4 * HOUR_MS,
    ]);

    // limit caps the row count (oldest-first within the window).
    const capped = await readPlanetArchive(env, 175, NOW - HOUR_MS, 2);
    expect(capped).toHaveLength(2);

    // PARAMETERIZED: values are bound (placeholders), never interpolated.
    expect(d1.lastSelectSql).toContain("WHERE planet_index = ? AND sampled_at >= ?");
    expect(d1.lastSelectSql).toContain("LIMIT ?");
    expect(d1.lastSelectSql).not.toMatch(/LIMIT \d/);
    expect(d1.lastSelectSql).not.toContain("175");
  });

  it("global archive honors since/limit and stays parameterized", async () => {
    const d1 = new FakeD1();
    for (let i = 0; i < 3; i++) {
      d1.global_samples.push({
        sampled_at: NOW + i * HOUR_MS,
        player_count: 40_000 + i,
        impact_multiplier: 1.5,
        active_campaign_count: 10,
        missions_won: 1,
        missions_lost: 1,
        deaths: 1,
        terminid_kills: 1,
        automaton_kills: 1,
        illuminate_kills: 1,
      });
    }
    const rows = await readGlobalArchive(envWith(null, d1), NOW - HOUR_MS, 1000);
    expect(rows.map((r) => r.player_count)).toEqual([40_000, 40_001, 40_002]);
    expect(d1.lastSelectSql).toContain("sampled_at >= ?");
    expect(d1.lastSelectSql).not.toMatch(/LIMIT \d/);
  });

  it("MO archive narrows by major_order_id / objective_index via bound params", async () => {
    const d1 = new FakeD1();
    d1.mo_progress_samples.push(
      { major_order_id: 9001, objective_index: 0, sampled_at: NOW, progress: 1, target: 10 },
      { major_order_id: 9001, objective_index: 1, sampled_at: NOW, progress: 2, target: 20 },
      { major_order_id: 8000, objective_index: 0, sampled_at: NOW, progress: 9, target: 9 },
    );
    const env = envWith(null, d1);

    const all = await readMoArchive(env, NOW - HOUR_MS, 1000);
    expect(all).toHaveLength(3);

    const oneMo = await readMoArchive(env, NOW - HOUR_MS, 1000, {
      majorOrderId: 9001,
    });
    expect(oneMo.every((r) => r.major_order_id === 9001)).toBe(true);
    expect(d1.lastSelectSql).toContain("major_order_id = ?");

    const oneObj = await readMoArchive(env, NOW - HOUR_MS, 1000, {
      majorOrderId: 9001,
      objectiveIndex: 1,
    });
    expect(oneObj).toHaveLength(1);
    expect(oneObj[0]!.objective_index).toBe(1);
  });
});

/* ---- handler tools over a seeded raw cache (stage6 pattern) + D1 ---- */

function makePlanet(over: Partial<RawPlanet> = {}): RawPlanet {
  return {
    index: 175,
    name: "Grand Errant",
    sector: "Sector",
    maxHealth: 1_000_000,
    health: 500_000,
    disabled: false,
    initialOwner: "Humans",
    currentOwner: "Terminids",
    regenPerSecond: 0,
    event: null,
    attacking: [],
    waypoints: [],
    ...over,
  };
}

function seedRaw(kv: FakeKv, path: string, body: unknown): void {
  kv.store.set(
    `raw:${path}`,
    JSON.stringify({ fetchedAt: Date.now() - 1_000, body }),
  );
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

describe("getPlanetArchive handler (cache-served resolution + D1 archive)", () => {
  it("resolves by index and returns time-ordered points with deltas; honors limit", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    // Default since_hours uses the real clock — seed within the 7-day window.
    const base = Date.now() - 3 * HOUR_MS;
    seedRaw(kv, "/api/v1/planets", [makePlanet()]);
    seedRaw(kv, "/api/v1/campaigns", []);
    for (let i = 0; i < 3; i++) {
      d1.planet_samples.push({
        planet_index: 175,
        sampled_at: base + i * HOUR_MS,
        health: 600_000 - i * 50_000,
        max_health: 1_000_000,
        hp_per_hour: i === 0 ? null : 50_000,
        campaign_id: 42,
        campaign_kind: "liberation",
        faction: "Terminids",
      });
    }
    const fetches = forbidNetwork();

    const out = (await getPlanetArchive(envWith(kv, d1), {
      index: 175,
    })) as Record<string, unknown>;

    expect(fetches.calls).toBe(0); // raw cache served resolution
    expect(kv.puts).toEqual([]); // archive read never writes KV
    expect(out.source).toBe("d1_archive");
    expect(out.planet_index).toBe(175);
    expect(out.points).toBe(3);
    expect(out.insufficient_history).toBe(false);
    const samples = out.samples as { delta_health: number | null }[];
    expect(samples[0]!.delta_health).toBeNull();
    expect(samples[1]!.delta_health).toBe(-50_000);
    expect(out.since_hours).toBe(ARCHIVE_DEFAULT_SINCE_HOURS);
    expect(out.max_limit).toBe(ARCHIVE_MAX_LIMIT);
  });

  it("a cold archive → insufficient_history with a non-error note", async () => {
    const kv = fakeKv();
    const d1 = new FakeD1();
    seedRaw(kv, "/api/v1/planets", [makePlanet()]);
    seedRaw(kv, "/api/v1/campaigns", []);
    forbidNetwork();

    const out = (await getPlanetArchive(envWith(kv, d1), {
      index: 175,
    })) as Record<string, unknown>;
    expect(out.points).toBe(0);
    expect(out.insufficient_history).toBe(true);
    expect(typeof out.note).toBe("string");
  });
});

describe("getGlobalArchive / getMajorOrderArchive handlers", () => {
  it("global archive returns observed points + deltas, no upstream fetch", async () => {
    const d1 = new FakeD1();
    const base = Date.now() - 3 * HOUR_MS;
    for (let i = 0; i < 2; i++) {
      d1.global_samples.push({
        sampled_at: base + i * HOUR_MS,
        player_count: 40_000 + i * 1_000,
        impact_multiplier: 1.5 + i * 0.1,
        active_campaign_count: 10,
        missions_won: 1,
        missions_lost: 1,
        deaths: 1,
        terminid_kills: 1,
        automaton_kills: 1,
        illuminate_kills: 1,
      });
    }
    const fetches = forbidNetwork();
    const out = (await getGlobalArchive(envWith(null, d1), {})) as Record<
      string,
      unknown
    >;
    expect(fetches.calls).toBe(0);
    expect(out.points).toBe(2);
    expect(out.insufficient_history).toBe(false);
    const samples = out.samples as { delta_player_count: number | null }[];
    expect(samples[1]!.delta_player_count).toBe(1_000);
  });

  it("MO archive groups per objective and carries no forecast key", async () => {
    const d1 = new FakeD1();
    const base = Date.now() - 3 * HOUR_MS;
    d1.mo_progress_samples.push(
      { major_order_id: 9001, objective_index: 0, sampled_at: base, progress: 1, target: 10 },
      {
        major_order_id: 9001,
        objective_index: 0,
        sampled_at: base + HOUR_MS,
        progress: 4,
        target: 10,
      },
    );
    forbidNetwork();
    const out = (await getMajorOrderArchive(envWith(null, d1), {})) as Record<
      string,
      unknown
    >;
    expect(out.series_count).toBe(1);
    expect(out.archived_major_order_ids).toEqual([9001]);
    // Prime directive: no interpretive/forecast KEY anywhere in the payload
    // (note prose may describe what it refuses to do — that is by design).
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(val);
        }
      }
    };
    walk(out);
    for (const banned of [
      "forecast",
      "on_track",
      "required_pace",
      "verdict",
      "recommend",
      "priority",
      "rank",
    ]) {
      expect([...keys].some((k) => k.includes(banned))).toBe(false);
    }
  });
});

/* ====================================================================== *
 * Helpers: clampLimit / sinceCutoffMs / signatureKeyString
 * ====================================================================== */

describe("archive helpers", () => {
  it("clampLimit defaults and caps into [1, MAX]", () => {
    expect(clampLimit(undefined)).toBe(ARCHIVE_MAX_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(99_999)).toBe(ARCHIVE_MAX_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(ARCHIVE_MAX_LIMIT);
  });

  it("sinceCutoffMs defaults to the 7-day window and respects a custom one", () => {
    expect(sinceCutoffMs(undefined, NOW)).toBe(NOW - ARCHIVE_DEFAULT_SINCE_HOURS * HOUR_MS);
    expect(sinceCutoffMs(24, NOW)).toBe(NOW - 24 * HOUR_MS);
    expect(sinceCutoffMs(-1, NOW)).toBe(NOW - ARCHIVE_DEFAULT_SINCE_HOURS * HOUR_MS);
  });

  it("signatureKeyString is stable and distinguishes null from 0", () => {
    const a = signatureKeyString({ campaign_type: 0, event_type: null, has_event: false, faction: "Terminids" });
    const b = signatureKeyString({ campaign_type: null, event_type: null, has_event: false, faction: "Terminids" });
    expect(a).not.toBe(b);
    expect(a).toBe(signatureKeyString({ campaign_type: 0, event_type: null, has_event: false, faction: "Terminids" }));
  });
});
