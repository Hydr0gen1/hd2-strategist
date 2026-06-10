/**
 * Stage 1 + Stage 2 enrichment: lean fact pass-throughs from fetched
 * payloads. Pure — zero I/O; the handler layer (tools.ts) feeds in raw
 * objects and the clock. Every field is either raw upstream data or a
 * deterministic unit conversion — never a judgment.
 */
import type { HealthSample } from "./sampling";
import type {
  BiomeInfo,
  DefenseTiming,
  DispatchInfo,
  FrontRateAggregate,
  HazardInfo,
  PatchNoteInfo,
  PlanetHistoryPoint,
  PlanetStatistics,
  RawBiome,
  RawDispatch,
  RawEvent,
  RawHazard,
  RawStatistics,
  RawSteamNews,
} from "./types";

const MS_PER_HOUR = 3_600_000;
const SECONDS_PER_HOUR = 3_600;

/** Dispatch feed limits: bound the payload, never the facts. */
export const DISPATCHES_DEFAULT_LIMIT = 10;
export const DISPATCHES_MAX_LIMIT = 25;
/** Patch-note limits are tighter: entries are several KB of BBCode each. */
export const PATCH_NOTES_DEFAULT_LIMIT = 5;
export const PATCH_NOTES_MAX_LIMIT = 10;

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Derived success rate as a percentage (0–100, two decimals), guarded for
 * divide-by-zero: zero recorded missions → null, never 0, never fabricated.
 */
export function missionSuccessRate(
  wins: number | null,
  losses: number | null,
): number | null {
  if (wins == null || losses == null) return null;
  const total = wins + losses;
  if (!(total > 0)) return null;
  return Math.round((wins / total) * 10_000) / 100;
}

/**
 * Named subset of the upstream statistics block — deliberately NOT the whole
 * raw object, so payloads stay lean. Missing block → null, never fabricated
 * counts.
 */
export function selectPlanetStatistics(
  stats: RawStatistics | null | undefined,
): PlanetStatistics | null {
  if (!stats) return null;
  const wins = finiteOrNull(stats.missionsWon);
  const losses = finiteOrNull(stats.missionsLost);
  return {
    player_count: finiteOrNull(stats.playerCount),
    mission_wins: wins,
    mission_losses: losses,
    mission_success_rate: missionSuccessRate(wins, losses),
    kills: {
      terminid: finiteOrNull(stats.terminidKills),
      automaton: finiteOrNull(stats.automatonKills),
      illuminate: finiteOrNull(stats.illuminateKills),
    },
  };
}

/**
 * Defense deadline facts from the event block. Hours remaining is a plain
 * (endTime − now) unit conversion clamped at 0 — a number, never an
 * urgent/safe verdict. Missing endTime → null timing, never computed from a
 * missing bound.
 *
 * Clock note: nowMs is the Worker clock, supplied by the handler. The
 * upstream war `now` field is game-epoch time (observed "1972-04-26T…") and
 * is NOT comparable to the event's real-world ISO timestamps; Major Order
 * `expires_in` uses this same Worker-clock-vs-real-ISO convention.
 */
export function defenseTiming(event: RawEvent, nowMs: number): DefenseTiming {
  const startedAt =
    typeof event.startTime === "string" ? event.startTime : null;
  const endsAt = typeof event.endTime === "string" ? event.endTime : null;
  const endMs = endsAt != null ? Date.parse(endsAt) : NaN;
  if (!Number.isFinite(endMs)) {
    return {
      defense_started_at: startedAt,
      defense_ends_at: endsAt,
      defense_hours_remaining: null,
      defense_expired: null,
    };
  }
  const hoursRemaining = (endMs - nowMs) / MS_PER_HOUR;
  return {
    defense_started_at: startedAt,
    defense_ends_at: endsAt,
    defense_hours_remaining: Math.max(0, hoursRemaining),
    defense_expired: hoursRemaining <= 0,
  };
}

/** Biome pass-through: name/description exactly as upstream sends them. */
export function selectBiome(
  biome: RawBiome | null | undefined,
): BiomeInfo | null {
  if (!biome) return null;
  return {
    name: typeof biome.name === "string" ? biome.name : null,
    description:
      typeof biome.description === "string" ? biome.description : null,
  };
}

/** Clamp a caller-supplied limit: junk/<1 → default, >cap → cap, floored. */
function clampLimit(
  limit: unknown,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return defaultLimit;
  }
  return Math.min(Math.floor(limit), maxLimit);
}

/** Newest-first sort key: unparseable timestamps sink to the end. */
function publishedMs(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Dispatch pass-through: id/published/type/message exactly as upstream sends
 * them (message keeps its in-game markup — rendering is the consumer's job).
 * Defensively sorted newest-first by `published` even though upstream already
 * sends that order; bounded by a clamped limit.
 */
export function shapeDispatches(
  raw: RawDispatch[] | null | undefined,
  limit?: unknown,
): DispatchInfo[] {
  const n = clampLimit(limit, DISPATCHES_DEFAULT_LIMIT, DISPATCHES_MAX_LIMIT);
  return (Array.isArray(raw) ? [...raw] : [])
    .sort(
      (a, b) =>
        publishedMs(b.published) - publishedMs(a.published) ||
        (b.id ?? 0) - (a.id ?? 0),
    )
    .slice(0, n)
    .map((d) => ({
      id: d.id,
      published: d.published,
      type: d.type,
      message: d.message,
    }));
}

/**
 * Steam patch-note pass-through, newest-first. `content` is the verbatim
 * BBCode body — the upstream has no summary field and the server derives
 * none (a summary would be an interpretive transformation).
 */
export function shapePatchNotes(
  raw: RawSteamNews[] | null | undefined,
  limit?: unknown,
): PatchNoteInfo[] {
  const n = clampLimit(limit, PATCH_NOTES_DEFAULT_LIMIT, PATCH_NOTES_MAX_LIMIT);
  return (Array.isArray(raw) ? [...raw] : [])
    .sort((a, b) => publishedMs(b.publishedAt) - publishedMs(a.publishedAt))
    .slice(0, n)
    .map((p) => ({
      id: p.id,
      title: p.title,
      author: p.author,
      published: p.publishedAt,
      url: p.url,
      content: p.content,
    }));
}

/**
 * Observed history points from a retained sample series (oldest → newest).
 * Each point after the first carries the raw deltas from its predecessor:
 * delta_health = current − previous (negative = health depleting) and
 * delta_hours. Deterministic differences only — no smoothing, no forecast,
 * no trend label. Note the orientation difference vs hp_per_hour, which is
 * (previous − current) / hours with positive = progressing; both formulas
 * are restated in the tool payload so neither convention is a surprise.
 */
export function buildHistoryPoints(
  samples: HealthSample[],
): PlanetHistoryPoint[] {
  return samples.map((s, i) => {
    const prev = i > 0 ? samples[i - 1] : undefined;
    return {
      health: s.h,
      t: s.t,
      observed_at: new Date(s.t).toISOString(),
      delta_health: prev ? s.h - prev.h : null,
      delta_hours: prev ? (s.t - prev.t) / MS_PER_HOUR : null,
    };
  });
}

/**
 * Stage 3: regen expressed per hour — regenPerSecond × 3600, a pure unit
 * conversion so regen reads in the same units as hp_per_hour.
 *
 * Invariant-1 guard: the input MUST be the already-normalized
 * `regen_per_second` (force-nulled for defense campaigns by
 * nullifyDefenseDecay) — never the raw upstream value. Deriving from the
 * nulled field means this conversion can never re-expose a defense
 * campaign's cosmetic decay. Missing/garbled regen → null, never fabricated.
 */
export function decayPerHour(
  normalizedRegenPerSecond: number | null,
): number | null {
  if (
    normalizedRegenPerSecond == null ||
    !Number.isFinite(normalizedRegenPerSecond)
  ) {
    return null;
  }
  return normalizedRegenPerSecond * SECONDS_PER_HOUR;
}

/**
 * Stage 3: per-front aggregate over the SAME signed per-campaign hp_per_hour
 * values the normalization layer already produced — one signed source of
 * truth, never recomputed here. A bare sum plus coverage counts, not a
 * verdict: a negative or zero sum is a legitimate value and carries no
 * label or alert.
 *
 * Honesty rules: null rates (stabilizing/cold-start planets) are unknowns —
 * excluded from the sum, never coerced to 0, with the gap legible as
 * planets_with_rate < planets_total. A front with zero known rates reports
 * net_hp_per_hour: null (honest unknown), never a fake 0.
 */
export function aggregateFrontRate(
  rates: ReadonlyArray<number | null>,
): FrontRateAggregate {
  let sum = 0;
  let withRate = 0;
  for (const rate of rates) {
    if (typeof rate === "number" && Number.isFinite(rate)) {
      sum += rate;
      withRate += 1;
    }
  }
  return {
    net_hp_per_hour: withRate > 0 ? sum : null,
    planets_with_rate: withRate,
    planets_total: rates.length,
  };
}

/** Hazard pass-through: always an array — [] when upstream sends none. */
export function selectHazards(
  hazards: RawHazard[] | null | undefined,
): HazardInfo[] {
  if (!Array.isArray(hazards)) return [];
  return hazards.map((h) => ({
    name: typeof h?.name === "string" ? h.name : null,
    description: typeof h?.description === "string" ? h.description : null,
  }));
}
