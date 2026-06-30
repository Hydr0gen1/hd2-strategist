/**
 * Bulk archive CSV export — the `export_archive` MCP tool's transport half plus
 * the `GET /export/archive` streaming route.
 *
 * WHY THIS EXISTS: the three `*_archive` tools cap at 1000 rows and inline the
 * result as a JSON tool return, so a multi-week archive never fits in an agent's
 * context. This layer DECOUPLES transport from context: the MCP tool returns a
 * small pointer (URL + shape + row_count), and the bytes come over a streamed
 * HTTP response the agent fetches straight to disk. The full table is never
 * inlined.
 *
 * PRIME DIRECTIVE (unchanged from the rest of the server): a FAITHFUL DUMP, no
 * conclusions. The CSV is a verbatim serialization of stored archive rows — no
 * derived/trend columns, no re-normalization, no filtering on read beyond the
 * caller's window. The archive already holds only rows written under the
 * `allFresh` gate, so the export inherits clean, provenance-checked data. The
 * `hourly`/`daily` bucket rollups are deterministic arithmetic (mean of
 * rates/multiplier, last value of counts), NOT a forecast or trend verdict.
 *
 * SCALING: the route NEVER loads the whole table into memory. It keyset-
 * paginates on (sampled_at, id) and writes CSV chunks to a streamed Response as
 * each page returns, so it scales past any single-query D1 row/memory ceiling.
 * Bucket mode also streams: rows arrive sampled_at-ascending, so a time bucket
 * is complete once the cursor passes it and is flushed+evicted then — memory is
 * bounded by the keys within ONE time bucket, never the whole archive.
 *
 * READ-ONLY: this module only ever SELECTs the existing archive (`archive.ts`'s
 * D1 store). It adds no binding, no write path, and never touches the KV ring
 * buffer or the live rate logic. Parameterized SQL ONLY — every value via
 * `.bind()`.
 */
import { ArchiveError } from "./archive";
import type { Env } from "./types";

export type ExportTable = "global" | "planet" | "mo";
export type Bucket = "raw" | "hourly" | "daily";

/** Thrown for a malformed request (bad table, bad bucket, unparseable
 * timestamp). The HTTP route turns it into a 400; the MCP tool surfaces the
 * message. Distinct from archive.ts's ArchiveError (a D1 read failure → 5xx). */
export class ExportParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportParamError";
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Keyset page size — large enough to amortize round-trips, small enough to
 * stay well under any single-query D1 ceiling. */
const PAGE_SIZE = 5000;

type Agg = "mean" | "last" | "sum";

interface ColSpec {
  name: string;
  /** `num` columns render verbatim and participate in mean/sum; `str` columns
   * only ever carry the `last` aggregation. */
  type: "num" | "str";
  /** How this column collapses under hourly/daily bucketing. */
  agg: Agg;
}

interface TableConfig {
  /** The D1 table the rows live in. */
  sqlTable: string;
  /** Numeric grouping keys (a planet index, an MO id+objective). Always
   * carried through verbatim; in bucket mode they join the time bucket as the
   * group identity. */
  keyCols: ColSpec[];
  /** The measured columns. */
  valueCols: ColSpec[];
}

/** The timestamp column is `sampled_at` in every archive table (the Worker
 * sample time, epoch ms). It is rendered ISO-8601 UTC and always leads the CSV
 * (replaced by `bucket_start` under a non-raw bucket). */
const TS_COL = "sampled_at";

/**
 * Per-table column contracts. Names + order mirror the actual D1 schema
 * (migrations/0001_init.sql) EXACTLY — no invented columns. Aggregation rules:
 * gauges/rates (player_count, impact_multiplier, hp_per_hour) take the MEAN of
 * a bucket; everything else (cumulative counters, ids, kinds, factions, the
 * health snapshot) takes the LAST value in the bucket.
 */
const TABLE_CONFIG: Record<ExportTable, TableConfig> = {
  global: {
    sqlTable: "global_samples",
    keyCols: [],
    valueCols: [
      { name: "player_count", type: "num", agg: "mean" },
      { name: "impact_multiplier", type: "num", agg: "mean" },
      { name: "active_campaign_count", type: "num", agg: "last" },
      { name: "missions_won", type: "num", agg: "last" },
      { name: "missions_lost", type: "num", agg: "last" },
      { name: "deaths", type: "num", agg: "last" },
      { name: "terminid_kills", type: "num", agg: "last" },
      { name: "automaton_kills", type: "num", agg: "last" },
      { name: "illuminate_kills", type: "num", agg: "last" },
    ],
  },
  planet: {
    sqlTable: "planet_samples",
    keyCols: [{ name: "planet_index", type: "num", agg: "last" }],
    valueCols: [
      { name: "health", type: "num", agg: "last" },
      { name: "max_health", type: "num", agg: "last" },
      { name: "hp_per_hour", type: "num", agg: "mean" },
      { name: "campaign_id", type: "num", agg: "last" },
      { name: "campaign_kind", type: "str", agg: "last" },
      { name: "faction", type: "str", agg: "last" },
    ],
  },
  mo: {
    sqlTable: "mo_progress_samples",
    keyCols: [
      { name: "major_order_id", type: "num", agg: "last" },
      { name: "objective_index", type: "num", agg: "last" },
    ],
    valueCols: [
      { name: "progress", type: "num", agg: "last" },
      { name: "target", type: "num", agg: "last" },
    ],
  },
};

export interface ExportParams {
  table: ExportTable;
  /** Planet-table-only filter; ignored for the other tables. */
  planetIndex: number | null;
  /** Inclusive window bounds in epoch ms; null = open-ended on that edge. */
  sinceMs: number | null;
  untilMs: number | null;
  bucket: Bucket;
  /** Committed-row watermark: an upper bound on the AUTOINCREMENT `id`, set by
   * the metadata tool so the streamed CSV matches the counted snapshot exactly.
   * A row that commits AFTER the count (e.g. an in-flight sampling tick whose
   * sampled_at falls within the window but whose D1 write lands late) gets a
   * higher id and is excluded from BOTH the count and the stream. Absent on a
   * direct route hit. */
  maxId?: number | null;
}

/* ------------------------------------------------------------------------
 * Parameter parsing — ISO-8601 OR `*_hours` (hours-back-from-now) windows.
 * ---------------------------------------------------------------------- */

function parseTable(raw: string | null): ExportTable {
  if (raw === "global" || raw === "planet" || raw === "mo") return raw;
  throw new ExportParamError(
    `Missing or invalid \`table\`: expected one of global | planet | mo, got ${
      raw === null ? "(none)" : `"${raw}"`
    }.`,
  );
}

function parseBucket(raw: string | null): Bucket {
  if (raw === null || raw === "raw") return "raw";
  if (raw === "hourly" || raw === "daily") return raw;
  throw new ExportParamError(
    `Invalid \`bucket\`: expected one of raw | hourly | daily, got "${raw}".`,
  );
}

/** Resolve one window edge: an ISO-8601 string OR an `*_hours` integer
 * (hours-back-from-now). Returns null when neither is present (open edge). */
function parseEdge(
  iso: string | null,
  hours: string | null,
  edge: string,
  nowMs: number,
): number | null {
  if (iso != null && iso !== "") {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) {
      throw new ExportParamError(
        `Invalid \`${edge}\` timestamp "${iso}": expected an ISO-8601 datetime.`,
      );
    }
    return ms;
  }
  if (hours != null && hours !== "") {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 0) {
      throw new ExportParamError(
        `Invalid \`${edge}_hours\` "${hours}": expected a non-negative number of hours.`,
      );
    }
    return nowMs - h * HOUR_MS;
  }
  return null;
}

/** Parse from raw query inputs. Shared by the HTTP route (URLSearchParams) and
 * the MCP tool (its args object), so both honour identical semantics. */
export function parseExportParams(
  get: (key: string) => string | null,
  nowMs: number,
): ExportParams {
  const table = parseTable(get("table"));
  const bucket = parseBucket(get("bucket"));

  let planetIndex: number | null = null;
  const rawPlanet = get("planet_index");
  if (rawPlanet != null && rawPlanet !== "") {
    const n = Number(rawPlanet);
    if (!Number.isInteger(n)) {
      throw new ExportParamError(
        `Invalid \`planet_index\` "${rawPlanet}": expected an integer.`,
      );
    }
    if (table !== "planet") {
      throw new ExportParamError(
        "`planet_index` is only valid with `table=planet`.",
      );
    }
    planetIndex = n;
  }

  const sinceMs = parseEdge(get("since"), get("since_hours"), "since", nowMs);
  const untilMs = parseEdge(get("until"), get("until_hours"), "until", nowMs);
  if (sinceMs != null && untilMs != null && sinceMs > untilMs) {
    throw new ExportParamError(
      "`since` is after `until`: the window is empty.",
    );
  }

  let maxId: number | null = null;
  const rawMaxId = get("max_id");
  if (rawMaxId != null && rawMaxId !== "") {
    const n = Number(rawMaxId);
    if (!Number.isInteger(n) || n < 0) {
      throw new ExportParamError(
        `Invalid \`max_id\` "${rawMaxId}": expected a non-negative integer.`,
      );
    }
    maxId = n;
  }

  return { table, planetIndex, sinceMs, untilMs, bucket, maxId };
}

/* ------------------------------------------------------------------------
 * Output column shape.
 * ---------------------------------------------------------------------- */

/** The ordered CSV header for a (table, bucket) pair: the timestamp column
 * first (`bucket_start` when bucketed, else `sampled_at`), then the key
 * columns, then the value columns. */
export function exportColumns(table: ExportTable, bucket: Bucket): string[] {
  const cfg = TABLE_CONFIG[table];
  const lead = bucket === "raw" ? TS_COL : "bucket_start";
  return [
    lead,
    ...cfg.keyCols.map((c) => c.name),
    ...cfg.valueCols.map((c) => c.name),
  ];
}

/* ------------------------------------------------------------------------
 * CSV rendering.
 * ---------------------------------------------------------------------- */

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** RFC-4180-ish cell escaping: null/undefined → empty cell; numbers verbatim;
 * strings quoted only when they contain a comma, quote, or newline. */
function csvCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\n";
}

/* ------------------------------------------------------------------------
 * D1 access — keyset pagination + COUNT, both parameterized.
 * ---------------------------------------------------------------------- */

function requireDb(env: Env): D1Database {
  if (!env.HISTORY_DB) {
    throw new ExportParamError(
      "The history archive (D1 binding HISTORY_DB) is not configured, so there " +
        "is nothing to export. Configure it and apply migrations/0001_init.sql " +
        "(see README), then redeploy.",
    );
  }
  return env.HISTORY_DB;
}

/** Build the shared `WHERE` predicate (window bounds + optional planet filter)
 * and its bound values. Used identically by the COUNT and the page queries so
 * the count always matches the streamed rows. */
function windowPredicate(params: ExportParams): {
  clause: string;
  binds: unknown[];
} {
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (params.sinceMs != null) {
    parts.push(`${TS_COL} >= ?`);
    binds.push(params.sinceMs);
  }
  if (params.untilMs != null) {
    parts.push(`${TS_COL} <= ?`);
    binds.push(params.untilMs);
  }
  if (params.table === "planet" && params.planetIndex != null) {
    parts.push("planet_index = ?");
    binds.push(params.planetIndex);
  }
  if (params.maxId != null) {
    // Committed-row watermark: pin the snapshot to rows that existed when the
    // count was taken, so a later-committing tick can't appear in the stream
    // but not the count.
    parts.push("id <= ?");
    binds.push(params.maxId);
  }
  return { clause: parts.length ? parts.join(" AND ") : "", binds };
}

interface RawRow {
  id: number;
  sampled_at: number;
  [col: string]: number | string | null;
}

/** Stream every matching row in ascending (sampled_at, id) order, one page at a
 * time, invoking `onPage` per page. Keyset cursor on (sampled_at, id) — `id` is
 * the tiebreaker so rows sharing a sample tick (many planets per tick) are never
 * skipped at a page boundary. */
async function paginate(
  env: Env,
  params: ExportParams,
  onPage: (rows: RawRow[]) => void,
): Promise<void> {
  const db = requireDb(env);
  const cfg = TABLE_CONFIG[params.table];
  const selectCols = [
    "id",
    TS_COL,
    ...cfg.keyCols.map((c) => c.name),
    ...cfg.valueCols.map((c) => c.name),
  ].join(", ");
  const { clause, binds: windowBinds } = windowPredicate(params);

  let curTs = -1;
  let curId = -1;
  for (;;) {
    const where = [
      `(${TS_COL} > ? OR (${TS_COL} = ? AND id > ?))`,
      ...(clause ? [clause] : []),
    ].join(" AND ");
    const sql =
      `SELECT ${selectCols} FROM ${cfg.sqlTable} WHERE ${where} ` +
      `ORDER BY ${TS_COL} ASC, id ASC LIMIT ?`;
    const res = await db
      .prepare(sql)
      .bind(curTs, curTs, curId, ...windowBinds, PAGE_SIZE)
      .all<RawRow>();
    const rows = res.results ?? [];
    if (rows.length === 0) break;
    onPage(rows);
    const last = rows[rows.length - 1]!;
    curTs = last.sampled_at;
    curId = last.id;
    if (rows.length < PAGE_SIZE) break;
  }
}

/**
 * Snapshot the window in ONE query: the raw row count (before any bucketing, so
 * the agent knows the size before fetching) AND the committed-row watermark
 * `MAX(id)` over the same predicate. Counting and the later stream both bound on
 * `id <= maxId`, so rows that commit after this call (a late sampling tick) get
 * a higher id and appear in neither — the metadata and the CSV describe exactly
 * the same set. `maxId` is null only when the window is empty (count 0). */
export async function countArchiveSnapshot(
  env: Env,
  params: ExportParams,
): Promise<{ rowCount: number; maxId: number | null }> {
  const db = requireDb(env);
  const cfg = TABLE_CONFIG[params.table];
  const { clause, binds } = windowPredicate(params);
  const sql =
    `SELECT COUNT(*) AS n, MAX(id) AS max_id FROM ${cfg.sqlTable}` +
    (clause ? ` WHERE ${clause}` : "");
  try {
    const res = await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number; max_id: number | null }>();
    return { rowCount: res?.n ?? 0, maxId: res?.max_id ?? null };
  } catch (err) {
    // Mirror archive.ts's read-failure wrapping: a bound-but-unmigrated
    // HISTORY_DB throws a raw "no such table" here. Surface it as an
    // ArchiveError (which mcp.ts renders as an actionable tool error) instead
    // of letting it fall through to the generic "Internal error" message.
    throw new ArchiveError(
      `Failed to count rows in the history archive (${
        err instanceof Error ? err.message : String(err)
      }). If the KV-backed tools still work, the D1 migration was likely not applied to production — run \`wrangler d1 migrations apply hd2-strategist-history --remote\`.`,
    );
  }
}

/* ------------------------------------------------------------------------
 * Bucket aggregation (hourly / daily).
 * ---------------------------------------------------------------------- */

function bucketStartMs(ms: number, bucket: Bucket): number {
  const size = bucket === "daily" ? DAY_MS : HOUR_MS;
  return Math.floor(ms / size) * size;
}

interface BucketGroup {
  bucketStart: number;
  keyVals: (number | string | null)[];
  /** Per value column: running sum + count (for mean/sum) and the chronological
   * last value (rows fold in ascending order, so overwrite = last). */
  acc: Record<string, { sum: number; count: number; last: number | string | null }>;
}

/** Fold one row into its `(key, bucket)` group within `groups`, creating the
 * group on first sight. Rows arrive ascending, so `last` is overwrite-each-time. */
function foldRow(
  cfg: TableConfig,
  bucket: Bucket,
  groups: Map<string, BucketGroup>,
  row: RawRow,
): void {
  {
    const bs = bucketStartMs(row.sampled_at, bucket);
    const keyVals = cfg.keyCols.map((c) => row[c.name] ?? null);
    const gkey = keyVals.join(" ") + " " + bs;
    let g = groups.get(gkey);
    if (!g) {
      g = { bucketStart: bs, keyVals, acc: {} };
      for (const vc of cfg.valueCols) g.acc[vc.name] = { sum: 0, count: 0, last: null };
      groups.set(gkey, g);
    }
    for (const vc of cfg.valueCols) {
      const v = row[vc.name] ?? null;
      const a = g.acc[vc.name]!;
      a.last = v; // ascending order ⇒ overwrite yields the bucket's last value
      if (v != null && typeof v === "number") {
        a.sum += v;
        a.count += 1;
      }
    }
  }
}

function aggValue(spec: ColSpec, a: { sum: number; count: number; last: number | string | null }): number | string | null {
  switch (spec.agg) {
    case "mean":
      return a.count > 0 ? a.sum / a.count : null;
    case "sum":
      return a.count > 0 ? a.sum : null;
    case "last":
    default:
      return a.last;
  }
}

/** Render a set of bucket groups as CSV lines, ordered by (keys…, bucket_start)
 * ascending for a deterministic file. Operates on whatever groups are handed in
 * — the streamer flushes one completed time bucket at a time, so this never sees
 * the whole archive at once. */
function renderBucketGroups(cfg: TableConfig, groups: BucketGroup[]): string[] {
  const sorted = [...groups].sort((x, y) => {
    for (let i = 0; i < cfg.keyCols.length; i++) {
      const a = x.keyVals[i];
      const b = y.keyVals[i];
      if (a == null && b == null) continue;
      if (a == null) return -1;
      if (b == null) return 1;
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return x.bucketStart - y.bucketStart;
  });
  return sorted.map((g) =>
    csvLine([
      isoFromMs(g.bucketStart),
      ...g.keyVals,
      ...cfg.valueCols.map((vc) => aggValue(vc, g.acc[vc.name]!)),
    ]),
  );
}

/* ------------------------------------------------------------------------
 * The streamed CSV Response.
 * ---------------------------------------------------------------------- */

const CSV_HEADERS = {
  "content-type": "text/csv; charset=utf-8",
  "cache-control": "no-store",
  "content-disposition": 'attachment; filename="archive.csv"',
};

/** Build a streamed CSV Response. Raw mode writes each page straight through
 * (true streaming, O(1) memory in row count). Bucket mode also streams: because
 * rows arrive in ascending sampled_at order, a time bucket is COMPLETE once the
 * cursor advances past it, so each completed bucket is flushed and evicted as we
 * go. Memory is therefore bounded by the keys within a SINGLE time bucket (≈ the
 * planet/objective count), never by the whole archive — so a multi-week bucketed
 * planet/MO export cannot blow the Worker's memory. */
export function streamArchiveCsv(env: Env, params: ExportParams): Response {
  const cfg = TABLE_CONFIG[params.table];
  const header = exportColumns(params.table, params.bucket);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvLine(header)));
        if (params.bucket === "raw") {
          await paginate(env, params, (rows) => {
            let buf = "";
            for (const row of rows) {
              buf += csvLine([
                isoFromMs(row.sampled_at),
                ...cfg.keyCols.map((c) => row[c.name]),
                ...cfg.valueCols.map((c) => row[c.name]),
              ]);
            }
            controller.enqueue(encoder.encode(buf));
          });
        } else {
          const bucket = params.bucket;
          const groups = new Map<string, BucketGroup>();
          let currentBucket = -Infinity;
          // Flush (and evict) every group whose time bucket is fully behind the
          // cursor. Each flush emits exactly one completed bucket's groups,
          // sorted by key, keeping output ordered bucket-ascending then key.
          const flushBelow = (threshold: number) => {
            if (groups.size === 0) return;
            const ready: BucketGroup[] = [];
            for (const [k, g] of groups) {
              if (g.bucketStart < threshold) {
                ready.push(g);
                groups.delete(k);
              }
            }
            if (ready.length > 0) {
              controller.enqueue(
                encoder.encode(renderBucketGroups(cfg, ready).join("")),
              );
            }
          };
          await paginate(env, params, (rows) => {
            for (const row of rows) {
              const bs = bucketStartMs(row.sampled_at, bucket);
              if (bs > currentBucket) {
                // The cursor moved to a later bucket; every earlier bucket is
                // now complete (rows are globally sampled_at-ascending).
                flushBelow(bs);
                currentBucket = bs;
              }
              foldRow(cfg, bucket, groups, row);
            }
          });
          flushBelow(Infinity); // emit the final, still-open bucket
        }
        controller.close();
      } catch (err) {
        // The header may already be on the wire, so we can't change the status;
        // erroring the stream surfaces the failure to the fetching client.
        controller.error(err);
      }
    },
  });

  return new Response(stream, { headers: CSV_HEADERS });
}

/** Top-level handler for `GET /export/archive`. Validates params synchronously
 * (so a bad request gets a real 4xx/5xx before any bytes stream) and returns
 * the streamed CSV. */
export function handleExportArchive(request: Request, env: Env): Response {
  const url = new URL(request.url);
  let params: ExportParams;
  try {
    params = parseExportParams((k) => url.searchParams.get(k), Date.now());
  } catch (err) {
    if (err instanceof ExportParamError) {
      return new Response(err.message + "\n", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw err;
  }
  // Fail fast (before any bytes stream) when the archive isn't configured —
  // mid-stream the header is already on the wire and the status can't change.
  if (!env.HISTORY_DB) {
    return new Response(
      "The history archive (D1 binding HISTORY_DB) is not configured, so there is nothing to export.\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return streamArchiveCsv(env, params);
}

/* ------------------------------------------------------------------------
 * The MCP tool — metadata pointer only (no rows).
 * ---------------------------------------------------------------------- */

/** Canonical absolute export URL on the worker origin. Window edges are emitted
 * as resolved ISO-8601 instants so the URL is reproducible regardless of how
 * the caller expressed them (ISO or `*_hours`). */
export function buildExportUrl(origin: string, params: ExportParams): string {
  const q = new URLSearchParams();
  q.set("table", params.table);
  if (params.planetIndex != null) q.set("planet_index", String(params.planetIndex));
  if (params.sinceMs != null) q.set("since", isoFromMs(params.sinceMs));
  if (params.untilMs != null) q.set("until", isoFromMs(params.untilMs));
  if (params.bucket !== "raw") q.set("bucket", params.bucket);
  if (params.maxId != null) q.set("max_id", String(params.maxId));
  return `${origin}/export/archive?${q.toString()}`;
}

/** Rough per-row byte estimate per table for `byte_size_estimate` (an estimate,
 * documented as such — the agent uses it to gauge the fetch, not to allocate). */
const APPROX_BYTES_PER_ROW: Record<ExportTable, number> = {
  global: 110,
  planet: 70,
  mo: 45,
};

export interface ExportArchiveArgs {
  table?: string;
  planet_index?: number;
  since?: string;
  until?: string;
  since_hours?: number;
  until_hours?: number;
  bucket?: string;
}

/**
 * The `export_archive` tool body: build the URL + shape metadata. Returns NO
 * rows — just the pointer the agent fetches over HTTP. `row_count` is the raw
 * COUNT(*) over the same predicate (so the agent knows the size before
 * fetching), even under a bucket (where the file itself is smaller).
 */
export async function exportArchive(
  env: Env,
  origin: string,
  args: ExportArchiveArgs,
): Promise<unknown> {
  const nowMs = Date.now();
  // Reuse the exact same parsing as the HTTP route by adapting the args object
  // to the string-getter shape, so the tool and the route can never diverge.
  const get = (k: string): string | null => {
    const v = (args as Record<string, unknown>)[k];
    return v == null ? null : String(v);
  };
  const params = parseExportParams(get, nowMs);

  // Freeze an omitted upper bound to the tool-call instant so the returned URL,
  // row_count, and byte_size_estimate describe ONE consistent snapshot. Without
  // this the URL stays open-ended while the count was taken at nowMs, so a cron
  // or request poll appending rows before/during the client's HTTP fetch would
  // return a CSV that disagrees with the reported size. The frozen `until` is
  // baked into the URL (below), so the streamed dump matches the metadata.
  if (params.untilMs == null) params.untilMs = nowMs;

  // Count the window AND capture the committed-row watermark (MAX(id)) in one
  // query, then pin both the metadata and the streamed CSV to `id <= maxId` by
  // baking it into the URL. A sampling tick that commits after this point gets a
  // higher id and is excluded from both, so the file always matches row_count.
  const { rowCount, maxId } = await countArchiveSnapshot(env, params);
  if (maxId != null) params.maxId = maxId;
  const columns = exportColumns(params.table, params.bucket);
  const header = columns.join(",").length + 1;

  return {
    url: buildExportUrl(origin, params),
    table: params.table,
    bucket: params.bucket,
    ...(params.planetIndex != null ? { planet_index: params.planetIndex } : {}),
    row_count: rowCount,
    byte_size_estimate: header + rowCount * APPROX_BYTES_PER_ROW[params.table],
    range: {
      from: params.sinceMs != null ? isoFromMs(params.sinceMs) : null,
      to: params.untilMs != null ? isoFromMs(params.untilMs) : null,
    },
    columns,
    format: "csv",
    generated_at: new Date(nowMs).toISOString(),
    notes: {
      transport:
        "Fetch `url` over HTTP to a file — the rows are delivered as a streamed CSV, never inlined here (that would re-hit the context wall). This object is the pointer + shape only.",
      row_count:
        "Raw stored-row count over the same window predicate (before any bucket rollup). Under bucket != 'raw' the CSV has fewer rows than this — one per (key, time bucket).",
      ...(params.bucket !== "raw"
        ? {
            bucket:
              "Aggregations: gauges/rates (player_count, impact_multiplier, hp_per_hour) = mean of the bucket; counters/ids/kinds (counts, campaign_id, campaign_kind, faction, health, target, progress) = last value in the bucket. `bucket_start` is the ISO-8601 start of each hour/day.",
          }
        : {}),
      faithful_dump:
        "A verbatim serialization of stored archive rows — no derived/trend columns, no re-normalization. Trend synthesis stays in the conversation layer.",
    },
  };
}
