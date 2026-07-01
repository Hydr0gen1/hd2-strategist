/**
 * Stage 14 tests: the bulk archive CSV export (`export_archive` MCP tool +
 * `GET /export/archive` streaming route). PURELY ADDITIVE — the row-capped
 * get_*_archive tools are unchanged (covered by stage12.test.ts, still green).
 *
 * Sanctioned in-memory stub (same spirit as the stage12 FakeD1): a small D1 that
 * answers the export's keyset SELECT and COUNT over rows held in arrays. No real
 * SQLite, no network. The stub records the SELECT SQL so we can pin that values
 * are bound (`?` placeholders), never interpolated.
 */
import { describe, expect, it } from "vitest";

import {
  buildExportUrl,
  exportArchive,
  exportColumns,
  handleExportArchive,
  parseExportParams,
  streamArchiveCsv,
  type ExportParams,
} from "../src/export";
import type { Env } from "../src/types";

const NOW = 1_780_000_000_000;
const HOUR = 3_600_000;

/* ====================================================================== *
 * In-memory D1 that understands the export queries (keyset SELECT + COUNT)
 * ====================================================================== */

interface AnyRow {
  id: number;
  sampled_at: number;
  [k: string]: number | string | null;
}

class ExportFakeD1 {
  rows: { global_samples: AnyRow[]; planet_samples: AnyRow[]; mo_progress_samples: AnyRow[] } = {
    global_samples: [],
    planet_samples: [],
    mo_progress_samples: [],
  };
  selectSqls: string[] = [];
  /** Simulate a bound-but-unmigrated D1: every query throws "no such table". */
  failQueries = false;

  prepare(sql: string) {
    return new ExportPrepared(this, sql);
  }
}

class ExportPrepared {
  private binds: unknown[] = [];
  constructor(private db: ExportFakeD1, private sql: string) {}

  bind(...vals: unknown[]) {
    this.binds = vals;
    return this;
  }

  private table(): string {
    const m = this.sql.match(/FROM (\w+)/);
    return m ? m[1]! : "";
  }

  private matches(rows: AnyRow[]): AnyRow[] {
    // Parse the predicate by matching the known SQL shapes the module emits.
    // Keyset SELECT: WHERE (sampled_at > ? OR (sampled_at = ? AND id > ?)) [AND sampled_at >= ?] [AND sampled_at <= ?] [AND planet_index = ?] ORDER BY ... LIMIT ?
    // COUNT: SELECT COUNT(*) ... [WHERE sampled_at >= ? [AND sampled_at <= ?] [AND planet_index = ?]]
    const isKeyset = this.sql.includes("id >");
    let b = [...this.binds];
    let curTs = -Infinity;
    let curId = -Infinity;
    let limit = Infinity;
    if (isKeyset) {
      curTs = b.shift() as number; // sampled_at > ?
      b.shift(); // sampled_at = ? (same value)
      curId = b.shift() as number;
      limit = b.pop() as number; // trailing LIMIT ?
    }
    let since = -Infinity;
    let until = Infinity;
    let planet: number | null = null;
    let maxId = Infinity;
    if (this.sql.includes("sampled_at >=")) since = b.shift() as number;
    if (this.sql.includes("sampled_at <=")) until = b.shift() as number;
    if (this.sql.includes("planet_index =")) planet = b.shift() as number;
    if (this.sql.includes("id <=")) maxId = b.shift() as number;

    let out = rows.filter((r) => {
      if (isKeyset && !(r.sampled_at > curTs || (r.sampled_at === curTs && r.id > curId)))
        return false;
      if (r.sampled_at < since) return false;
      if (r.sampled_at > until) return false;
      if (planet != null && r.planet_index !== planet) return false;
      if (r.id > maxId) return false;
      return true;
    });
    out = out.sort((x, y) => x.sampled_at - y.sampled_at || x.id - y.id);
    if (limit !== Infinity) out = out.slice(0, limit);
    return out;
  }

  private tableRows(): AnyRow[] {
    return this.db.rows[this.table() as keyof ExportFakeD1["rows"]] ?? [];
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.db.failQueries) throw new Error("no such table: " + this.table());
    this.db.selectSqls.push(this.sql);
    return { results: this.matches(this.tableRows()) as unknown as T[] };
  }

  async first<T>(): Promise<T> {
    if (this.db.failQueries) throw new Error("no such table: " + this.table());
    const matched = this.matches(this.tableRows());
    const maxId = matched.length
      ? matched.reduce((m, r) => Math.max(m, r.id), -Infinity)
      : null;
    return { n: matched.length, max_id: maxId } as unknown as T;
  }
}

function envWith(db: ExportFakeD1 | null): Env {
  return { HISTORY_DB: db as unknown as Env["HISTORY_DB"] };
}

/** Seed N global rows, one per hour ascending, plus a couple of planets. */
function seed(db: ExportFakeD1, n: number): void {
  let id = 1;
  for (let i = 0; i < n; i++) {
    const t = NOW - (n - i) * HOUR;
    db.rows.global_samples.push({
      id: id++,
      sampled_at: t,
      player_count: 1000 + i,
      impact_multiplier: 1 + i * 0.01,
      active_campaign_count: 5,
      missions_won: 100 + i,
      missions_lost: i,
      deaths: i * 10,
      terminid_kills: i * 100,
      automaton_kills: i * 50,
      illuminate_kills: null,
    });
  }
}

/* ====================================================================== *
 * Param parsing
 * ====================================================================== */

describe("parseExportParams", () => {
  const get = (m: Record<string, string>) => (k: string) => m[k] ?? null;

  it("requires a valid table", () => {
    expect(() => parseExportParams(get({}), NOW)).toThrow(/table/);
    expect(() => parseExportParams(get({ table: "bogus" }), NOW)).toThrow(/table/);
    expect(parseExportParams(get({ table: "global" }), NOW).table).toBe("global");
  });

  it("defaults bucket to raw and rejects an unknown bucket", () => {
    expect(parseExportParams(get({ table: "mo" }), NOW).bucket).toBe("raw");
    expect(() => parseExportParams(get({ table: "mo", bucket: "weekly" }), NOW)).toThrow(
      /bucket/,
    );
  });

  it("parses ISO since/until and rejects a backwards window", () => {
    const p = parseExportParams(
      get({ table: "global", since: "2026-06-18T00:00:00Z", until: "2026-06-20T00:00:00Z" }),
      NOW,
    );
    expect(p.sinceMs).toBe(Date.parse("2026-06-18T00:00:00Z"));
    expect(p.untilMs).toBe(Date.parse("2026-06-20T00:00:00Z"));
    expect(() =>
      parseExportParams(
        get({ table: "global", since: "2026-06-20T00:00:00Z", until: "2026-06-18T00:00:00Z" }),
        NOW,
      ),
    ).toThrow(/empty/);
  });

  it("parses *_hours edges relative to now", () => {
    const p = parseExportParams(get({ table: "global", since_hours: "48" }), NOW);
    expect(p.sinceMs).toBe(NOW - 48 * HOUR);
    expect(p.untilMs).toBeNull();
  });

  it("rejects supplying both ISO and *_hours for the same edge", () => {
    expect(() =>
      parseExportParams(
        get({ table: "global", since: "2026-06-18T00:00:00Z", since_hours: "48" }),
        NOW,
      ),
    ).toThrow(/Ambiguous .*since/);
    expect(() =>
      parseExportParams(
        get({ table: "global", until: "2026-06-18T00:00:00Z", until_hours: "1" }),
        NOW,
      ),
    ).toThrow(/Ambiguous .*until/);
  });

  it("rejects planet_index on a non-planet table, accepts it on planet", () => {
    expect(() =>
      parseExportParams(get({ table: "global", planet_index: "185" }), NOW),
    ).toThrow(/planet_index/);
    expect(
      parseExportParams(get({ table: "planet", planet_index: "185" }), NOW).planetIndex,
    ).toBe(185);
  });
});

/* ====================================================================== *
 * Column shape + URL building
 * ====================================================================== */

describe("exportColumns / buildExportUrl", () => {
  it("leads with sampled_at (raw) or bucket_start (bucketed); matches schema", () => {
    expect(exportColumns("global", "raw")[0]).toBe("sampled_at");
    expect(exportColumns("global", "daily")[0]).toBe("bucket_start");
    expect(exportColumns("planet", "raw")).toEqual([
      "sampled_at",
      "planet_index",
      "health",
      "max_health",
      "hp_per_hour",
      "campaign_id",
      "campaign_kind",
      "faction",
    ]);
  });

  it("builds a canonical absolute URL with ISO window edges", () => {
    const params: ExportParams = {
      table: "planet",
      planetIndex: 185,
      sinceMs: Date.parse("2026-06-18T00:00:00Z"),
      untilMs: null,
      bucket: "daily",
    };
    const url = buildExportUrl("https://w.example", params);
    expect(url).toContain("https://w.example/export/archive?");
    expect(url).toContain("table=planet");
    expect(url).toContain("planet_index=185");
    expect(url).toContain("since=2026-06-18T00%3A00%3A00.000Z");
    expect(url).toContain("bucket=daily");
  });
});

/* ====================================================================== *
 * Streaming CSV route — acceptance tests
 * ====================================================================== */

async function csvText(
  env: Env,
  params: ExportParams,
  pageSize?: number,
): Promise<string> {
  const res =
    pageSize == null
      ? streamArchiveCsv(env, params)
      : streamArchiveCsv(env, params, pageSize);
  return await res.text();
}

describe("streamArchiveCsv", () => {
  it("dumps the WHOLE table (not capped at 1000), header first, ascending", async () => {
    const db = new ExportFakeD1();
    seed(db, 1500); // > the 1000-row JSON cap
    const text = await csvText(envWith(db), {
      table: "global",
      planetIndex: null,
      sinceMs: null,
      untilMs: null,
      bucket: "raw",
    });
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe(exportColumns("global", "raw").join(","));
    expect(lines.length - 1).toBe(1500); // matches COUNT(*), no 1000 cap
    // observed_at ascending + ISO-8601 UTC
    const firstTs = lines[1]!.split(",")[0]!;
    const lastTs = lines[lines.length - 1]!.split(",")[0]!;
    expect(firstTs).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(Date.parse(firstTs)).toBeLessThan(Date.parse(lastTs));
  });

  it("paginates a multi-page table to completion (no cap error)", async () => {
    const db = new ExportFakeD1();
    seed(db, 12_345);
    // Small page size so the keyset loop spans many pages (13) in the test.
    const text = await csvText(
      envWith(db),
      { table: "global", planetIndex: null, sinceMs: null, untilMs: null, bucket: "raw" },
      1000,
    );
    expect(text.trimEnd().split("\n").length - 1).toBe(12_345);
  });

  it("does not waste an empty-probe query when the row count is an exact page multiple", async () => {
    const db = new ExportFakeD1();
    seed(db, 20); // exactly 4 pages of 5
    await csvText(
      envWith(db),
      { table: "global", planetIndex: null, sinceMs: null, untilMs: null, bucket: "raw" },
      5,
    );
    // 20 rows / page 5 = 4 pages. The PAGE_SIZE+1 look-ahead means the 4th page
    // reveals there is no more, so there are exactly 4 page queries — never a
    // 5th empty-probe query (which a plain LIMIT loop would issue).
    expect(db.selectSqls.length).toBe(4);
  });

  it("honors backpressure — does not eagerly fetch every page up front", async () => {
    const db = new ExportFakeD1();
    seed(db, 50); // 10 pages of 5
    const res = streamArchiveCsv(
      envWith(db),
      { table: "global", planetIndex: null, sinceMs: null, untilMs: null, bucket: "raw" },
      5,
    );
    const reader = res.body!.getReader();
    await reader.read(); // header chunk (no query)
    await reader.read(); // first data page (one query)
    // A backpressure-aware (pull-driven) producer must NOT have run all ten page
    // queries just because we read the first chunks. The old eager start()-based
    // producer would have issued every page before returning.
    expect(db.selectSqls.length).toBeLessThan(10);
    await reader.cancel();
  });

  it("bounds both window edges (June 18–20)", async () => {
    const db = new ExportFakeD1();
    // one row per hour over a wide span
    let id = 1;
    for (let d = 15; d <= 25; d++) {
      db.rows.global_samples.push({
        id: id++,
        sampled_at: Date.parse(`2026-06-${String(d).padStart(2, "0")}T12:00:00Z`),
        player_count: d,
        impact_multiplier: 1,
        active_campaign_count: 1,
        missions_won: 0,
        missions_lost: 0,
        deaths: 0,
        terminid_kills: 0,
        automaton_kills: 0,
        illuminate_kills: 0,
      });
    }
    const text = await csvText(envWith(db), {
      table: "global",
      planetIndex: null,
      sinceMs: Date.parse("2026-06-18T00:00:00Z"),
      untilMs: Date.parse("2026-06-20T23:59:59Z"),
      bucket: "raw",
    });
    const tss = text.trimEnd().split("\n").slice(1).map((l) => l.split(",")[0]!);
    expect(tss.length).toBe(3); // 18, 19, 20
    for (const t of tss) {
      expect(Date.parse(t)).toBeGreaterThanOrEqual(Date.parse("2026-06-18T00:00:00Z"));
      expect(Date.parse(t)).toBeLessThanOrEqual(Date.parse("2026-06-20T23:59:59Z"));
    }
  });

  it("filters the planet table to one planet_index", async () => {
    const db = new ExportFakeD1();
    let id = 1;
    for (const idx of [185, 185, 64, 185, 64]) {
      db.rows.planet_samples.push({
        id: id++,
        sampled_at: NOW - id * HOUR,
        planet_index: idx,
        health: 1000,
        max_health: 1_000_000,
        hp_per_hour: 5,
        campaign_id: 1,
        campaign_kind: "liberation",
        faction: "Terminids",
      });
    }
    const text = await csvText(envWith(db), {
      table: "planet",
      planetIndex: 185,
      sinceMs: null,
      untilMs: null,
      bucket: "raw",
    });
    const dataLines = text.trimEnd().split("\n").slice(1);
    expect(dataLines.length).toBe(3);
    for (const l of dataLines) {
      expect(l.split(",")[1]).toBe("185"); // planet_index column
    }
  });

  it("renders null as an empty cell", async () => {
    const db = new ExportFakeD1();
    seed(db, 1); // illuminate_kills is null
    const text = await csvText(envWith(db), {
      table: "global",
      planetIndex: null,
      sinceMs: null,
      untilMs: null,
      bucket: "raw",
    });
    const cols = exportColumns("global", "raw");
    const idx = cols.indexOf("illuminate_kills");
    const cells = text.trimEnd().split("\n")[1]!.split(",");
    expect(cells[idx]).toBe(""); // null → empty
  });

  it("daily bucket → one row per day with mean rates and last counts", async () => {
    const db = new ExportFakeD1();
    let id = 1;
    // two days, 24 hourly rows each
    for (let day = 0; day < 2; day++) {
      for (let h = 0; h < 24; h++) {
        db.rows.global_samples.push({
          id: id++,
          sampled_at: Date.parse(`2026-06-${18 + day}T${String(h).padStart(2, "0")}:00:00Z`),
          player_count: 100, // mean stays 100
          impact_multiplier: h, // mean over 0..23 = 11.5
          active_campaign_count: h, // last = 23
          missions_won: day * 1000 + h, // last = day*1000+23
          missions_lost: 0,
          deaths: 0,
          terminid_kills: 0,
          automaton_kills: 0,
          illuminate_kills: 0,
        });
      }
    }
    const text = await csvText(envWith(db), {
      table: "global",
      planetIndex: null,
      sinceMs: null,
      untilMs: null,
      bucket: "daily",
    });
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe(exportColumns("global", "daily").join(","));
    expect(lines.length - 1).toBe(2); // far fewer than 48 raw rows
    const cols = exportColumns("global", "daily");
    const row0 = lines[1]!.split(",");
    expect(row0[0]).toBe("2026-06-18T00:00:00.000Z"); // bucket_start
    expect(row0[cols.indexOf("player_count")]).toBe("100"); // mean
    expect(Number(row0[cols.indexOf("impact_multiplier")])).toBeCloseTo(11.5); // mean
    expect(row0[cols.indexOf("active_campaign_count")]).toBe("23"); // last
    expect(row0[cols.indexOf("missions_won")]).toBe("23"); // last of day 0
    const row1 = lines[2]!.split(",");
    expect(row1[cols.indexOf("missions_won")]).toBe("1023"); // last of day 1
  });

  it("daily bucket over multiple keys streams bucket-ascending then key (incremental flush)", async () => {
    const db = new ExportFakeD1();
    let id = 1;
    // Two planets, two days, interleaved within each day's sample ticks — the
    // shape that would force a non-streaming aggregator to hold every group.
    for (let day = 0; day < 2; day++) {
      for (let h = 0; h < 4; h++) {
        for (const idx of [64, 185]) {
          db.rows.planet_samples.push({
            id: id++,
            sampled_at: Date.parse(`2026-06-${18 + day}T0${h}:00:00Z`),
            planet_index: idx,
            health: idx * 100 + day, // last per (planet, day)
            max_health: 1_000_000,
            hp_per_hour: h, // mean over 0..3 = 1.5
            campaign_id: 1,
            campaign_kind: "liberation",
            faction: "Terminids",
          });
        }
      }
    }
    const text = await csvText(envWith(db), {
      table: "planet",
      planetIndex: null,
      sinceMs: null,
      untilMs: null,
      bucket: "daily",
    });
    const cols = exportColumns("planet", "daily");
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe(cols.join(","));
    const dataRows = lines.slice(1).map((l) => l.split(","));
    expect(dataRows.length).toBe(4); // 2 planets × 2 days
    // Ordering: bucket-ascending, then key — [day0/64, day0/185, day1/64, day1/185]
    const bs = (r: string[]) => r[cols.indexOf("bucket_start")]!;
    const pidx = (r: string[]) => r[cols.indexOf("planet_index")]!;
    expect(dataRows.map((r) => `${bs(r)}|${pidx(r)}`)).toEqual([
      "2026-06-18T00:00:00.000Z|64",
      "2026-06-18T00:00:00.000Z|185",
      "2026-06-19T00:00:00.000Z|64",
      "2026-06-19T00:00:00.000Z|185",
    ]);
    // Aggregations per group: hp_per_hour mean = 1.5, health = last value.
    expect(Number(dataRows[0]![cols.indexOf("hp_per_hour")])).toBeCloseTo(1.5);
    expect(dataRows[0]![cols.indexOf("health")]).toBe("6400"); // planet 64, day 0
    expect(dataRows[3]![cols.indexOf("health")]).toBe("18501"); // planet 185, day 1
  });
});

/* ====================================================================== *
 * HTTP handler (status codes) + the MCP metadata tool
 * ====================================================================== */

describe("handleExportArchive", () => {
  it("400s on a bad table without streaming bytes", async () => {
    const res = handleExportArchive(
      new Request("https://w.example/export/archive?table=nope"),
      envWith(new ExportFakeD1()),
    );
    expect(res.status).toBe(400);
  });

  it("503s when no D1 archive is configured", async () => {
    const res = handleExportArchive(
      new Request("https://w.example/export/archive?table=global"),
      envWith(null),
    );
    expect(res.status).toBe(503);
  });

  it("streams CSV with the right content-type on success", async () => {
    const db = new ExportFakeD1();
    seed(db, 3);
    const res = handleExportArchive(
      new Request("https://w.example/export/archive?table=global"),
      envWith(db),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect((await res.text()).trimEnd().split("\n").length - 1).toBe(3);
  });
});

describe("exportArchive (MCP metadata tool)", () => {
  it("returns a pointer + shape only, with row_count matching COUNT(*)", async () => {
    const db = new ExportFakeD1();
    seed(db, 1500);
    const meta = (await exportArchive(envWith(db), "https://w.example", {
      table: "global",
    })) as Record<string, unknown>;
    expect(meta.url).toContain("https://w.example/export/archive?table=global");
    expect(meta.row_count).toBe(1500); // whole table, not capped
    expect(meta.format).toBe("csv");
    expect(meta.table).toBe("global");
    expect(meta.bucket).toBe("raw");
    expect(meta.columns).toEqual(exportColumns("global", "raw"));
    expect(typeof meta.byte_size_estimate).toBe("number");
    // NO rows inlined
    expect(meta).not.toHaveProperty("samples");
    expect(meta).not.toHaveProperty("rows");
  });

  it("row_count honors the window predicate", async () => {
    const db = new ExportFakeD1();
    seed(db, 100); // hourly rows, newest at NOW-1h
    // Anchor the window to the seeded (fixed-epoch) rows via an ISO `since`,
    // since `since_hours` would resolve against the real wall clock.
    const sinceIso = new Date(NOW - 10 * HOUR).toISOString();
    const meta = (await exportArchive(envWith(db), "https://w.example", {
      table: "global",
      since: sinceIso,
    })) as Record<string, unknown>;
    expect(meta.row_count).toBe(10);
    expect((meta.range as Record<string, unknown>).from).toBe(sinceIso);
  });

  it("freezes an omitted `until` to the call instant for a consistent snapshot", async () => {
    const db = new ExportFakeD1();
    seed(db, 5);
    const before = Date.now();
    const meta = (await exportArchive(envWith(db), "https://w.example", {
      table: "global",
    })) as Record<string, unknown>;
    const after = Date.now();
    // range.to is no longer null — it pins the upper bound at call time …
    const to = (meta.range as Record<string, unknown>).to as string;
    expect(to).not.toBeNull();
    const toMs = Date.parse(to);
    expect(toMs).toBeGreaterThanOrEqual(before);
    expect(toMs).toBeLessThanOrEqual(after);
    // … and that bound is baked into the URL, so the streamed CSV matches the
    // counted snapshot even if rows are appended afterward.
    expect(meta.url).toContain("until=");
    expect(decodeURIComponent(meta.url as string)).toContain(`until=${to}`);
  });

  it("wraps a D1 read failure as an actionable archive error (not a generic one)", async () => {
    const db = new ExportFakeD1();
    db.failQueries = true; // bound HISTORY_DB, migrations not applied
    await expect(
      exportArchive(envWith(db), "https://w.example", { table: "global" }),
    ).rejects.toThrow(/migration/i);
  });

  it("honors a string-encoded planet_index (model serialization) and errors on a bad one", async () => {
    const db = new ExportFakeD1();
    let id = 1;
    for (const idx of [185, 64, 185]) {
      db.rows.planet_samples.push({
        id: id++,
        sampled_at: NOW - id * HOUR,
        planet_index: idx,
        health: 1000,
        max_health: 1_000_000,
        hp_per_hour: 5,
        campaign_id: 1,
        campaign_kind: "liberation",
        faction: "Terminids",
      });
    }
    // planet_index arrives as the string "185" (as a model may serialize it).
    const meta = (await exportArchive(envWith(db), "https://w.example", {
      table: "planet",
      planet_index: "185",
    })) as Record<string, unknown>;
    expect(meta.planet_index).toBe(185); // honored, not silently dropped
    expect(meta.row_count).toBe(2); // only the two Karlia rows, not all 3
    expect(meta.url).toContain("planet_index=185");
    // A non-numeric string is a parameter error, never a silent all-planets export.
    await expect(
      exportArchive(envWith(db), "https://w.example", {
        table: "planet",
        planet_index: "not-a-number",
      }),
    ).rejects.toThrow(/planet_index/);
  });

  it("surfaces planet_index and bucket in the metadata + url", async () => {
    const db = new ExportFakeD1();
    const meta = (await exportArchive(envWith(db), "https://w.example", {
      table: "planet",
      planet_index: 185,
      bucket: "hourly",
    })) as Record<string, unknown>;
    expect(meta.planet_index).toBe(185);
    expect(meta.bucket).toBe("hourly");
    expect(meta.url).toContain("planet_index=185");
    expect(meta.url).toContain("bucket=hourly");
  });

  it("pins a watermark even for an empty snapshot (row_count 0 stays 0 on fetch)", async () => {
    const db = new ExportFakeD1(); // no rows
    const meta = (await exportArchive(envWith(db), "https://w.example", {
      table: "global",
    })) as Record<string, unknown>;
    expect(meta.row_count).toBe(0);
    expect(meta.url).toContain("max_id=0"); // pinned even though MAX(id) was null

    // A tick commits into the frozen window after the (zero) count.
    db.rows.global_samples.push({
      id: 1,
      sampled_at: NOW - HOUR / 2,
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
    // Fetching the URL must still yield zero data rows (id <= 0 excludes it).
    const res = handleExportArchive(new Request(meta.url as string), envWith(db));
    expect((await res.text()).trimEnd().split("\n").length - 1).toBe(0);
  });

  it("rejects a future `since` once `until` is frozen (no 400-on-fetch pointer)", async () => {
    const db = new ExportFakeD1();
    await expect(
      exportArchive(envWith(db), "https://w.example", {
        table: "global",
        since: "2099-01-01T00:00:00Z", // after the snapshot instant
      }),
    ).rejects.toThrow(/future|window is empty/i);
  });

  it("pins a committed-row watermark so a late-committing tick can't desync the file", async () => {
    const db = new ExportFakeD1();
    seed(db, 5); // ids 1..5
    const meta = (await exportArchive(envWith(db), "https://w.example", {
      table: "global",
    })) as Record<string, unknown>;
    expect(meta.row_count).toBe(5);
    expect(meta.url).toContain("max_id=5");

    // A new tick commits AFTER the count, with a sampled_at inside the frozen
    // window (so `until` alone would include it) but a higher id.
    db.rows.global_samples.push({
      id: 6,
      sampled_at: NOW - HOUR / 2,
      player_count: 9999,
      impact_multiplier: 2,
      active_campaign_count: 9,
      missions_won: 999,
      missions_lost: 9,
      deaths: 9,
      terminid_kills: 9,
      automaton_kills: 9,
      illuminate_kills: 9,
    });

    // Fetching the metadata URL must still yield exactly the 5 counted rows —
    // the id watermark excludes the row that arrived after the snapshot.
    const res = handleExportArchive(
      new Request(meta.url as string),
      envWith(db),
    );
    expect((await res.text()).trimEnd().split("\n").length - 1).toBe(5);
  });
});

/* ====================================================================== *
 * Parameterized-SQL pin (no interpolated values)
 * ====================================================================== */

describe("parameterized SQL", () => {
  it("binds every value — no literals interpolated into the SELECT", async () => {
    const db = new ExportFakeD1();
    seed(db, 5);
    await csvText(envWith(db), {
      table: "global",
      planetIndex: null,
      sinceMs: NOW - 3 * HOUR,
      untilMs: NOW,
      bucket: "raw",
    });
    expect(db.selectSqls.length).toBeGreaterThan(0);
    for (const sql of db.selectSqls) {
      expect(sql).toContain("?");
      // the window values never appear as literals
      expect(sql).not.toContain(String(NOW));
    }
  });
});
