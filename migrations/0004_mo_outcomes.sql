-- Item 10 (next-features wave, Tier 4): the Major Order outcome log.
--
-- One row per (major_order_id, objective_index), written when a tracked MO id
-- is no longer in the live assignments set (the observed end of the order):
-- a deterministic record of the objective's FINAL OBSERVED state — the last
-- retained progress/target sample, its progress %, and target_reached (the
-- plain comparison final_progress >= target; NULL when either side is
-- unknown). No analysis, no cause attribution: "the target was reached by
-- the last observation" is a fact; why the order went the way it did is not
-- recorded. The natural primary key makes the write idempotent (INSERT OR
-- IGNORE) — the detection re-fires on later ticks while the retired series
-- is still retained, and every repeat is a no-op, so first-writer-wins and
-- there are never duplicate outcome rows.
CREATE TABLE IF NOT EXISTS mo_outcomes (
  major_order_id     INTEGER NOT NULL,
  objective_index    INTEGER NOT NULL,
  task_type          INTEGER,            -- raw upstream task type (nullable, as stored in the series)
  final_progress     INTEGER,            -- the last observed progress (nullable)
  target             INTEGER,            -- the last observed target (nullable)
  final_progress_pct REAL,               -- final_progress / target × 100 (NULL when target is 0/unknown)
  target_reached     INTEGER,            -- 1/0 = final_progress >= target; NULL when either is unknown
  first_observed_at  INTEGER,            -- epoch ms of the series' first retained sample
  last_observed_at   INTEGER,            -- epoch ms of the series' final retained sample
  recorded_at        INTEGER NOT NULL,   -- epoch ms when the end of the order was detected
  PRIMARY KEY (major_order_id, objective_index)
);
CREATE INDEX IF NOT EXISTS idx_mo_outcomes_recorded
  ON mo_outcomes (recorded_at);
