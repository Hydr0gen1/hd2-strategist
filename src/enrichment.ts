/**
 * Stage 1 + Stage 2 enrichment: lean fact pass-throughs from fetched
 * payloads. Pure — zero I/O; the handler layer (tools.ts) feeds in raw
 * objects and the clock. Every field is either raw upstream data or a
 * deterministic unit conversion — never a judgment.
 */
import type {
  GlobalSample,
  HealthSample,
  ObservedSignature,
} from "./sampling";
import type {
  BiomeInfo,
  DefenseTiming,
  DispatchInfo,
  EventModifier,
  FactionRollup,
  FrontRateAggregate,
  GlobalHistoryPoint,
  HazardInfo,
  HistoryRateAggregates,
  NeighborInfo,
  NeighborSummary,
  ObservedSignatureInfo,
  PatchNoteInfo,
  PlanetHistoryPoint,
  PlanetStatistics,
  RawAssignment,
  RawBiome,
  RawDispatch,
  RawEvent,
  RawHazard,
  RawPlanet,
  RawStatistics,
  RawSteamNews,
  SectorRollup,
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

/**
 * Stage 4: confirmed `event.eventType` → special-faction/modifier name map.
 *
 * Tunable like HPC_CAMPAIGN_TYPES, but with the OPPOSITE fail-safe: there,
 * over-inclusion was safe; here a wrong entry FABRICATES a name, so nothing
 * is seeded until a live event confirms its enum value. Upstream documents
 * no enum (the community OpenAPI spec describes eventType only as "the type
 * of event"), and the war state at implementation time had zero active
 * events, so no value could be verified live.
 *
 * Candidates awaiting a live (eventType → name) confirmation: "Jet Brigade",
 * "Predator Strain", "Incineration Corps", "The Great Host". Caution when
 * confirming: eventType 1 has historically been the PLAIN defense event —
 * do not map it to a subfaction name.
 */
export const EVENT_MODIFIER_NAMES: ReadonlyMap<number, string> = new Map<
  number,
  string
>([]);

/**
 * Stage 4: live special-faction event decode — presence + name, nothing
 * else. `event_type` is the raw upstream enum passed through untouched
 * (never dropped); `modifier` is its decoded name ONLY when the value is in
 * the supplied map. No event → both null (not an error). Unmapped value →
 * event_type set, modifier null — visible as "something is here, name
 * unknown", never hidden, never guessed. Strictly factual: no difficulty,
 * no advice — that belongs to the wiki/conversation layer, and this decode
 * reads ONLY the live API's own event data, never the wiki.
 */
export function decodeEventModifier(
  event: RawEvent | null | undefined,
  names: ReadonlyMap<number, string> = EVENT_MODIFIER_NAMES,
): EventModifier {
  const eventType = event ? finiteOrNull(event.eventType) : null;
  return {
    event_type: eventType,
    modifier: eventType != null ? (names.get(eventType) ?? null) : null,
  };
}

/** Upstream assignment task valueType that denotes a planet index. */
export const TASK_VALUE_TYPE_PLANET = 12;

/**
 * Stage 5: planet index → Major Order assignment id, from the same
 * tasks/valueTypes/values walk the MO planet set has always used. The
 * invariant-5 set is derived from this map's keys (new Set(map.keys())), so
 * HPC membership is identical by construction. When a planet appears in
 * several assignments, the FIRST one in upstream array order wins —
 * deterministic, no priority judgment.
 */
export function moPlanetAssignmentMap(
  assignments: RawAssignment[],
): ReadonlyMap<number, number> {
  const map = new Map<number, number>();
  for (const assignment of assignments) {
    for (const task of assignment.tasks ?? []) {
      const types = task.valueTypes ?? [];
      const values = task.values ?? [];
      for (let i = 0; i < types.length; i++) {
        if (types[i] === TASK_VALUE_TYPE_PLANET && values[i] != null) {
          if (!map.has(values[i]!)) map.set(values[i]!, assignment.id);
        }
      }
    }
  }
  return map;
}

/**
 * Stage 5, Part B: a planet's waypoint neighbors joined against the full
 * planets list and the active campaign set. Strictly factual adjacency:
 *
 * - `neighbors` is upstream's own `waypoints` array in upstream order —
 *   never symmetrized, rerouted, or sorted; direction semantics are
 *   upstream's. A dangling index (no matching planet) still counts in
 *   `total`, with name/owner null and its owner tallied under `unknown`.
 * - `frontline` is a deterministic adjacency fact: true iff at least one
 *   neighbor has a KNOWN owner different from this planet's currentOwner
 *   ("borders territory of a different owner" — nothing more). Unknown
 *   owners never make a planet frontline.
 * - Owner strings are verbatim upstream values — no case-conversion.
 */
export function buildNeighbors(
  planet: RawPlanet,
  planetByIndex: ReadonlyMap<number, RawPlanet>,
  campaignKindByPlanetIndex: ReadonlyMap<number, "liberation" | "defense">,
): {
  neighbors: NeighborInfo[];
  neighbor_summary: NeighborSummary;
  frontline: boolean;
} {
  const waypoints = Array.isArray(planet.waypoints) ? planet.waypoints : [];
  const byOwner: Record<string, number> = {};
  let unknown = 0;
  let withCampaign = 0;
  let frontline = false;

  const neighbors = waypoints.map((index): NeighborInfo => {
    const neighbor = planetByIndex.get(index);
    const kind = campaignKindByPlanetIndex.get(index) ?? null;
    const owner =
      typeof neighbor?.currentOwner === "string"
        ? neighbor.currentOwner
        : null;
    if (owner == null) {
      unknown += 1;
    } else {
      byOwner[owner] = (byOwner[owner] ?? 0) + 1;
      if (owner !== planet.currentOwner) frontline = true;
    }
    if (kind != null) withCampaign += 1;
    return {
      index,
      name: typeof neighbor?.name === "string" ? neighbor.name : null,
      owner,
      has_active_campaign: kind != null,
      campaign_kind: kind,
    };
  });

  const sortedByOwner: Record<string, number> = {};
  for (const key of Object.keys(byOwner).sort()) {
    sortedByOwner[key] = byOwner[key]!;
  }
  sortedByOwner.unknown = unknown;

  return {
    neighbors,
    neighbor_summary: {
      total: neighbors.length,
      by_owner: sortedByOwner,
      with_active_campaign: withCampaign,
    },
    frontline,
  };
}

/**
 * Stage 5, Part C: observed-only aggregates over a retained sample series.
 * Per-interval rates use the hp_per_hour sign convention defined in
 * client.ts — (previous.health − current.health) / hoursElapsed, positive =
 * progressing — so the aggregates are directly comparable to the live rate.
 * rate_mean is the UNWEIGHTED arithmetic mean of the per-interval rates,
 * NOT total change ÷ total time (stated in the tool notes so it can't be
 * misread as a forecast basis). Pairs with a non-positive time delta
 * (possible in coerced legacy stores) are skipped, never divided. Fewer
 * than one usable pair → all rate fields null; fewer than two samples →
 * samples_span_hours null. Plain stats over observed data — no smoothing,
 * no regression, no trend label, no projection.
 */
export function historyRateAggregates(
  samples: HealthSample[],
): HistoryRateAggregates {
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    const hours = (cur.t - prev.t) / MS_PER_HOUR;
    if (hours > 0) rates.push((prev.h - cur.h) / hours);
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    rate_min: rates.length > 0 ? Math.min(...rates) : null,
    rate_max: rates.length > 0 ? Math.max(...rates) : null,
    rate_mean:
      rates.length > 0
        ? rates.reduce((sum, r) => sum + r, 0) / rates.length
        : null,
    latest_rate: rates.length > 0 ? rates[rates.length - 1]! : null,
    samples_span_hours:
      first && last && samples.length >= 2
        ? (last.t - first.t) / MS_PER_HOUR
        : null,
  };
}

/**
 * Stage 5, Part E: observed history points from the retained global
 * statistics series (oldest → newest). Each point after the first carries
 * raw deltas from its predecessor; a delta is null when either end is null
 * (a missing upstream field is never treated as 0). Negative deltas (e.g.
 * an upstream counter reset) are passed through as observed. Deterministic
 * differences only — no smoothing, no forecast, no trend label.
 */
export function buildGlobalHistoryPoints(
  samples: GlobalSample[],
): GlobalHistoryPoint[] {
  const delta = (
    cur: number | null,
    prev: number | null | undefined,
  ): number | null => (cur != null && prev != null ? cur - prev : null);
  return samples.map((s, i) => {
    const prev = i > 0 ? samples[i - 1] : undefined;
    return {
      t: s.t,
      observed_at: new Date(s.t).toISOString(),
      player_count: s.player_count,
      missions_won: s.missions_won,
      missions_lost: s.missions_lost,
      deaths: s.deaths,
      terminid_kills: s.terminid_kills,
      automaton_kills: s.automaton_kills,
      illuminate_kills: s.illuminate_kills,
      delta_hours: prev ? (s.t - prev.t) / MS_PER_HOUR : null,
      delta_player_count: delta(s.player_count, prev?.player_count),
      delta_missions_won: delta(s.missions_won, prev?.missions_won),
      delta_missions_lost: delta(s.missions_lost, prev?.missions_lost),
      delta_deaths: delta(s.deaths, prev?.deaths),
      delta_terminid_kills: delta(s.terminid_kills, prev?.terminid_kills),
      delta_automaton_kills: delta(s.automaton_kills, prev?.automaton_kills),
      delta_illuminate_kills: delta(
        s.illuminate_kills,
        prev?.illuminate_kills,
      ),
    };
  });
}

/**
 * Stage 5, Part A: shape the accumulated signature record for the tool
 * payload — newest last_seen first (tiebreak: newest first_seen), with ISO
 * renderings of both timestamps. Read-only pass-through, no interpretation.
 */
export function shapeObservedSignatures(
  signatures: ObservedSignature[],
): ObservedSignatureInfo[] {
  return [...signatures]
    .sort((a, b) => b.last_seen - a.last_seen || b.first_seen - a.first_seen)
    .map((s) => ({
      campaign_type: s.campaign_type,
      event_type: s.event_type,
      has_event: s.has_event,
      faction: s.faction,
      first_seen: s.first_seen,
      last_seen: s.last_seen,
      sample_count: s.sample_count,
      first_seen_at: new Date(s.first_seen).toISOString(),
      last_seen_at: new Date(s.last_seen).toISOString(),
    }));
}

/**
 * Stage 5, Part F: per-faction deterministic rollup. Counts and sums over
 * data already fetched, never a verdict:
 *
 * - the faction universe is every owner seen in the planets list plus every
 *   campaign faction (keys sorted) — "Humans" naturally appears with owned
 *   planets and, normally, zero campaigns against themselves.
 * - net_hp_per_hour is ECHOED from the already-computed Stage 3 front
 *   aggregates (one signed source of truth) — never recomputed here. A
 *   faction with no active front reports null.
 * - total_players_on_front sums the known per-campaign player counts on
 *   that faction's front; null when none are known (never a fake 0), with
 *   campaigns_with_players/campaigns_total stating the coverage — the same
 *   null-honesty as aggregateFrontRate.
 */
export function buildFactionRollup(
  planets: RawPlanet[],
  campaigns: ReadonlyArray<{
    faction: string;
    statistics: PlanetStatistics | null;
  }>,
  netRateByFaction: ReadonlyMap<string, number | null>,
): Record<string, FactionRollup> {
  const factions = new Set<string>();
  const ownedCounts = new Map<string, number>();
  for (const p of planets) {
    if (typeof p.currentOwner !== "string") continue;
    factions.add(p.currentOwner);
    ownedCounts.set(p.currentOwner, (ownedCounts.get(p.currentOwner) ?? 0) + 1);
  }
  for (const c of campaigns) factions.add(c.faction);

  const rollup: Record<string, FactionRollup> = {};
  for (const faction of [...factions].sort()) {
    const front = campaigns.filter((c) => c.faction === faction);
    let playerSum = 0;
    let withPlayers = 0;
    for (const c of front) {
      const players = c.statistics?.player_count;
      if (typeof players === "number" && Number.isFinite(players)) {
        playerSum += players;
        withPlayers += 1;
      }
    }
    rollup[faction] = {
      planets_owned: ownedCounts.get(faction) ?? 0,
      active_campaigns: front.length,
      net_hp_per_hour: netRateByFaction.get(faction) ?? null,
      total_players_on_front: withPlayers > 0 ? playerSum : null,
      campaigns_with_players: withPlayers,
      campaigns_total: front.length,
    };
  }
  return rollup;
}

/**
 * Stage 5, Part F: per-sector deterministic rollup over the full planets
 * list — planet count, owner tallies (verbatim upstream strings), and the
 * number of active campaigns whose planet lies in the sector. Keys sorted
 * for a stable payload. Counts only, no interpretation.
 */
export function buildSectorRollup(
  planets: RawPlanet[],
  campaigns: ReadonlyArray<{ planet_index: number }>,
): Record<string, SectorRollup> {
  const campaignPlanets = new Set(campaigns.map((c) => c.planet_index));
  const bySector = new Map<
    string,
    { planet_count: number; owners: Record<string, number>; active: number }
  >();
  for (const p of planets) {
    const sector = typeof p.sector === "string" ? p.sector : "unknown";
    const entry =
      bySector.get(sector) ?? { planet_count: 0, owners: {}, active: 0 };
    entry.planet_count += 1;
    const owner = typeof p.currentOwner === "string" ? p.currentOwner : "unknown";
    entry.owners[owner] = (entry.owners[owner] ?? 0) + 1;
    if (campaignPlanets.has(p.index)) entry.active += 1;
    bySector.set(sector, entry);
  }

  const rollup: Record<string, SectorRollup> = {};
  for (const sector of [...bySector.keys()].sort()) {
    const entry = bySector.get(sector)!;
    const owners: Record<string, number> = {};
    for (const key of Object.keys(entry.owners).sort()) {
      owners[key] = entry.owners[key]!;
    }
    rollup[sector] = {
      planet_count: entry.planet_count,
      owners,
      active_campaigns: entry.active,
    };
  }
  return rollup;
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
