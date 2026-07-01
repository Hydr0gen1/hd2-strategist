/**
 * Stage 18 tests — Tier 4 of the next-features wave:
 *
 * Item 9: the per-planet CSV export through the resource-link transport —
 * export_archive(table:'planet', planet_index:…) resource read returns ONLY
 * that planet's rows.
 *
 * Item 10: the Major Order outcome log — when a tracked MO id leaves the live
 * assignments set, each objective's FINAL observed state (progress/target,
 * target_reached) is recorded to mo_outcomes (idempotent natural-PK insert);
 * get_major_order_archive serves the past outcomes.
 *
 * Same sanctioned stubs as stage15/17: the in-memory KV and small D1 stubs.
 */
import { describe, expect, it } from "vitest";

import { samplePlanetRates } from "../src/client";
import { handleMcpRequest } from "../src/mcp";
import { getMajorOrderArchive } from "../src/tools";
import type { Env } from "../src/types";
import type { MoObjectiveSeries } from "../src/sampling";

const NOW = 1_780_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/* ---------------------------- KV stub --------------------------------- */

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

/* ----------------------------- D1 stub -------------------------------- */

/** Executes archive INSERTs into per-table arrays (with the mo_outcomes
 * natural-PK INSERT OR IGNORE emulated) and answers the export keyset/COUNT
 * SELECTs plus the mo archive/outcome reads. */
class FakeD1 {
  tables: Record<string, Record<string, unknown>[]> = {
    planet_samples: [],
    global_samples: [],
    mo_progress_samples: [],
    observed_signatures: [],
    quarantined_samples: [],
    mo_outcomes: [],
  };
  batches = 0;

  prepare(sql: string) {
    const db = this;
    // bind() returns a NEW bound statement (real D1 semantics) — the archive
    // code prepares once and binds per row, so aliasing would corrupt batches.
    const bound = (vals: unknown[]) => ({
      sql,
      vals,
      bind(...next: unknown[]) {
        return bound(next);
      },
      async all() {
        return { results: db.select(sql, vals) };
      },
      async first() {
        return db.select(sql, vals)[0] ?? null;
      },
    });
    return bound([]);
  }

  select(sql: string, binds: unknown[]): Record<string, unknown>[] {
    const table = (sql.match(/FROM (\w+)/) ?? [])[1] ?? "";
    let rows = this.tables[table] ?? [];
    const b = [...binds];

    if (sql.includes("COUNT(*)") && sql.includes("MAX(id)")) {
      // Export snapshot COUNT: honor the window/planet predicate.
      if (sql.includes("sampled_at >=")) {
        const since = b.shift() as number;
        rows = rows.filter((r) => (r.sampled_at as number) >= since);
      }
      if (sql.includes("sampled_at <=")) {
        const until = b.shift() as number;
        rows = rows.filter((r) => (r.sampled_at as number) <= until);
      }
      if (sql.includes("planet_index = ?")) {
        const p = b.shift() as number;
        rows = rows.filter((r) => r.planet_index === p);
      }
      const ids = rows.map((r) => r.id as number);
      return [{ n: rows.length, max_id: ids.length ? Math.max(...ids) : null }];
    }

    if (sql.includes("id >")) {
      // Export keyset page.
      const curTs = b.shift() as number;
      b.shift();
      const curId = b.shift() as number;
      const limit = b.pop() as number;
      let since = -Infinity;
      let until = Infinity;
      let planet: number | null = null;
      let maxId = Infinity;
      if (sql.includes("sampled_at >=")) since = b.shift() as number;
      if (sql.includes("sampled_at <=")) until = b.shift() as number;
      if (sql.includes("planet_index = ?")) planet = b.shift() as number;
      if (sql.includes("id <=")) maxId = b.shift() as number;
      return rows
        .filter(
          (r) =>
            ((r.sampled_at as number) > curTs ||
              (r.sampled_at === curTs && (r.id as number) > curId)) &&
            (r.sampled_at as number) >= since &&
            (r.sampled_at as number) <= until &&
            (planet == null || r.planet_index === planet) &&
            (r.id as number) <= maxId,
        )
        .sort(
          (x, y) =>
            (x.sampled_at as number) - (y.sampled_at as number) ||
            (x.id as number) - (y.id as number),
        )
        .slice(0, limit);
    }

    if (table === "mo_outcomes") {
      let out = [...rows];
      if (sql.includes("major_order_id = ?")) {
        const id = b.shift() as number;
        out = out.filter((r) => r.major_order_id === id);
      }
      if (sql.includes("objective_index = ?")) {
        const oi = b.shift() as number;
        out = out.filter((r) => r.objective_index === oi);
      }
      const limit = b.shift() as number;
      out.sort(
        (x, y) => (y.recorded_at as number) - (x.recorded_at as number),
      );
      return out.slice(0, limit ?? out.length);
    }

    if (table === "mo_progress_samples") {
      // The archive read: WHERE sampled_at >= ? [filters] ORDER BY DESC LIMIT ?
      const since = b.shift() as number;
      let out = rows.filter((r) => (r.sampled_at as number) >= since);
      if (sql.includes("major_order_id = ?")) {
        const id = b.shift() as number;
        out = out.filter((r) => r.major_order_id === id);
      }
      if (sql.includes("objective_index = ?")) {
        const oi = b.shift() as number;
        out = out.filter((r) => r.objective_index === oi);
      }
      const limit = b.shift() as number;
      return out
        .sort((x, y) => (y.sampled_at as number) - (x.sampled_at as number))
        .slice(0, limit);
    }

    return rows;
  }

  async batch(stmts: { sql: string; vals: unknown[] }[]) {
    this.batches += 1;
    for (const s of stmts) {
      const m = s.sql.match(/INTO (\w+)\s*\(([^)]+)\)/);
      if (!m) continue;
      const table = m[1]!;
      const cols = m[2]!.split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => (row[c] = s.vals[i]));
      if (table === "mo_outcomes") {
        // Emulate the natural PK: INSERT OR IGNORE no-ops on a repeat.
        const dup = this.tables.mo_outcomes!.some(
          (r) =>
            r.major_order_id === row.major_order_id &&
            r.objective_index === row.objective_index,
        );
        if (dup) continue;
      }
      (this.tables[table] ??= []).push(row);
    }
    return stmts.map(() => ({ results: [] }));
  }
}

function envWith(kv: FakeKv | null, db: FakeD1): Env {
  return {
    ...(kv ? { WAR_CACHE: kv as unknown as KVNamespace } : {}),
    HISTORY_DB: db as unknown as Env["HISTORY_DB"],
  };
}

async function rpc(
  env: Env,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const res = await handleMcpRequest(
    new Request("https://strategist.example.workers.dev/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
  );
  return res.json();
}

/* ------------------ item 9: per-planet resource export ----------------- */

describe("export_archive planet filter via resource link (item 9)", () => {
  it("reading the resource yields ONLY the filtered planet's rows", async () => {
    const db = new FakeD1();
    let id = 1;
    for (let i = 0; i < 30; i++) {
      const t = NOW - (30 - i) * HOUR;
      db.tables.planet_samples!.push({
        id: id++,
        sampled_at: t,
        planet_index: 185, // Karlia
        health: 1_000_000 - i * 1000,
        max_health: 1_000_000,
        hp_per_hour: null,
        campaign_id: 52,
        campaign_kind: "defense",
        faction: "Illuminate",
      });
      db.tables.planet_samples!.push({
        id: id++,
        sampled_at: t,
        planet_index: 273, // noise from another planet
        health: 500_000,
        max_health: 1_000_000,
        hp_per_hour: null,
        campaign_id: 51,
        campaign_kind: "liberation",
        faction: "Illuminate",
      });
    }
    const env = envWith(null, db);

    const call = await rpc(env, "tools/call", {
      name: "export_archive",
      arguments: { table: "planet", planet_index: 185 },
    });
    const meta = JSON.parse(call.result.content[0].text);
    expect(meta.row_count).toBe(30);
    expect(meta.planet_index).toBe(185);
    const link = call.result.content[1];
    expect(link.type).toBe("resource_link");
    expect(link.uri).toContain("planet_index=185");

    const read = await rpc(env, "resources/read", { uri: link.uri });
    const lines: string[] = read.result.contents[0].text.trim().split("\n");
    expect(lines).toHaveLength(1 + 30);
    const cols = lines[0]!.split(",");
    const planetCol = cols.indexOf("planet_index");
    for (const line of lines.slice(1)) {
      expect(line.split(",")[planetCol]).toBe("185"); // only Karlia rows
    }
  });
});

/* -------------------- item 10: the MO outcome log ---------------------- */

/** A retained series for MO 111 with two objectives: one that reached its
 * target by the last observation, one that did not. */
function retiredMoSeries(): MoObjectiveSeries[] {
  return [
    {
      major_order_id: 111,
      objective_index: 0,
      task_type: 9,
      samples: [
        { t: NOW - 3 * HOUR, progress: 700, target: 1000 },
        { t: NOW - 10 * MINUTE, progress: 1050, target: 1000 }, // reached
      ],
    },
    {
      major_order_id: 111,
      objective_index: 1,
      task_type: 13,
      samples: [
        { t: NOW - 3 * HOUR, progress: 1, target: 3 },
        { t: NOW - 10 * MINUTE, progress: 2, target: 3 }, // not reached
      ],
    },
  ];
}

function seedStore(kv: FakeKv, mo: MoObjectiveSeries[]): void {
  kv.store.set(
    "samples:planets",
    JSON.stringify({ planets: {}, campaignsFirstSeen: {}, mo }),
  );
}

describe("MO outcome log write path (item 10)", () => {
  const planetInput = [
    { planetIndex: 185, health: 900_000, campaignId: 52 },
  ];

  it("an MO absent from live observations records each objective's final state (win AND loss)", async () => {
    const kv = fakeKv();
    const db = new FakeD1();
    seedStore(kv, retiredMoSeries());

    // A fresh poll whose assignments name ONLY the new MO 222 — 111 has ended.
    await samplePlanetRates(envWith(kv, db), planetInput, NOW, {
      moProgress: [
        {
          majorOrderId: 222,
          objectiveIndex: 0,
          taskType: 9,
          progress: 5,
          target: 100,
        },
      ],
    });

    const outcomes = db.tables.mo_outcomes!;
    expect(outcomes).toHaveLength(2);
    const [o0, o1] = [
      outcomes.find((o) => o.objective_index === 0)!,
      outcomes.find((o) => o.objective_index === 1)!,
    ];
    expect(o0.major_order_id).toBe(111);
    expect(o0.final_progress).toBe(1050);
    expect(o0.target).toBe(1000);
    expect(o0.target_reached).toBe(1);
    expect(o0.final_progress_pct).toBeCloseTo(105, 6);
    expect(o1.target_reached).toBe(0);
    expect(o1.final_progress).toBe(2);
    expect(o1.last_observed_at).toBe(NOW - 10 * MINUTE);
    // The new MO 222 is NOT an outcome — it is live.
    expect(outcomes.some((o) => o.major_order_id === 222)).toBe(false);
  });

  it("re-detection on a later tick is a no-op (natural-PK INSERT OR IGNORE)", async () => {
    const kv = fakeKv();
    const db = new FakeD1();
    seedStore(kv, retiredMoSeries());
    const env = envWith(kv, db);

    await samplePlanetRates(env, planetInput, NOW, { moProgress: [] });
    expect(db.tables.mo_outcomes).toHaveLength(2);
    // The retired series is still retained → detection fires again; dedup holds.
    await samplePlanetRates(env, planetInput, NOW + 2 * MINUTE, {
      moProgress: [],
    });
    expect(db.tables.mo_outcomes).toHaveLength(2);
  });

  it("a poll WITHOUT assignments data abstains — absence of observations is not an ended order", async () => {
    const kv = fakeKv();
    const db = new FakeD1();
    seedStore(kv, retiredMoSeries());

    // The quiet-probe shape: no moProgress key at all.
    await samplePlanetRates(envWith(kv, db), planetInput, NOW, {
      carryForward: true,
    });
    expect(db.tables.mo_outcomes).toHaveLength(0);
  });

  it("an MO still present in the live observations is never recorded as an outcome", async () => {
    const kv = fakeKv();
    const db = new FakeD1();
    seedStore(kv, retiredMoSeries());

    await samplePlanetRates(envWith(kv, db), planetInput, NOW, {
      moProgress: [
        {
          majorOrderId: 111,
          objectiveIndex: 0,
          taskType: 9,
          progress: 1100,
          target: 1000,
        },
      ],
    });
    expect(db.tables.mo_outcomes).toHaveLength(0);
  });
});

describe("get_major_order_archive outcomes read (item 10)", () => {
  it("serves past orders' outcomes with target_reached as a boolean", async () => {
    const db = new FakeD1();
    db.tables.mo_outcomes = [
      {
        major_order_id: 111,
        objective_index: 0,
        task_type: 9,
        final_progress: 1050,
        target: 1000,
        final_progress_pct: 105,
        target_reached: 1,
        first_observed_at: NOW - 3 * HOUR,
        last_observed_at: NOW - 10 * MINUTE,
        recorded_at: NOW,
      },
      {
        major_order_id: 111,
        objective_index: 1,
        task_type: 13,
        final_progress: 2,
        target: 3,
        final_progress_pct: (2 / 3) * 100,
        target_reached: 0,
        first_observed_at: NOW - 3 * HOUR,
        last_observed_at: NOW - 10 * MINUTE,
        recorded_at: NOW,
      },
    ];

    const out = (await getMajorOrderArchive(envWith(null, db), {})) as Record<
      string,
      any
    >;
    expect(out.outcomes).toHaveLength(2);
    expect(out.outcomes[0].target_reached).toBe(true);
    expect(out.outcomes[1].target_reached).toBe(false);
    expect(out.outcomes[0].recorded_at_iso).toBe(new Date(NOW).toISOString());
    expect(out.outcomes_note).toBeUndefined();
    // No forecast/verdict key sneaks in.
    for (const o of out.outcomes) {
      for (const k of Object.keys(o)) {
        expect(k).not.toMatch(/forecast|verdict|recommend|trend|score/i);
      }
    }
  });

  it("narrows outcomes by major_order_id", async () => {
    const db = new FakeD1();
    db.tables.mo_outcomes = [
      { major_order_id: 111, objective_index: 0, recorded_at: NOW, target_reached: 1 },
      { major_order_id: 99, objective_index: 0, recorded_at: NOW - HOUR, target_reached: 0 },
    ];
    const out = (await getMajorOrderArchive(envWith(null, db), {
      major_order_id: 99,
    })) as Record<string, any>;
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0].major_order_id).toBe(99);
  });

  it("narrows outcomes by objective_index too — an objective-specific read never mixes in siblings", async () => {
    const db = new FakeD1();
    db.tables.mo_outcomes = [
      { major_order_id: 111, objective_index: 0, recorded_at: NOW, target_reached: 1 },
      { major_order_id: 111, objective_index: 1, recorded_at: NOW, target_reached: 0 },
    ];
    const out = (await getMajorOrderArchive(envWith(null, db), {
      major_order_id: 111,
      objective_index: 1,
    })) as Record<string, any>;
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0].objective_index).toBe(1);
    expect(out.outcomes[0].target_reached).toBe(false);
  });
});
