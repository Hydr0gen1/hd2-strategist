-- Item 7 (next-features wave, Tier 3): the anomaly quarantine table.
--
-- Rows that FAIL the plausibility screen at the D1 persist path land here
-- instead of the live archive table — quarantined, never silently dropped and
-- never mixed into the record the archive tools serve. Each row carries a
-- machine-readable reason and a `detail` JSON stating BOTH sides of the
-- comparison (the observed value and the recent-history statistics it was
-- screened against) plus the excluded row verbatim (`row_json`), so a
-- quarantine decision is always auditable — the screen flags implausibility,
-- it never "corrects" data.
--
-- The screen does NOT touch the KV ring buffer or the response path: a
-- flagged observation is still SERVED live (the KV/rate path is frozen); it
-- is only kept out of the durable archive. The allFresh persistence gate is
-- unchanged — this is an extra branch at the archive write, not a relaxation.
CREATE TABLE IF NOT EXISTS quarantined_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT NOT NULL,      -- the live table the row was destined for (e.g. 'global_samples')
  subject_key TEXT NOT NULL,      -- row identity within the tick (e.g. 'global', 'planet:185')
  sampled_at  INTEGER NOT NULL,   -- epoch ms, the Worker sample time
  reason      TEXT NOT NULL,      -- 'known_sentinel_signature' | 'delta_exceeds_sigma_bound'
  detail      TEXT NOT NULL,      -- JSON: the observed value AND the statistics it violated
  row_json    TEXT NOT NULL,      -- the excluded row, verbatim
  -- Same race-proof dedup discipline as every append-only archive table: two
  -- overlapping polls share the predecessor anchor, so the second
  -- INSERT OR IGNORE no-ops at the DB level.
  tick_anchor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantined_time
  ON quarantined_samples (sampled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quarantined_dedup
  ON quarantined_samples (table_name, subject_key, tick_anchor);
