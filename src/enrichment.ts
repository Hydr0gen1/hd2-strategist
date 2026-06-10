/**
 * Stage 1 enrichment: lean fact pass-throughs from data already present in
 * fetched planet payloads. Pure — zero I/O; the handler layer (tools.ts)
 * feeds in raw objects and the clock. Every field is either raw upstream
 * data or a deterministic unit conversion — never a judgment.
 */
import type {
  BiomeInfo,
  DefenseTiming,
  HazardInfo,
  PlanetStatistics,
  RawBiome,
  RawEvent,
  RawHazard,
  RawStatistics,
} from "./types";

const MS_PER_HOUR = 3_600_000;

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
