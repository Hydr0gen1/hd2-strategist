-- Stage 14 (bulk CSV export): a sampled_at-leading index on planet_samples.
--
-- The whole-archive planet export (`export_archive table=planet` with no
-- planet_index) keyset-paginates with `WHERE (sampled_at > ? OR (sampled_at = ?
-- AND id > ?)) ORDER BY sampled_at ASC, id ASC` — a pure time-range scan with no
-- planet_index constraint. The existing idx_planet_samples_planet_time on
-- (planet_index, sampled_at) cannot serve that shape, so SQLite would scan the
-- table and build a temp b-tree for the ORDER BY, rescanning/sorting each page
-- as the unbounded archive grows.
--
-- This mirrors the idx_global_samples_time / idx_mo_progress_time indexes added
-- in 0001 for exactly the same reason on the other two archive tables — the
-- planet table was the remaining gap. (sampled_at, id) covers the keyset's full
-- ORDER BY including the id tiebreaker. Additive and idempotent: no table shape,
-- column, or live-path change.
CREATE INDEX IF NOT EXISTS idx_planet_samples_time
  ON planet_samples (sampled_at, id);
