-- Stage 12: the unbounded D1 history archive.
--
-- This database is an APPEND-ONLY long-term record that lives ALONGSIDE the
-- KV ring buffer (samples:planets) — it never replaces it. The KV store stays
-- the fast recent-window source of truth for every live calculation
-- (hp_per_hour, the dual ETAs, divergence); D1 is read only by the explicit
-- archive tools (get_planet_archive / get_global_archive / get_major_order_archive)
-- when someone wants the long view. The two stores serve different time ranges
-- and never reconcile.
--
-- The indexes below are NOT optional: every archive read is a time-range scan
-- (WHERE sampled_at >= ? ... ORDER BY sampled_at), so the (key, sampled_at)
-- composite indexes are what keep those queries fast as the tables grow.

-- One row per planet per sample tick.
CREATE TABLE IF NOT EXISTS planet_samples (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  planet_index  INTEGER NOT NULL,
  sampled_at    INTEGER NOT NULL,   -- epoch ms, the Worker sample time
  health        INTEGER,            -- raw HP at sample time (nullable if absent upstream)
  max_health    INTEGER,
  hp_per_hour   REAL,               -- the signed rate computed for this tick (nullable when stabilizing)
  campaign_id   INTEGER,
  campaign_kind TEXT,               -- 'liberation' | 'defense'
  faction       TEXT
);
CREATE INDEX IF NOT EXISTS idx_planet_samples_planet_time
  ON planet_samples (planet_index, sampled_at);

-- One row per sample tick (global war stats).
CREATE TABLE IF NOT EXISTS global_samples (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at            INTEGER NOT NULL,
  player_count          INTEGER,
  impact_multiplier     REAL,
  active_campaign_count INTEGER,
  missions_won          INTEGER,
  missions_lost         INTEGER,
  deaths                INTEGER,
  terminid_kills        INTEGER,
  automaton_kills       INTEGER,
  illuminate_kills      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_global_samples_time
  ON global_samples (sampled_at);

-- One row per MO objective per sample tick.
CREATE TABLE IF NOT EXISTS mo_progress_samples (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  major_order_id  INTEGER NOT NULL,
  objective_index INTEGER NOT NULL,
  sampled_at      INTEGER NOT NULL,
  progress        INTEGER,
  target          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mo_progress_order_obj_time
  ON mo_progress_samples (major_order_id, objective_index, sampled_at);

-- Observed campaign signatures (Stage 5 equivalent, now durable).
CREATE TABLE IF NOT EXISTS observed_signatures (
  signature     TEXT PRIMARY KEY,   -- a stable key like "type:0|event:null|faction:Terminids"
  campaign_type INTEGER,
  event_type    INTEGER,
  has_event     INTEGER,            -- 0/1
  faction       TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  sample_count  INTEGER NOT NULL
);
