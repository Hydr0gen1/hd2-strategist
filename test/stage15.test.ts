/**
 * Stage 15 tests — Tier 1 of the next-features wave:
 *
 * Item 1: the export resource_link handoff. export_archive returns an MCP
 * `resource_link` content item beside the metadata JSON, and `resources/read`
 * on that URI yields the FULL CSV (matching row_count, not capped at the JSON
 * tools' 1000 rows) through the connector.
 *
 * Item 2: `until_hours` — the JSON archive tools' window gains an end cutoff,
 * so older bands can be paged and adjacent slices reconstruct the whole table.
 *
 * Sanctioned in-memory D1 stub (same spirit as stage12/stage14): answers the
 * export keyset SELECT + COUNT and the archive read SELECTs over rows held in
 * arrays, recording every SQL string so the parameterized-SQL pin holds.
 */
import { describe, expect, it } from "vitest";

import {
  readGlobalArchive,
  readMoArchive,
  readPlanetArchive,
  untilCutoffMs,
} from "../src/archive";
import { collectArchiveCsv, parseExportResourceUri } from "../src/export";
import { handleMcpRequest } from "../src/mcp";
import { getGlobalArchive, ToolError } from "../src/tools";
import type { Env } from "../src/types";

const NOW = 1_780_000_000_000;
const HOUR = 3_600_000;

/* ====================================================================== *
 * In-memory D1 stub: export keyset SELECT/COUNT + archive read SELECTs.
 * ====================================================================== */

interface AnyRow {
  id: number;
  sampled_at: number;
  [k: string]: number | string | null;
}

class FakeD1 {
  rows: Record<string, AnyRow[]> = {
    global_samples: [],
    planet_samples: [],
    mo_progress_samples: [],
  };
  sqls: string[] = [];

  prepare(sql: string) {
    return new Prepared(this, sql);
  }
}

class Prepared {
  private binds: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  bind(...vals: unknown[]) {
    this.binds = vals;
    return this;
  }

  private table(): string {
    const m = this.sql.match(/FROM (\w+)/);
    return m ? m[1]! : "";
  }

  /** Every value must arrive via bind() — the SQL itself may only contain `?`
   * placeholders; a literal number in a predicate would fail this parse. */
  private matches(): AnyRow[] {
    const rows = this.db.rows[this.table()] ?? [];
    const isKeyset = this.sql.includes("id >");
    let b = [...this.binds];
    let curTs = -Infinity;
    let curId = -Infinity;
    let limit = Infinity;
    if (isKeyset) {
      curTs = b.shift() as number;
      b.shift();
      curId = b.shift() as number;
    }
    if (this.sql.includes("LIMIT ?")) limit = b.pop() as number;
    let since = -Infinity;
    let until = Infinity;
    let planet: number | null = null;
    let moId: number | null = null;
    let objIdx: number | null = null;
    let maxId = Infinity;
    if (this.sql.includes("planet_index = ?") && !isKeyset) {
      planet = b.shift() as number;
    }
    if (this.sql.includes("sampled_at >=")) since = b.shift() as number;
    if (this.sql.includes("sampled_at <=")) until = b.shift() as number;
    if (this.sql.includes("planet_index = ?") && isKeyset) {
      planet = b.shift() as number;
    }
    if (this.sql.includes("major_order_id = ?")) moId = b.shift() as number;
    if (this.sql.includes("objective_index = ?")) objIdx = b.shift() as number;
    if (this.sql.includes("id <=")) maxId = b.shift() as number;

    let out = rows.filter((r) => {
      if (
        isKeyset &&
        !(r.sampled_at > curTs || (r.sampled_at === curTs && r.id > curId))
      ) {
        return false;
      }
      if (r.sampled_at < since || r.sampled_at > until) return false;
      if (planet != null && r.planet_index !== planet) return false;
      if (moId != null && r.major_order_id !== moId) return false;
      if (objIdx != null && r.objective_index !== objIdx) return false;
      if (r.id > maxId) return false;
      return true;
    });
    const desc = this.sql.includes("ORDER BY sampled_at DESC");
    out = out.sort((x, y) =>
      desc
        ? y.sampled_at - x.sampled_at || y.id - x.id
        : x.sampled_at - y.sampled_at || x.id - y.id,
    );
    if (limit !== Infinity) out = out.slice(0, limit);
    return out;
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.db.sqls.push(this.sql);
    return { results: this.matches() as unknown as T[] };
  }

  async first<T>(): Promise<T> {
    this.db.sqls.push(this.sql);
    const matched = this.matches();
    const maxId = matched.length
      ? matched.reduce((m, r) => Math.max(m, r.id), -Infinity)
      : null;
    return { n: matched.length, max_id: maxId } as unknown as T;
  }
}

function envWith(db: FakeD1): Env {
  return { HISTORY_DB: db as unknown as Env["HISTORY_DB"] };
}

/** Seed n global rows, one per hour ascending (newest is 1h before NOW). */
function seedGlobal(db: FakeD1, n: number): void {
  for (let i = 0; i < n; i++) {
    db.rows.global_samples!.push({
      id: i + 1,
      sampled_at: NOW - (n - i) * HOUR,
      player_count: 1000 + i,
      impact_multiplier: 1,
      active_campaign_count: 5,
      missions_won: 100 + i,
      missions_lost: i,
      deaths: i,
      terminid_kills: i,
      automaton_kills: i,
      illuminate_kills: null,
    });
  }
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

/* ====================================================================== *
 * Item 1 — resource_link + resources/read
 * ====================================================================== */

describe("export_archive resource_link (item 1)", () => {
  it("initialize advertises the resources capability", async () => {
    const body = await rpc(envWith(new FakeD1()), "initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(body.result.capabilities.resources).toEqual({});
  });

  it("returns a resource_link beside the metadata text", async () => {
    const db = new FakeD1();
    seedGlobal(db, 50);
    const body = await rpc(envWith(db), "tools/call", {
      name: "export_archive",
      arguments: { table: "global" },
    });
    const content = body.result.content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    const meta = JSON.parse(content[0].text);
    expect(meta.row_count).toBe(50);
    const link = content[1];
    expect(link.type).toBe("resource_link");
    expect(link.uri).toBe(meta.url);
    expect(link.mimeType).toBe("text/csv");
    expect(link.name).toContain("global");
  });

  it("resources/read on the link yields the FULL CSV — row count matches COUNT(*), not capped at 1000", async () => {
    const db = new FakeD1();
    seedGlobal(db, 1500); // past the JSON tools' 1000-row cap
    const env = envWith(db);
    const call = await rpc(env, "tools/call", {
      name: "export_archive",
      arguments: { table: "global" },
    });
    const meta = JSON.parse(call.result.content[0].text);
    const uri = call.result.content[1].uri;
    expect(meta.row_count).toBe(1500);

    const read = await rpc(env, "resources/read", { uri });
    expect(read.error).toBeUndefined();
    const contents = read.result.contents;
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe(uri);
    expect(contents[0].mimeType).toBe("text/csv");
    const lines = contents[0].text.trim().split("\n");
    expect(lines).toHaveLength(1 + 1500); // header + every row
    expect(lines[0]).toContain("sampled_at");
    expect(lines[0]).toContain("player_count");
  });

  it("the resource read serves the SAME frozen snapshot: a row committed after the tool call is excluded", async () => {
    const db = new FakeD1();
    seedGlobal(db, 10);
    const env = envWith(db);
    const call = await rpc(env, "tools/call", {
      name: "export_archive",
      arguments: { table: "global" },
    });
    const uri = call.result.content[1].uri;
    // A late-committing tick: higher id, inside the frozen window.
    db.rows.global_samples!.push({
      id: 999,
      sampled_at: NOW - 5 * HOUR,
      player_count: 1,
      impact_multiplier: 1,
      active_campaign_count: 1,
      missions_won: 1,
      missions_lost: 1,
      deaths: 1,
      terminid_kills: 1,
      automaton_kills: 1,
      illuminate_kills: 1,
    });
    const read = await rpc(env, "resources/read", { uri });
    const lines = read.result.contents[0].text.trim().split("\n");
    expect(lines).toHaveLength(1 + 10); // the watermark excludes the late row
  });

  it("resources/read rejects a non-export URI with -32002 and resources/list is empty", async () => {
    const env = envWith(new FakeD1());
    const bad = await rpc(env, "resources/read", {
      uri: "https://example.com/other/thing",
    });
    expect(bad.error.code).toBe(-32002);
    const list = await rpc(env, "resources/list", {});
    expect(list.result.resources).toEqual([]);
  });

  it("parseExportResourceUri round-trips a minted URL and rejects garbage", () => {
    const p = parseExportResourceUri(
      "https://w.example/export/archive?table=planet&planet_index=185&max_id=42",
      NOW,
    );
    expect(p).not.toBeNull();
    expect(p!.table).toBe("planet");
    expect(p!.planetIndex).toBe(185);
    expect(p!.maxId).toBe(42);
    expect(parseExportResourceUri("not a uri", NOW)).toBeNull();
    expect(parseExportResourceUri("https://w.example/elsewhere", NOW)).toBeNull();
  });

  it("collectArchiveCsv paginates across pages into one string", async () => {
    const db = new FakeD1();
    seedGlobal(db, 7);
    const csv = await collectArchiveCsv(
      envWith(db),
      {
        table: "global",
        planetIndex: null,
        sinceMs: null,
        untilMs: null,
        bucket: "raw",
      },
      3, // page size 3 → 3 pages
    );
    expect(csv.trim().split("\n")).toHaveLength(1 + 7);
  });
});

/* ====================================================================== *
 * Item 2 — until_hours end cutoff
 * ====================================================================== */

describe("archive until_hours (item 2)", () => {
  it("untilCutoffMs resolves hours-back-from-now, absent/invalid → null", () => {
    expect(untilCutoffMs(200, NOW)).toBe(NOW - 200 * HOUR);
    expect(untilCutoffMs(0, NOW)).toBe(NOW);
    expect(untilCutoffMs(undefined, NOW)).toBeNull();
    expect(untilCutoffMs(-5, NOW)).toBeNull();
    expect(untilCutoffMs(Number.NaN, NOW)).toBeNull();
  });

  it("readGlobalArchive with an until edge returns only the older band, parameterized", async () => {
    const db = new FakeD1();
    seedGlobal(db, 500);
    const since = NOW - 400 * HOUR;
    const until = NOW - 200 * HOUR;
    const rows = await readGlobalArchive(envWith(db), since, 1000, until);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.sampled_at).toBeGreaterThanOrEqual(since);
      expect(r.sampled_at).toBeLessThanOrEqual(until);
    }
    const sql = db.sqls[db.sqls.length - 1]!;
    expect(sql).toContain("sampled_at <= ?");
    expect(sql).not.toMatch(/sampled_at <= \d/);
  });

  it("without until the SQL is byte-identical to the pre-item-2 query", async () => {
    const db = new FakeD1();
    seedGlobal(db, 5);
    await readGlobalArchive(envWith(db), NOW - 10 * HOUR, 1000);
    expect(db.sqls[db.sqls.length - 1]).not.toContain("sampled_at <=");
  });

  it("readPlanetArchive and readMoArchive honor the until edge", async () => {
    const db = new FakeD1();
    for (let i = 0; i < 10; i++) {
      db.rows.planet_samples!.push({
        id: i + 1,
        sampled_at: NOW - (10 - i) * HOUR,
        planet_index: 185,
        health: 1000 - i,
        max_health: 1000,
        hp_per_hour: null,
        campaign_id: 7,
        campaign_kind: "liberation",
        faction: "Illuminate",
      });
      db.rows.mo_progress_samples!.push({
        id: i + 1,
        sampled_at: NOW - (10 - i) * HOUR,
        major_order_id: 4444,
        objective_index: 0,
        progress: i,
        target: 10,
      });
    }
    const until = NOW - 5 * HOUR;
    const planetRows = await readPlanetArchive(
      envWith(db),
      185,
      NOW - 100 * HOUR,
      1000,
      until,
    );
    expect(planetRows.length).toBe(6);
    expect(Math.max(...planetRows.map((r) => r.sampled_at))).toBeLessThanOrEqual(
      until,
    );
    const moRows = await readMoArchive(envWith(db), NOW - 100 * HOUR, 1000, {
      majorOrderId: 4444,
      untilMs: until,
    });
    expect(moRows.length).toBe(6);
    expect(Math.max(...moRows.map((r) => r.sampled_at))).toBeLessThanOrEqual(
      until,
    );
  });

  it("getGlobalArchive slices an older band and adjacent slices reconstruct the table", async () => {
    const db = new FakeD1();
    // The handler windows off the real clock — seed hourly rows back from it.
    const base = Date.now();
    for (let i = 0; i < 450; i++) {
      db.rows.global_samples!.push({
        id: i + 1,
        sampled_at: base - (450 - i) * HOUR,
        player_count: 1000 + i,
        impact_multiplier: 1,
        active_campaign_count: 5,
        missions_won: 100 + i,
        missions_lost: i,
        deaths: i,
        terminid_kills: i,
        automaton_kills: i,
        illuminate_kills: null,
      });
    }
    const env = envWith(db);

    const older = (await getGlobalArchive(env, {
      since_hours: 400,
      until_hours: 200,
    })) as any;
    expect(older.until_hours).toBe(200);
    expect(older.samples.length).toBeGreaterThan(0);
    for (const s of older.samples) {
      expect(s.t).toBeGreaterThanOrEqual(base - 400 * HOUR - 1);
      expect(s.t).toBeLessThanOrEqual(base - 200 * HOUR);
    }

    const newer = (await getGlobalArchive(env, {
      since_hours: 200,
      until_hours: 0,
    })) as any;
    const oldest = (await getGlobalArchive(env, {
      since_hours: 500,
      until_hours: 400,
    })) as any;
    const seen = new Set<number>([
      ...oldest.samples.map((s: any) => s.t),
      ...older.samples.map((s: any) => s.t),
      ...newer.samples.map((s: any) => s.t),
    ]);
    expect(seen.size).toBe(450); // the slices cover every stored row exactly
  });

  it("rejects an inverted (empty) window loudly", async () => {
    const db = new FakeD1();
    seedGlobal(db, 10);
    await expect(
      getGlobalArchive(envWith(db), { since_hours: 100, until_hours: 200 }),
    ).rejects.toThrow(ToolError);
  });
});
