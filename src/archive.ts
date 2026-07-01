/**
 * Stage 12: the D1 history archive — the I/O half (the D1 analog of client.ts's
 * KV access). This is the UNBOUNDED long-term record; it lives ALONGSIDE the KV
 * ring buffer and never replaces it.
 *
 * TWO STORES, DIFFERENT JOBS:
 *   - KV ring buffer (client.ts / sampling.ts): the fast recent-window cache.
 *     Every live calculation — hp_per_hour, the dual ETAs, divergence — reads
 *     ONLY the recent samples from KV. That path is frozen; D1 never feeds it.
 *   - D1 archive (here): an append-only long-term record. On each sample, in
 *     addition to the existing KV write, the tick's observations are INSERTed
 *     here. Nothing reads D1 for live logic; it is read only by the explicit
 *     archive tools (get_planet_archive / get_global_archive /
 *     get_major_order_archive) when someone wants the long view.
 *
 * The write path is BEST-EFFORT and FAILURE-ISOLATED: archiveSampleTick wraps
 * its batch in its own try/catch and swallows on failure, so D1 being briefly
 * unavailable degrades to "we missed archiving this one tick", never "the war
 * data call errored". KV remains the source of truth for live logic.
 *
 * Parameterized SQL ONLY — every value rides `.bind()`, never string
 * interpolation. Writes go out as a SINGLE batched call per tick (never a
 * per-row await loop).
 */
import type { Env } from "./types";

/** Default look-back window for an archive query when the caller gives none. */
export const ARCHIVE_DEFAULT_SINCE_HOURS = 7 * 24; // 7 days
/** Hard cap on rows returned by an archive query, to keep payloads sane. */
export const ARCHIVE_MAX_LIMIT = 1000;
export const ARCHIVE_DEFAULT_LIMIT = ARCHIVE_MAX_LIMIT;

/** Typed error so the tool layer can surface a D1 read failure (e.g. the
 * migration was not applied to production) instead of a generic internal
 * error. The WRITE path never throws this — it swallows. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/* ------------------------------------------------------------------------
 * Row shapes — one per archive table. These mirror the SQL columns exactly.
 * ---------------------------------------------------------------------- */

export interface PlanetArchiveRow {
  planet_index: number;
  sampled_at: number;
  health: number | null;
  max_health: number | null;
  hp_per_hour: number | null;
  campaign_id: number | null;
  campaign_kind: string | null;
  faction: string | null;
}

export interface GlobalArchiveRow {
  sampled_at: number;
  player_count: number | null;
  impact_multiplier: number | null;
  active_campaign_count: number | null;
  missions_won: number | null;
  missions_lost: number | null;
  deaths: number | null;
  terminid_kills: number | null;
  automaton_kills: number | null;
  illuminate_kills: number | null;
}

export interface MoArchiveRow {
  major_order_id: number;
  objective_index: number;
  sampled_at: number;
  progress: number | null;
  target: number | null;
}

export interface SignatureArchiveRow {
  signature: string;
  campaign_type: number | null;
  event_type: number | null;
  has_event: 0 | 1;
  faction: string | null;
  /** Worker-clock ms of this observation; becomes last_seen (and first_seen on
   * the very first insert, preserved across later upserts). */
  seen_at: number;
}

/** A `tick_anchor` rides every append-only write row: the predecessor KV
 * sample's timestamp this row follows (or a negative 60s bucket of sampled_at
 * for a seed). Two overlapping polls read the SAME old KV store, so they
 * compute the SAME anchor; the UNIQUE index makes the second INSERT OR IGNORE a
 * no-op (atomic, race-proof de-duplication). The read path never selects it, so
 * the returned row shapes (PlanetArchiveRow etc.) stay clean. */
export interface PlanetArchiveWriteRow extends PlanetArchiveRow {
  tick_anchor: number;
}
export interface GlobalArchiveWriteRow extends GlobalArchiveRow {
  tick_anchor: number;
}
export interface MoArchiveWriteRow extends MoArchiveRow {
  tick_anchor: number;
}

/** Item 7: one quarantined row — a screened-out observation diverted from its
 * live archive table, with the machine-readable reason and both sides of the
 * comparison. Flag-never-correct: `row_json` holds the excluded row verbatim. */
export interface QuarantineRow {
  table_name: string;
  subject_key: string;
  sampled_at: number;
  reason: string;
  detail: string; // JSON
  row_json: string; // JSON, the excluded row verbatim
  tick_anchor: number;
}

/** One sample tick's archive payload — exactly the observations that were just
 * committed to KV as NEW this cycle. The caller (client.ts) gates each section
 * by the SAME 60s interval that governs the KV write, so a within-60s replay
 * produces an empty tick and inserts nothing; the tick_anchor unique index is
 * the second, atomic line of defense against concurrent overlapping polls.
 * `quarantined` (item 7) carries rows the plausibility screen diverted from a
 * live table — recorded to quarantined_samples in the SAME batch, never
 * silently dropped. */
export interface ArchiveTick {
  planets: PlanetArchiveWriteRow[];
  global: GlobalArchiveWriteRow | null;
  mo: MoArchiveWriteRow[];
  signatures: SignatureArchiveRow[];
  quarantined?: QuarantineRow[];
}

/** Stable signature key for the observed_signatures primary key — deterministic
 * over the tuple identity (null is a distinct value from 0 or a faction name). */
export function signatureKeyString(s: {
  campaign_type: number | null;
  event_type: number | null;
  has_event: boolean;
  faction: string | null;
}): string {
  return `type:${s.campaign_type}|event:${s.event_type}|has_event:${
    s.has_event ? 1 : 0
  }|faction:${s.faction}`;
}

/**
 * Append a sample tick to the D1 archive. BEST-EFFORT and FAILURE-ISOLATED:
 * a missing binding is a no-op, an empty tick is a no-op, and any D1 error is
 * logged and swallowed so the primary response and the KV write are never
 * affected. All rows go out in ONE batched call (never a per-row await loop).
 */
export async function archiveSampleTick(
  env: Env,
  tick: ArchiveTick,
): Promise<void> {
  const db = env.HISTORY_DB;
  if (!db) return;
  const quarantined = tick.quarantined ?? [];
  if (
    tick.planets.length === 0 &&
    tick.global == null &&
    tick.mo.length === 0 &&
    tick.signatures.length === 0 &&
    quarantined.length === 0
  ) {
    return;
  }

  try {
    const batch: D1PreparedStatement[] = [];

    if (tick.planets.length > 0) {
      // INSERT OR IGNORE + the (planet_index, tick_anchor) unique index: a
      // concurrent overlapping poll that shares the predecessor anchor no-ops.
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO planet_samples
           (planet_index, sampled_at, health, max_health, hp_per_hour, campaign_id, campaign_kind, faction, tick_anchor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of tick.planets) {
        batch.push(
          stmt.bind(
            r.planet_index,
            r.sampled_at,
            r.health,
            r.max_health,
            r.hp_per_hour,
            r.campaign_id,
            r.campaign_kind,
            r.faction,
            r.tick_anchor,
          ),
        );
      }
    }

    if (tick.global != null) {
      const g = tick.global;
      batch.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO global_samples
               (sampled_at, player_count, impact_multiplier, active_campaign_count,
                missions_won, missions_lost, deaths, terminid_kills, automaton_kills, illuminate_kills, tick_anchor)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            g.sampled_at,
            g.player_count,
            g.impact_multiplier,
            g.active_campaign_count,
            g.missions_won,
            g.missions_lost,
            g.deaths,
            g.terminid_kills,
            g.automaton_kills,
            g.illuminate_kills,
            g.tick_anchor,
          ),
      );
    }

    if (tick.mo.length > 0) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO mo_progress_samples
           (major_order_id, objective_index, sampled_at, progress, target, tick_anchor)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of tick.mo) {
        batch.push(
          stmt.bind(
            r.major_order_id,
            r.objective_index,
            r.sampled_at,
            r.progress,
            r.target,
            r.tick_anchor,
          ),
        );
      }
    }

    if (tick.signatures.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO observed_signatures
           (signature, campaign_type, event_type, has_event, faction, first_seen, last_seen, sample_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(signature) DO UPDATE SET
           last_seen = excluded.last_seen,
           sample_count = sample_count + 1`,
      );
      for (const r of tick.signatures) {
        batch.push(
          stmt.bind(
            r.signature,
            r.campaign_type,
            r.event_type,
            r.has_event,
            r.faction,
            r.seen_at, // first_seen (ignored on conflict — preserved)
            r.seen_at, // last_seen
          ),
        );
      }
    }

    if (quarantined.length > 0) {
      // Item 7: screened-out rows land in quarantined_samples in the SAME
      // batch — flagged with a reason, never silently dropped, never mixed
      // into the live tables. Same race-proof INSERT OR IGNORE discipline.
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO quarantined_samples
           (table_name, subject_key, sampled_at, reason, detail, row_json, tick_anchor)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const q of quarantined) {
        batch.push(
          stmt.bind(
            q.table_name,
            q.subject_key,
            q.sampled_at,
            q.reason,
            q.detail,
            q.row_json,
            q.tick_anchor,
          ),
        );
      }
    }

    if (batch.length > 0) await db.batch(batch);
  } catch (err) {
    console.warn(
      `D1 archive write failed (KV unaffected): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/* ------------------------------------------------------------------------
 * Read path — the long-range archive queries behind the new tools. Every
 * value is parameterized via `.bind()`; a read failure throws ArchiveError so
 * the tool can surface the cause (commonly: migration not applied to prod).
 * ---------------------------------------------------------------------- */

function requireDb(env: Env): D1Database {
  if (!env.HISTORY_DB) {
    throw new ArchiveError(
      "The history archive (D1 binding HISTORY_DB) is not configured. " +
        "Create it with `wrangler d1 create hd2-strategist-history`, paste the id into wrangler.toml, " +
        "apply migrations/0001_init.sql with `wrangler d1 migrations apply hd2-strategist-history --remote`, then redeploy.",
    );
  }
  return env.HISTORY_DB;
}

async function runArchiveQuery<T>(
  stmt: D1PreparedStatement,
  what: string,
): Promise<T[]> {
  try {
    const res = await stmt.all<T>();
    return res.results ?? [];
  } catch (err) {
    throw new ArchiveError(
      `Failed to read ${what} from the history archive (${
        err instanceof Error ? err.message : String(err)
      }). If the KV-backed tools still work, the D1 migration was likely not applied to production — run \`wrangler d1 migrations apply hd2-strategist-history --remote\`.`,
    );
  }
}

/** Optional inclusive upper window edge (item 2): `AND sampled_at <= ?` when a
 * cutoff is supplied, byte-identical SQL when it is not — so an until-less call
 * matches the pre-item-2 query exactly. */
function untilClause(untilMs: number | null | undefined): {
  sql: string;
  binds: number[];
} {
  return untilMs != null
    ? { sql: " AND sampled_at <= ?", binds: [untilMs] }
    : { sql: "", binds: [] };
}

/** Long-range planet samples within the window — the NEWEST `limit` rows when
 * capped (selected DESC, then re-sorted ascending for presentation), so a
 * busy window never silently drops its most recent points. `untilMs` (item 2)
 * closes the window's upper edge so older bands can be paged. */
export async function readPlanetArchive(
  env: Env,
  planetIndex: number,
  sinceMs: number,
  limit: number,
  untilMs: number | null = null,
): Promise<PlanetArchiveRow[]> {
  const db = requireDb(env);
  const until = untilClause(untilMs);
  const rows = await runArchiveQuery<PlanetArchiveRow>(
    db
      .prepare(
        `SELECT planet_index, sampled_at, health, max_health, hp_per_hour, campaign_id, campaign_kind, faction
           FROM planet_samples
          WHERE planet_index = ? AND sampled_at >= ?${until.sql}
          ORDER BY sampled_at DESC
          LIMIT ?`,
      )
      .bind(planetIndex, sinceMs, ...until.binds, limit),
    "planet archive",
  );
  return rows.sort((a, b) => a.sampled_at - b.sampled_at);
}

/** Long-range global war-statistics samples — the NEWEST `limit` rows when
 * capped, re-sorted ascending for presentation. */
export async function readGlobalArchive(
  env: Env,
  sinceMs: number,
  limit: number,
  untilMs: number | null = null,
): Promise<GlobalArchiveRow[]> {
  const db = requireDb(env);
  const until = untilClause(untilMs);
  const rows = await runArchiveQuery<GlobalArchiveRow>(
    db
      .prepare(
        `SELECT sampled_at, player_count, impact_multiplier, active_campaign_count,
                missions_won, missions_lost, deaths, terminid_kills, automaton_kills, illuminate_kills
           FROM global_samples
          WHERE sampled_at >= ?${until.sql}
          ORDER BY sampled_at DESC
          LIMIT ?`,
      )
      .bind(sinceMs, ...until.binds, limit),
    "global archive",
  );
  return rows.sort((a, b) => a.sampled_at - b.sampled_at);
}

/**
 * Long-range Major Order objective-progress samples, optionally narrowed to one
 * MO id and/or one objective index. Returns the NEWEST `limit` rows when capped
 * (DESC + LIMIT across all matching objectives), re-sorted ascending; the tool
 * then groups them into per-objective series. The query stays parameterized
 * regardless of which optional filters are present.
 */
export async function readMoArchive(
  env: Env,
  sinceMs: number,
  limit: number,
  filters: {
    majorOrderId?: number;
    objectiveIndex?: number;
    untilMs?: number | null;
  } = {},
): Promise<MoArchiveRow[]> {
  const db = requireDb(env);
  const where: string[] = ["sampled_at >= ?"];
  const binds: unknown[] = [sinceMs];
  if (filters.untilMs != null) {
    where.push("sampled_at <= ?");
    binds.push(filters.untilMs);
  }
  if (filters.majorOrderId != null) {
    where.push("major_order_id = ?");
    binds.push(filters.majorOrderId);
  }
  if (filters.objectiveIndex != null) {
    where.push("objective_index = ?");
    binds.push(filters.objectiveIndex);
  }
  binds.push(limit);
  const rows = await runArchiveQuery<MoArchiveRow>(
    db
      .prepare(
        `SELECT major_order_id, objective_index, sampled_at, progress, target
           FROM mo_progress_samples
          WHERE ${where.join(" AND ")}
          ORDER BY sampled_at DESC
          LIMIT ?`,
      )
      .bind(...binds),
    "major order archive",
  );
  return rows.sort((a, b) => a.sampled_at - b.sampled_at);
}

/* ------------------------------------------------------------------------
 * Item 6 (get_war_diff): window-edge readers. Each returns ONE row per
 * subject — its FIRST or LAST observation inside [sinceMs, untilMs] — using
 * SQLite's documented bare-column guarantee: with a single MIN()/MAX()
 * aggregate, the non-aggregated columns come from the row where that
 * minimum/maximum occurs (D1 is SQLite). This keeps the diff O(subjects)
 * rows regardless of how many samples the window holds.
 * ---------------------------------------------------------------------- */

/** First/last archived planet observation per planet inside the window. */
export async function readPlanetEdgeRows(
  env: Env,
  sinceMs: number,
  untilMs: number,
  edge: "first" | "last",
): Promise<PlanetArchiveRow[]> {
  const db = requireDb(env);
  const fn = edge === "first" ? "MIN" : "MAX";
  return runArchiveQuery<PlanetArchiveRow>(
    db
      .prepare(
        `SELECT planet_index, health, max_health, hp_per_hour, campaign_id, campaign_kind, faction,
                ${fn}(sampled_at) AS sampled_at
           FROM planet_samples
          WHERE sampled_at >= ? AND sampled_at <= ?
          GROUP BY planet_index`,
      )
      .bind(sinceMs, untilMs),
    "planet archive window edges",
  );
}

/** First/last archived MO objective observation per objective in the window. */
export async function readMoEdgeRows(
  env: Env,
  sinceMs: number,
  untilMs: number,
  edge: "first" | "last",
): Promise<MoArchiveRow[]> {
  const db = requireDb(env);
  const fn = edge === "first" ? "MIN" : "MAX";
  return runArchiveQuery<MoArchiveRow>(
    db
      .prepare(
        `SELECT major_order_id, objective_index, progress, target,
                ${fn}(sampled_at) AS sampled_at
           FROM mo_progress_samples
          WHERE sampled_at >= ? AND sampled_at <= ?
          GROUP BY major_order_id, objective_index`,
      )
      .bind(sinceMs, untilMs),
    "major order archive window edges",
  );
}

/** First or last archived global sample inside the window (null when none). */
export async function readGlobalEdgeRow(
  env: Env,
  sinceMs: number,
  untilMs: number,
  edge: "first" | "last",
): Promise<GlobalArchiveRow | null> {
  const db = requireDb(env);
  const dir = edge === "first" ? "ASC" : "DESC";
  const rows = await runArchiveQuery<GlobalArchiveRow>(
    db
      .prepare(
        `SELECT sampled_at, player_count, impact_multiplier, active_campaign_count,
                missions_won, missions_lost, deaths, terminid_kills, automaton_kills, illuminate_kills
           FROM global_samples
          WHERE sampled_at >= ? AND sampled_at <= ?
          ORDER BY sampled_at ${dir}
          LIMIT 1`,
      )
      .bind(sinceMs, untilMs),
    "global archive window edge",
  );
  return rows[0] ?? null;
}

/** Overall archive coverage — the oldest/newest global sample ever archived.
 * Lets a windowed read say honestly when the window predates the archive. */
export async function readArchiveCoverage(
  env: Env,
): Promise<{ earliest: number | null; latest: number | null }> {
  const db = requireDb(env);
  const rows = await runArchiveQuery<{ earliest: number | null; latest: number | null }>(
    db.prepare(
      `SELECT MIN(sampled_at) AS earliest, MAX(sampled_at) AS latest FROM global_samples`,
    ),
    "archive coverage",
  );
  return rows[0] ?? { earliest: null, latest: null };
}

/* ------------------------------------------------------------------------
 * Item 8 (get_health): self-report reads. All plain SELECTs; a missing
 * quarantine table (migration 0003 not applied) degrades that section rather
 * than failing the whole health report.
 * ---------------------------------------------------------------------- */

const HEALTH_TABLES = [
  "planet_samples",
  "global_samples",
  "mo_progress_samples",
  "observed_signatures",
  "quarantined_samples",
] as const;
export type HealthTable = (typeof HEALTH_TABLES)[number];

/** Row counts per archive table. A table that cannot be counted (e.g. its
 * migration is not applied yet) reports null, never a thrown health check. */
export async function readArchiveCounts(
  env: Env,
): Promise<Record<HealthTable, number | null>> {
  const db = requireDb(env);
  const counts = {} as Record<HealthTable, number | null>;
  for (const table of HEALTH_TABLES) {
    try {
      // Table names come from the fixed HEALTH_TABLES list above, never from
      // caller input — the values in play are all bound (there are none).
      const res = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
        .first<{ n: number }>();
      counts[table] = res?.n ?? 0;
    } catch {
      counts[table] = null;
    }
  }
  return counts;
}

/** The archived global sample timestamps in a window (ascending) — the
 * cadence record get_health's gap/adherence arithmetic runs over. Capped at
 * the NEWEST `limit` rows like every archive read. */
export async function readGlobalSampleTimestamps(
  env: Env,
  sinceMs: number,
  limit: number,
): Promise<number[]> {
  const db = requireDb(env);
  const rows = await runArchiveQuery<{ sampled_at: number }>(
    db
      .prepare(
        `SELECT sampled_at FROM global_samples
          WHERE sampled_at >= ?
          ORDER BY sampled_at DESC
          LIMIT ?`,
      )
      .bind(sinceMs, limit),
    "global sample timestamps",
  );
  return rows.map((r) => r.sampled_at).sort((a, b) => a - b);
}

/** Quarantine tallies per reason + the most recent quarantined rows (both
 * numbers and the verbatim excluded row ride each entry). Degrades to nulls
 * when the quarantine table does not exist yet. */
export async function readQuarantineSummary(
  env: Env,
  recentLimit: number,
): Promise<{
  counts_by_reason: Record<string, number> | null;
  recent: QuarantineRow[] | null;
}> {
  const db = requireDb(env);
  try {
    const byReason = await db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM quarantined_samples GROUP BY reason ORDER BY reason`,
      )
      .all<{ reason: string; n: number }>();
    const counts: Record<string, number> = {};
    for (const r of byReason.results ?? []) counts[r.reason] = r.n;
    const recent = await db
      .prepare(
        `SELECT table_name, subject_key, sampled_at, reason, detail, row_json, tick_anchor
           FROM quarantined_samples
          ORDER BY sampled_at DESC
          LIMIT ?`,
      )
      .bind(recentLimit)
      .all<QuarantineRow>();
    return { counts_by_reason: counts, recent: recent.results ?? [] };
  } catch {
    return { counts_by_reason: null, recent: null };
  }
}

/** Clamp a caller-supplied row limit into [1, ARCHIVE_MAX_LIMIT]. */
export function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return ARCHIVE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(ARCHIVE_MAX_LIMIT, Math.floor(limit)));
}

/** Resolve a since-window (in hours) to an absolute epoch-ms cutoff. */
export function sinceCutoffMs(
  sinceHours: number | undefined,
  nowMs: number,
): number {
  const hours =
    sinceHours != null && Number.isFinite(sinceHours) && sinceHours > 0
      ? sinceHours
      : ARCHIVE_DEFAULT_SINCE_HOURS;
  return nowMs - hours * 3_600_000;
}

/** Item 2: resolve an optional end-of-window (hours back from now) to an
 * absolute epoch-ms cutoff. Absent/invalid → null (open upper edge, the
 * pre-item-2 behavior). 0 is valid ("up to now"). */
export function untilCutoffMs(
  untilHours: number | undefined,
  nowMs: number,
): number | null {
  if (untilHours == null || !Number.isFinite(untilHours) || untilHours < 0) {
    return null;
  }
  return nowMs - untilHours * 3_600_000;
}
