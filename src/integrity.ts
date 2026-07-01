/**
 * Next-features wave, Tier 3 — pure data-integrity helpers:
 *
 * - The item 7 plausibility screen for archive-bound global rows
 *   (`screenGlobalRow`): the known sentinel signature + an Nσ delta-outlier
 *   rule over the recent KV series. It QUARANTINES rather than records —
 *   a failing row is diverted to the quarantined_samples table with a reason
 *   and both sides of the comparison, never silently dropped and never
 *   "corrected". The KV ring buffer and the response path are untouched
 *   (flagged data is still SERVED live); only the durable archive is kept
 *   clean. The allFresh persistence gate is unchanged.
 * - The item 8 get_health arithmetic (`buildGapList`, `cadenceStats`):
 *   deterministic gap/cadence facts over archived sample timestamps.
 *
 * Pure. Zero I/O — rows and series arrive from the caller; the D1 write for
 * quarantined rows lives in archive.ts like every other archive write.
 */
import type { GlobalArchiveWriteRow } from "./archive";
import type { GlobalSample } from "./sampling";

/** The known bogus global-stats snapshot upstream occasionally serves (the
 * pair that motivated the serve-but-don't-record rule): player_count 18145
 * with impactMultiplier 0.07364573. Matched as a PAIR — either value alone is
 * conceivably legitimate. */
export const SENTINEL_PLAYER_COUNT = 18_145;
export const SENTINEL_IMPACT_MULTIPLIER = 0.073_645_73;
const SENTINEL_MULTIPLIER_TOLERANCE = 1e-9;

/** Nσ rule parameters. The threshold is deliberately WIDE (6σ) and requires a
 * minimum history so ordinary population swings (daily cycle, a big MO
 * finishing) never trip it — only a discontinuity far outside every recently
 * observed delta (e.g. the June 28 pop=3552 dip) does. Deterministic
 * constants, documented in the quarantine reason detail. */
export const OUTLIER_SIGMA_THRESHOLD = 6;
export const OUTLIER_MIN_DELTAS = 8;

/** Global fields the delta-outlier rule watches: the population gauge and the
 * cumulative counters. impact_multiplier is excluded — it legitimately steps
 * (game-master changes), and the sentinel PAIR covers its known-bad value. */
export const OUTLIER_FIELDS = [
  "player_count",
  "missions_won",
  "missions_lost",
  "deaths",
  "terminid_kills",
  "automaton_kills",
  "illuminate_kills",
] as const;
type OutlierField = (typeof OUTLIER_FIELDS)[number];

export type QuarantineReason =
  | "known_sentinel_signature"
  | "delta_exceeds_sigma_bound";

/** One screen finding: the machine-readable reason plus BOTH sides of the
 * comparison (observed vs the statistics it violated) — flag, never correct. */
export interface QuarantineFinding {
  reason: QuarantineReason;
  detail: Record<string, unknown>;
}

function deltasOf(series: ReadonlyArray<GlobalSample>, field: OutlierField): number[] {
  const deltas: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1]![field];
    const b = series[i]![field];
    if (typeof a === "number" && typeof b === "number") deltas.push(b - a);
  }
  return deltas;
}

/**
 * Item 7: screen ONE archive-bound global row against (a) the known sentinel
 * signature and (b) the Nσ delta-outlier rule over the RECENT KV series (the
 * pre-advance store — the same window every live rate reads). Returns every
 * finding; an empty array means the row is archivable. The rule is
 * deterministic: per watched field, the new delta (row value − newest recent
 * value) is compared against the mean ± Nσ band of the recent consecutive
 * deltas; below OUTLIER_MIN_DELTAS deltas, or with zero spread, the rule
 * abstains (never a guess on thin history).
 */
export function screenGlobalRow(
  row: GlobalArchiveWriteRow,
  recent: ReadonlyArray<GlobalSample>,
): QuarantineFinding[] {
  const findings: QuarantineFinding[] = [];

  if (
    row.player_count === SENTINEL_PLAYER_COUNT &&
    row.impact_multiplier != null &&
    Math.abs(row.impact_multiplier - SENTINEL_IMPACT_MULTIPLIER) <
      SENTINEL_MULTIPLIER_TOLERANCE
  ) {
    findings.push({
      reason: "known_sentinel_signature",
      detail: {
        observed_player_count: row.player_count,
        observed_impact_multiplier: row.impact_multiplier,
        sentinel_player_count: SENTINEL_PLAYER_COUNT,
        sentinel_impact_multiplier: SENTINEL_IMPACT_MULTIPLIER,
        note: "The known bogus upstream snapshot (both values matched as a pair).",
      },
    });
  }

  const newest = recent[recent.length - 1];
  if (newest) {
    for (const field of OUTLIER_FIELDS) {
      const prev = newest[field];
      const cur = row[field];
      if (typeof prev !== "number" || typeof cur !== "number") continue;
      const deltas = deltasOf(recent, field);
      if (deltas.length < OUTLIER_MIN_DELTAS) continue;
      const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      const variance =
        deltas.reduce((s, d) => s + (d - mean) * (d - mean), 0) / deltas.length;
      const stddev = Math.sqrt(variance);
      if (stddev <= 0) continue; // zero spread: abstain, never divide
      const observedDelta = cur - prev;
      if (Math.abs(observedDelta - mean) > OUTLIER_SIGMA_THRESHOLD * stddev) {
        findings.push({
          reason: "delta_exceeds_sigma_bound",
          detail: {
            field,
            observed_value: cur,
            previous_value: prev,
            observed_delta: observedDelta,
            recent_delta_mean: mean,
            recent_delta_stddev: stddev,
            recent_delta_count: deltas.length,
            sigma_threshold: OUTLIER_SIGMA_THRESHOLD,
          },
        });
      }
    }
  }

  return findings;
}

/* ------------------------- item 8: get_health -------------------------- */

/** One observed gap between consecutive archived samples. */
export interface SampleGap {
  gap_start: string;
  gap_end: string;
  gap_minutes: number;
}

/**
 * Item 8: gaps longer than `thresholdMs` between consecutive timestamps
 * (ascending input assumed; re-sorted defensively). Observed spacing facts —
 * a gap means "nothing was archived here", whether from an outage, a
 * degraded-provenance tick that (correctly) recorded nothing, or the Worker
 * simply not running; attributing the cause is the consumer's.
 */
export function buildGapList(
  timestamps: ReadonlyArray<number>,
  thresholdMs: number,
): SampleGap[] {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps: SampleGap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i]! - sorted[i - 1]!;
    if (span > thresholdMs) {
      gaps.push({
        gap_start: new Date(sorted[i - 1]!).toISOString(),
        gap_end: new Date(sorted[i]!).toISOString(),
        gap_minutes: span / 60_000,
      });
    }
  }
  return gaps;
}

/** Item 8: deterministic cadence facts over archived sample timestamps. */
export interface CadenceStats {
  samples: number;
  intervals: number;
  /** Intervals at or under the adherence threshold. */
  intervals_within_threshold: number;
  /** intervals_within_threshold / intervals × 100 — null with no intervals. */
  adherence_pct: number | null;
  /** Ticks the cadence WOULD have produced over the observed span at the
   * expected interval, vs the samples actually archived. A shortfall counts
   * outages AND degraded-provenance ticks that (by design) recorded nothing —
   * the two are indistinguishable in the archive, and the archive is the
   * record. */
  ticks_expected_over_span: number | null;
  ticks_archived: number;
}

export function cadenceStats(
  timestamps: ReadonlyArray<number>,
  expectedIntervalMs: number,
  thresholdMs: number,
): CadenceStats {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let within = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! <= thresholdMs) within += 1;
  }
  const intervals = Math.max(0, sorted.length - 1);
  const span =
    sorted.length >= 2 ? sorted[sorted.length - 1]! - sorted[0]! : null;
  return {
    samples: sorted.length,
    intervals,
    intervals_within_threshold: within,
    adherence_pct: intervals > 0 ? (within / intervals) * 100 : null,
    ticks_expected_over_span:
      span != null ? Math.floor(span / expectedIntervalMs) + 1 : null,
    ticks_archived: sorted.length,
  };
}
