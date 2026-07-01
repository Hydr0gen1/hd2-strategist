/**
 * Stage 17 tests — Tier 3 of the next-features wave (data integrity):
 *
 * Item 7: the anomaly quarantine gate. The plausibility screen
 * (`screenGlobalRow`) catches (a) the known 18145 / 0.07364573 sentinel
 * signature and (b) an Nσ delta outlier over the recent series; at the write
 * path a failing row is diverted to quarantined_samples (queryable, with a
 * reason and both sides of the comparison) and NEVER inserted into the live
 * archive table — while the KV write and the response stay untouched
 * (served-but-flagged). The allFresh gate is not relaxed.
 *
 * Item 8: get_health — row counts, gap list, cadence adherence, quarantine
 * tallies. Deterministic facts, no judgment.
 *
 * Sanctioned in-memory stubs: the ~10-line KV stub and a small D1 stub that
 * executes the archive INSERTs into per-table arrays (stage12 spirit).
 */
import { describe, expect, it } from "vitest";

import type { GlobalArchiveWriteRow } from "../src/archive";
import { samplePlanetRates } from "../src/client";
import {
  buildGapList,
  cadenceStats,
  OUTLIER_MIN_DELTAS,
  OUTLIER_SIGMA_THRESHOLD,
  screenGlobalRow,
  SENTINEL_IMPACT_MULTIPLIER,
  SENTINEL_PLAYER_COUNT,
} from "../src/integrity";
import { getHealth } from "../src/tools";
import type { Env, RawStatistics } from "../src/types";
import type { GlobalSample } from "../src/sampling";

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/* ------------------------------ fixtures ------------------------------ */

function globalRow(over: Partial<GlobalArchiveWriteRow> = {}): GlobalArchiveWriteRow {
  return {
    sampled_at: NOW,
    player_count: 40_000,
    impact_multiplier: 1.2,
    active_campaign_count: 5,
    missions_won: 1_000,
    missions_lost: 100,
    deaths: 50_000,
    terminid_kills: 9_000,
    automaton_kills: 8_000,
    illuminate_kills: 7_000,
    tick_anchor: NOW - 10 * MINUTE,
    ...over,
  };
}

/** A steady recent series: n samples 10 min apart, player_count drifting by
 * ~±200 around 40k, counters advancing steadily. */
function steadySeries(n: number, endAt: number = NOW - 10 * MINUTE): GlobalSample[] {
  const out: GlobalSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = endAt - (n - 1 - i) * 10 * MINUTE;
    out.push({
      t,
      player_count: 40_000 + (i % 2 === 0 ? 200 : -100) + i * 10,
      missions_won: 1_000 + i * 50,
      missions_lost: 100 + i * 5,
      deaths: 50_000 + i * 500,
      terminid_kills: 9_000 + i * 100,
      automaton_kills: 8_000 + i * 90,
      illuminate_kills: 7_000 + i * 80,
      impact_multiplier: 1.2,
      active_campaign_count: 5,
    });
  }
  return out;
}

/* --------------------- item 7: the pure screen ------------------------ */

describe("screenGlobalRow (item 7, pure)", () => {
  it("catches the known sentinel signature as a PAIR", () => {
    const findings = screenGlobalRow(
      globalRow({
        player_count: SENTINEL_PLAYER_COUNT,
        impact_multiplier: SENTINEL_IMPACT_MULTIPLIER,
      }),
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe("known_sentinel_signature");
    // Both sides of the comparison ride the detail.
    expect(findings[0]!.detail.observed_player_count).toBe(SENTINEL_PLAYER_COUNT);
    expect(findings[0]!.detail.sentinel_impact_multiplier).toBe(
      SENTINEL_IMPACT_MULTIPLIER,
    );
  });

  it("the sentinel player count with a DIFFERENT multiplier is not flagged", () => {
    expect(
      screenGlobalRow(
        globalRow({ player_count: SENTINEL_PLAYER_COUNT, impact_multiplier: 1.4 }),
        [],
      ),
    ).toHaveLength(0);
  });

  it("catches an Nσ population dip (the June-28 pop=3552 shape) with both numbers", () => {
    const recent = steadySeries(12);
    const findings = screenGlobalRow(globalRow({ player_count: 3_552 }), recent);
    const dip = findings.find((f) => f.reason === "delta_exceeds_sigma_bound");
    expect(dip).toBeTruthy();
    expect(dip!.detail.field).toBe("player_count");
    expect(dip!.detail.observed_value).toBe(3_552);
    expect(typeof dip!.detail.recent_delta_mean).toBe("number");
    expect(typeof dip!.detail.recent_delta_stddev).toBe("number");
    expect(dip!.detail.sigma_threshold).toBe(OUTLIER_SIGMA_THRESHOLD);
  });

  it("a plausible row passes clean", () => {
    const recent = steadySeries(12);
    expect(screenGlobalRow(globalRow({ player_count: 40_300 }), recent)).toHaveLength(0);
  });

  it("abstains below the minimum delta history (never a thin-history guess)", () => {
    const recent = steadySeries(OUTLIER_MIN_DELTAS); // deltas = n − 1 < minimum
    expect(screenGlobalRow(globalRow({ player_count: 3_552 }), recent)).toHaveLength(0);
  });

  it("abstains on zero spread (no divide, no infinite-sigma trip)", () => {
    const flat: GlobalSample[] = Array.from({ length: 12 }, (_, i) => ({
      t: NOW - (12 - i) * 10 * MINUTE,
      player_count: 40_000, // deltas all exactly 0 → stddev 0
      missions_won: null,
      missions_lost: null,
      deaths: null,
      terminid_kills: null,
      automaton_kills: null,
      illuminate_kills: null,
    }));
    expect(screenGlobalRow(globalRow({ player_count: 3_552 }), flat)).toHaveLength(0);
  });
});

/* ---------------- item 7: the write path (KV + D1 stubs) --------------- */

interface FakeKv {
  store: Map<string, string>;
  puts: { key: string }[];
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: unknown): Promise<void>;
}

function fakeKv(): FakeKv {
  return {
    store: new Map(),
    puts: [],
    async get(key: string) {
      const raw = this.store.get(key);
      return raw == null ? null : JSON.parse(raw);
    },
    async put(key: string, value: string) {
      this.store.set(key, value);
      this.puts.push({ key });
    },
  };
}

/** Executes the archive INSERTs into per-table arrays and answers the
 * quarantine/health SELECTs. Records batch calls (single-batch pin). */
class WriteFakeD1 {
  tables: Record<string, Record<string, unknown>[]> = {
    planet_samples: [],
    global_samples: [],
    mo_progress_samples: [],
    observed_signatures: [],
    quarantined_samples: [],
  };
  batches = 0;
  /** Tables that "do not exist" (migration unapplied): a batch naming one is
   * rejected WHOLE — D1 batches are atomic. */
  failTables = new Set<string>();

  prepare(sql: string) {
    const db = this;
    const stmt = {
      sql,
      vals: [] as unknown[],
      bind(...vals: unknown[]) {
        stmt.vals = vals;
        return stmt;
      },
      async all() {
        return { results: db.select(sql, stmt.vals) };
      },
      async first() {
        return db.select(sql, stmt.vals)[0] ?? null;
      },
    };
    return stmt;
  }

  select(sql: string, _binds: unknown[]): Record<string, unknown>[] {
    const table = (sql.match(/FROM (\w+)/) ?? [])[1] ?? "";
    const rows = this.tables[table] ?? [];
    if (sql.includes("COUNT(*)") && sql.includes("GROUP BY reason")) {
      const byReason = new Map<string, number>();
      for (const r of rows) {
        const reason = r.reason as string;
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
      }
      return [...byReason.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([reason, n]) => ({ reason, n }));
    }
    if (sql.includes("COUNT(*)")) return [{ n: rows.length }];
    if (sql.includes("AS earliest")) {
      const ts = rows.map((r) => r.sampled_at as number);
      return [
        {
          earliest: ts.length ? Math.min(...ts) : null,
          latest: ts.length ? Math.max(...ts) : null,
        },
      ];
    }
    // Plain selects (timestamps / recent quarantine): newest-first.
    return [...rows].sort(
      (a, b) => (b.sampled_at as number) - (a.sampled_at as number),
    );
  }

  async batch(stmts: { sql: string; vals: unknown[] }[]) {
    this.batches += 1;
    for (const s of stmts) {
      const m = s.sql.match(/INTO (\w+)/);
      if (m && this.failTables.has(m[1]!)) {
        throw new Error(`no such table: ${m[1]}`);
      }
    }
    for (const s of stmts) {
      const m = s.sql.match(/INTO (\w+)\s*\(([^)]+)\)/);
      if (!m) continue;
      const table = m[1]!;
      const cols = m[2]!.split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => (row[c] = s.vals[i]));
      (this.tables[table] ??= []).push(row);
    }
    return stmts.map(() => ({ results: [] }));
  }
}

function envWith(kv: FakeKv, db: WriteFakeD1): Env {
  return {
    WAR_CACHE: kv as unknown as KVNamespace,
    HISTORY_DB: db as unknown as Env["HISTORY_DB"],
  };
}

/** Seed the KV sample store with a recent global series so the screen has
 * delta history to compare against. */
function seedStore(kv: FakeKv, global: GlobalSample[]): void {
  kv.store.set(
    "samples:planets",
    JSON.stringify({ planets: {}, campaignsFirstSeen: {}, global }),
  );
}

function statsOf(playerCount: number): RawStatistics {
  return {
    playerCount,
    missionsWon: 1_600,
    missionsLost: 160,
    deaths: 56_000,
    terminidKills: 10_200,
    automatonKills: 9_080,
    illuminateKills: 7_960,
  } as RawStatistics;
}

describe("quarantine at the write path (item 7)", () => {
  it("a sentinel tick is routed to quarantine — the live archive row count excludes it, KV unaffected", async () => {
    const kv = fakeKv();
    const db = new WriteFakeD1();
    seedStore(kv, steadySeries(12, NOW - 10 * MINUTE));

    await samplePlanetRates(envWith(kv, db), [], NOW, {
      globalStatistics: statsOf(SENTINEL_PLAYER_COUNT),
      globalImpactMultiplier: SENTINEL_IMPACT_MULTIPLIER,
      globalActiveCampaignCount: 5,
    });

    // Diverted: quarantined, not archived live.
    expect(db.tables.global_samples).toHaveLength(0);
    expect(db.tables.quarantined_samples).toHaveLength(1);
    const q = db.tables.quarantined_samples![0]!;
    expect(q.reason).toBe("known_sentinel_signature");
    expect(q.table_name).toBe("global_samples");
    // The excluded row rides verbatim, and the detail carries both sides.
    expect(JSON.parse(q.row_json as string).player_count).toBe(
      SENTINEL_PLAYER_COUNT,
    );
    // The KV write is untouched (served-but-flagged, the frozen live path).
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(1);
    // Still ONE batch for the whole tick.
    expect(db.batches).toBe(1);
  });

  it("an Nσ outlier tick is quarantined with the statistics it violated", async () => {
    const kv = fakeKv();
    const db = new WriteFakeD1();
    seedStore(kv, steadySeries(12, NOW - 10 * MINUTE));

    await samplePlanetRates(envWith(kv, db), [], NOW, {
      globalStatistics: statsOf(3_552), // the June-28 dip shape
      globalImpactMultiplier: 1.2,
      globalActiveCampaignCount: 5,
    });

    expect(db.tables.global_samples).toHaveLength(0);
    expect(db.tables.quarantined_samples).toHaveLength(1);
    const q = db.tables.quarantined_samples![0]!;
    expect(q.reason).toBe("delta_exceeds_sigma_bound");
    const detail = JSON.parse(q.detail as string);
    expect(detail[0].field).toBe("player_count");
    expect(detail[0].observed_value).toBe(3_552);
    expect(typeof detail[0].recent_delta_stddev).toBe("number");
  });

  it("a missing quarantine table (migration 0003 unapplied) never costs the core archive rows", async () => {
    const kv = fakeKv();
    const db = new WriteFakeD1();
    db.failTables.add("quarantined_samples"); // partial migration rollout
    seedStore(kv, steadySeries(12, NOW - 10 * MINUTE));

    // A quarantine-producing tick WITH a core planet observation: the
    // quarantine batch is rejected, the planet row still lands (separate
    // batch), and the failure is swallowed — never a thrown error.
    await samplePlanetRates(
      envWith(kv, db),
      [{ planetIndex: 185, health: 900_000, campaignId: 52 }],
      NOW,
      {
        globalStatistics: statsOf(3_552), // Nσ outlier → diverted
        globalImpactMultiplier: 1.2,
        globalActiveCampaignCount: 5,
      },
    );

    expect(db.tables.planet_samples).toHaveLength(1); // core append survived
    expect(db.tables.global_samples).toHaveLength(0); // diverted, as always
    expect(db.tables.quarantined_samples).toHaveLength(0); // lost with a warn only
    expect(db.batches).toBe(2); // core batch + the rejected optional batch
  });

  it("a plausible tick archives normally — no quarantine row", async () => {
    const kv = fakeKv();
    const db = new WriteFakeD1();
    seedStore(kv, steadySeries(12, NOW - 10 * MINUTE));

    await samplePlanetRates(envWith(kv, db), [], NOW, {
      globalStatistics: statsOf(40_400),
      globalImpactMultiplier: 1.2,
      globalActiveCampaignCount: 5,
    });

    expect(db.tables.global_samples).toHaveLength(1);
    expect(db.tables.quarantined_samples).toHaveLength(0);
  });

  it("thin history abstains: the row archives (never a cold-start guess)", async () => {
    const kv = fakeKv();
    const db = new WriteFakeD1();
    seedStore(kv, steadySeries(3, NOW - 10 * MINUTE)); // 2 deltas < minimum

    await samplePlanetRates(envWith(kv, db), [], NOW, {
      globalStatistics: statsOf(3_552),
      globalImpactMultiplier: 1.2,
      globalActiveCampaignCount: 5,
    });

    expect(db.tables.global_samples).toHaveLength(1);
    expect(db.tables.quarantined_samples).toHaveLength(0);
  });
});

/* --------------------- item 8: gap/cadence + tool ---------------------- */

describe("buildGapList / cadenceStats (item 8, pure)", () => {
  it("flags only spacings over the threshold, with exact bounds", () => {
    const ts = [NOW, NOW + 10 * MINUTE, NOW + 20 * MINUTE, NOW + 140 * MINUTE];
    const gaps = buildGapList(ts, 15 * MINUTE);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.gap_start).toBe(new Date(NOW + 20 * MINUTE).toISOString());
    expect(gaps[0]!.gap_end).toBe(new Date(NOW + 140 * MINUTE).toISOString());
    expect(gaps[0]!.gap_minutes).toBe(120);
  });

  it("cadenceStats reports intervals within threshold and the expected-tick shortfall", () => {
    // 7 samples over 3h at 10-min spacing, with one 2h hole.
    const ts = [0, 10, 20, 140, 150, 160, 170].map((m) => NOW + m * MINUTE);
    const s = cadenceStats(ts, 10 * MINUTE, 15 * MINUTE);
    expect(s.samples).toBe(7);
    expect(s.intervals).toBe(6);
    expect(s.intervals_within_threshold).toBe(5);
    expect(s.adherence_pct).toBeCloseTo((5 / 6) * 100, 6);
    expect(s.ticks_expected_over_span).toBe(18); // 170 min span / 10 min + 1
    expect(s.ticks_archived).toBe(7);
  });

  it("empty/singleton input yields null adherence, no gaps", () => {
    expect(buildGapList([], 15 * MINUTE)).toEqual([]);
    expect(cadenceStats([NOW], 10 * MINUTE, 15 * MINUTE).adherence_pct).toBeNull();
  });
});

describe("get_health (item 8)", () => {
  it("returns non-null counts, flags the seeded restore gap, and tallies quarantine by reason", async () => {
    const kv = fakeKv();
    const db = new WriteFakeD1();
    const base = Date.now();
    // 10-min cadence with a 6h hole (the June-19-restore-gap shape).
    const times: number[] = [];
    for (let m = 24 * 60; m > 6 * 60 + 60; m -= 10) times.push(base - m * MINUTE);
    for (let m = 60; m >= 10; m -= 10) times.push(base - m * MINUTE);
    db.tables.global_samples = times.map((t, i) => ({ id: i + 1, sampled_at: t }));
    db.tables.quarantined_samples = [
      {
        table_name: "global_samples",
        subject_key: "global",
        sampled_at: base - 2 * HOUR,
        reason: "known_sentinel_signature",
        detail: "[]",
        row_json: "{}",
        tick_anchor: 1,
      },
      {
        table_name: "global_samples",
        subject_key: "global",
        sampled_at: base - HOUR,
        reason: "delta_exceeds_sigma_bound",
        detail: "[]",
        row_json: "{}",
        tick_anchor: 2,
      },
    ];

    const out = (await getHealth(envWith(kv, db), {})) as Record<string, any>;
    expect(out.archive_row_counts.global_samples).toBe(times.length);
    expect(out.archive_row_counts.quarantined_samples).toBe(2);
    expect(out.gap_count).toBe(1);
    expect(out.gaps[0].gap_minutes).toBeGreaterThan(5 * 60);
    expect(out.cadence.adherence_pct).toBeLessThan(100);
    expect(out.cadence.adherence_pct).toBeGreaterThan(90);
    expect(out.quarantine.counts_by_reason).toEqual({
      delta_exceeds_sigma_bound: 1,
      known_sentinel_signature: 1,
    });
    expect(out.quarantine.recent).toHaveLength(2);
    expect(out.quarantine.recent[0].reason).toBe("delta_exceeds_sigma_bound");
    // Read-only: zero KV writes.
    expect(kv.puts).toHaveLength(0);
  });
});
