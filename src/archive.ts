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

/** One sample tick's archive payload — exactly the observations that were just
 * committed to KV as NEW this cycle. The caller (client.ts) gates each section
 * by the SAME 60s interval that governs the KV write, so a within-60s replay
 * produces an empty tick and inserts nothing. */
export interface ArchiveTick {
  planets: PlanetArchiveRow[];
  global: GlobalArchiveRow | null;
  mo: MoArchiveRow[];
  signatures: SignatureArchiveRow[];
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
  if (
    tick.planets.length === 0 &&
    tick.global == null &&
    tick.mo.length === 0 &&
    tick.signatures.length === 0
  ) {
    return;
  }

  try {
    const batch: D1PreparedStatement[] = [];

    if (tick.planets.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO planet_samples
           (planet_index, sampled_at, health, max_health, hp_per_hour, campaign_id, campaign_kind, faction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
        );
      }
    }

    if (tick.global != null) {
      const g = tick.global;
      batch.push(
        db
          .prepare(
            `INSERT INTO global_samples
               (sampled_at, player_count, impact_multiplier, active_campaign_count,
                missions_won, missions_lost, deaths, terminid_kills, automaton_kills, illuminate_kills)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
      );
    }

    if (tick.mo.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO mo_progress_samples
           (major_order_id, objective_index, sampled_at, progress, target)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of tick.mo) {
        batch.push(
          stmt.bind(
            r.major_order_id,
            r.objective_index,
            r.sampled_at,
            r.progress,
            r.target,
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

/** Long-range planet samples ordered oldest → newest, within the window. */
export async function readPlanetArchive(
  env: Env,
  planetIndex: number,
  sinceMs: number,
  limit: number,
): Promise<PlanetArchiveRow[]> {
  const db = requireDb(env);
  return runArchiveQuery<PlanetArchiveRow>(
    db
      .prepare(
        `SELECT planet_index, sampled_at, health, max_health, hp_per_hour, campaign_id, campaign_kind, faction
           FROM planet_samples
          WHERE planet_index = ? AND sampled_at >= ?
          ORDER BY sampled_at ASC
          LIMIT ?`,
      )
      .bind(planetIndex, sinceMs, limit),
    "planet archive",
  );
}

/** Long-range global war-statistics samples ordered oldest → newest. */
export async function readGlobalArchive(
  env: Env,
  sinceMs: number,
  limit: number,
): Promise<GlobalArchiveRow[]> {
  const db = requireDb(env);
  return runArchiveQuery<GlobalArchiveRow>(
    db
      .prepare(
        `SELECT sampled_at, player_count, impact_multiplier, active_campaign_count,
                missions_won, missions_lost, deaths, terminid_kills, automaton_kills, illuminate_kills
           FROM global_samples
          WHERE sampled_at >= ?
          ORDER BY sampled_at ASC
          LIMIT ?`,
      )
      .bind(sinceMs, limit),
    "global archive",
  );
}

/**
 * Long-range Major Order objective-progress samples ordered oldest → newest,
 * optionally narrowed to one MO id and/or one objective index. Returns flat
 * rows; the tool groups them into per-objective series. The query stays
 * parameterized regardless of which optional filters are present.
 */
export async function readMoArchive(
  env: Env,
  sinceMs: number,
  limit: number,
  filters: { majorOrderId?: number; objectiveIndex?: number } = {},
): Promise<MoArchiveRow[]> {
  const db = requireDb(env);
  const where: string[] = ["sampled_at >= ?"];
  const binds: unknown[] = [sinceMs];
  if (filters.majorOrderId != null) {
    where.push("major_order_id = ?");
    binds.push(filters.majorOrderId);
  }
  if (filters.objectiveIndex != null) {
    where.push("objective_index = ?");
    binds.push(filters.objectiveIndex);
  }
  binds.push(limit);
  return runArchiveQuery<MoArchiveRow>(
    db
      .prepare(
        `SELECT major_order_id, objective_index, sampled_at, progress, target
           FROM mo_progress_samples
          WHERE ${where.join(" AND ")}
          ORDER BY sampled_at ASC
          LIMIT ?`,
      )
      .bind(...binds),
    "major order archive",
  );
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
