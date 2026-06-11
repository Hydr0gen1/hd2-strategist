/**
 * Stage 1 + Stage 2 enrichment: lean fact pass-throughs from fetched
 * payloads. Pure — zero I/O; the handler layer (tools.ts) feeds in raw
 * objects and the clock. Every field is either raw upstream data or a
 * deterministic unit conversion — never a judgment.
 */
import type {
  GlobalSample,
  HealthSample,
  MoObjectiveSeries,
  MoProgressObservation,
  ObservedSignature,
} from "./sampling";
import type {
  BiomeInfo,
  CampaignFilters,
  DefenseTiming,
  DefenseWindowProjection,
  Direction,
  DispatchInfo,
  EnrichedCampaign,
  EventModifier,
  FactionRollup,
  FreshnessMeta,
  FrontRateAggregate,
  GlobalHistoryPoint,
  HazardInfo,
  HistoryRateAggregates,
  MoHistorySeries,
  NeighborInfo,
  NeighborSummary,
  ObservedSignatureInfo,
  PatchNoteInfo,
  PlanetCandidate,
  PlanetHistoryPoint,
  PlanetResolution,
  PlanetStatistics,
  RawAssignment,
  RawAssignmentTask,
  RawBiome,
  RawDispatch,
  RawEvent,
  RawHazard,
  RawPlanet,
  RawStatistics,
  RawSteamNews,
  SectorRollup,
  WarBriefEvent,
  WarBriefTarget,
  WinCondition,
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
      defense_seconds_remaining: null,
      defense_time_remaining: null,
      defense_expired: null,
    };
  }
  const hoursRemaining = (endMs - nowMs) / MS_PER_HOUR;
  // Stage 6, Part F: the SAME clamped remaining span in three unit
  // renderings (hours / whole seconds / humanized) — additive aliases, the
  // hours value is untouched.
  const secondsRemaining = Math.max(0, Math.floor((endMs - nowMs) / 1000));
  return {
    defense_started_at: startedAt,
    defense_ends_at: endsAt,
    defense_hours_remaining: Math.max(0, hoursRemaining),
    defense_seconds_remaining: secondsRemaining,
    defense_time_remaining: humanizeSeconds(secondsRemaining),
    defense_expired: hoursRemaining <= 0,
  };
}

/** Humanized rendering of a second count ("1d 4h 12m") — a display alias
 * always paired with the raw seconds field, never a replacement for it. */
export function humanizeSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
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

/** Stage 7, Part D: upstream assignment task valueType that denotes the
 * objective's goal quantity (the progress denominator). Confirmed against
 * both live Major Orders on 2026-06-11: MO 2616794736 carried 1,750,000 in
 * its valueType-3 slot with progress 281,226 counting toward it (~16%), and
 * MO 3257352995 ("Hold Crimsica") carried goal 1 with progress 1 while the
 * planet was held. */
export const TASK_VALUE_TYPE_GOAL = 3;

/**
 * Stage 7, Part D (extracted for Stage 8 reuse): the objective's goal
 * quantity — the value in the first valueType-3 slot of the task's
 * positional arrays. This is the ONE decode of the goal slot in the server;
 * shapeMajorOrders (get_major_order / get_war_brief) and the Stage 8 MO
 * progress sampler both call it, so the sampled `target` is by construction
 * the same value the live MO payload shows. No goal slot / non-finite value
 * → null, never fabricated.
 */
export function decodeObjectiveTarget(task: RawAssignmentTask): number | null {
  const types = task.valueTypes ?? [];
  const values = task.values ?? [];
  const goalSlot = types.findIndex((vt) => vt === TASK_VALUE_TYPE_GOAL);
  return goalSlot >= 0 ? finiteOrNull(values[goalSlot]) : null;
}

/**
 * Stage 7, Part D (extracted for Stage 8 reuse): progress / target × 100,
 * two decimals. Deterministic and divide-by-zero guarded: target 0, missing
 * target, or missing progress → null — never a fabricated denominator.
 */
export function objectiveProgressPct(
  progress: number | null,
  target: number | null,
): number | null {
  return target != null && target > 0 && progress != null
    ? Math.round((progress / target) * 10_000) / 100
    : null;
}

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

/* ----------------------------- Stage 6 -------------------------------- */

/**
 * Stage 6, Part A: shaped Major Order list — the exact field set
 * get_major_order has always returned, extracted pure so the war brief can
 * reuse it instead of reimplementing MO logic. Time remaining is stated in
 * both raw seconds and humanized form (Part F convention).
 */
export function shapeMajorOrders(assignments: RawAssignment[], nowMs: number) {
  return assignments.map((a) => {
    const expiresInSeconds = Math.max(
      0,
      Math.floor((Date.parse(a.expiration) - nowMs) / 1000),
    );
    return {
      id: a.id,
      title: a.title,
      briefing: a.briefing,
      description: a.description,
      objectives: (a.tasks ?? []).map((task, i) => {
        const types = task.valueTypes ?? [];
        const values = task.values ?? [];
        // Stage 7, Part D: decode the positional arrays into named fields —
        // additive beside the raw arrays, which stay authoritative. Unknown
        // enum values keep their raw number with a null label (the
        // EVENT_MODIFIER_NAMES fail-safe: never fabricate a name). The
        // goal/pct decode is shared with the Stage 8 progress sampler —
        // one source of truth (decodeObjectiveTarget / objectiveProgressPct).
        const target = decodeObjectiveTarget(task);
        const progress = a.progress?.[i] ?? null;
        return {
          index: i,
          task_type: task.type,
          objective_kind: TASK_TYPE_NAMES.get(task.type) ?? null,
          progress,
          target,
          progress_pct: objectiveProgressPct(progress, target),
          values: task.values,
          value_types: task.valueTypes,
          value_labels: types.map(
            (vt) => TASK_VALUE_TYPE_NAMES.get(vt) ?? null,
          ),
          planet_indices: types.flatMap((vt, j) =>
            vt === TASK_VALUE_TYPE_PLANET && values[j] != null
              ? [values[j]!]
              : [],
          ),
        };
      }),
      rewards: a.rewards?.length ? a.rewards : a.reward ? [a.reward] : [],
      expires_in_seconds: expiresInSeconds,
      expires_in: humanizeSeconds(expiresInSeconds),
      expiration: a.expiration,
    };
  });
}

/**
 * Stage 6, Parts D+E: freshness metadata from the cache records' stored
 * retrieval timestamps. When several upstream endpoints contribute to one
 * response, the OLDEST timestamp governs (the most conservative honest
 * claim about how current the assembled snapshot is). `as_of` and
 * `fetched_at` coincide by construction in this architecture — the upstream
 * serves live state at request time and its own war `now` is game-epoch
 * (not a usable real-world timestamp; see ROADMAP) — but they remain
 * separate fields because they answer different questions: when the
 * snapshot is FROM vs when this server RETRIEVED it.
 */
export function freshnessFrom(
  fetchedAts: ReadonlyArray<number>,
  nowMs: number,
): FreshnessMeta {
  const valid = fetchedAts.filter((t) => Number.isFinite(t));
  if (valid.length === 0) {
    return { as_of: null, fetched_at: null, cache_age_seconds: null };
  }
  const oldest = Math.min(...valid);
  const iso = new Date(oldest).toISOString();
  return {
    as_of: iso,
    fetched_at: iso,
    cache_age_seconds: Math.max(0, Math.round((nowMs - oldest) / 1000)),
  };
}

/** Shared note text for the freshness metadata — stated once, spread into
 * each tool's notes so the semantics travel with the fields. */
export const FRESHNESS_NOTE =
  "as_of = the moment the war state in this response reflects; fetched_at = when this server retrieved the underlying upstream payload (oldest contributing endpoint when several are joined); cache_age_seconds = now − fetched_at. The upstream serves live state at request time and its own war `now` field is game-epoch time (not a comparable real-world timestamp), so as_of and fetched_at coincide here by construction — they remain separate fields because they answer different questions. stale: true additionally marks an expired-cache fallback after an upstream failure.";

/** Lowercased, punctuation/space-stripped form used for name matching only —
 * never emitted; output names stay verbatim upstream casing. */
function normalizeQueryName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Plain Levenshtein edit distance — O(len a × len b), tiny inputs. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Fuzzy candidates are capped so a wild query can't return the galaxy. */
export const RESOLVE_MAX_CANDIDATES = 5;
/** Fuzzy threshold: normalized edit distance ≤ 2, or a prefix of length ≥ 3. */
export const RESOLVE_MAX_DISTANCE = 2;

/**
 * Stage 6, Part C: resolve a loose planet query to the canonical upstream
 * planet. Resolution order: exact case-insensitive match, then
 * punctuation/space-normalized match (still the same name — never a
 * substitution), then fuzzy (edit distance ≤ RESOLVE_MAX_DISTANCE on the
 * normalized forms, or a ≥3-char normalized prefix). Fuzzy NEVER auto-
 * matches: a near-miss returns ranked candidates (`score` = edit distance,
 * lower is closer) with matched: false, and so does any tie — the consumer
 * disambiguates; the server never guesses. Returned names are verbatim
 * upstream casing.
 */
export function resolvePlanetName(
  query: string,
  planets: ReadonlyArray<{ index: number; name: string }>,
): PlanetResolution {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      matched: false,
      candidates: [],
      hint: "Empty query — provide a planet name (e.g. \"Gacrux\").",
    };
  }

  const lower = trimmed.toLowerCase();
  const exact = planets.filter((p) => p.name.toLowerCase() === lower);
  if (exact.length === 1) {
    const p = exact[0]!;
    return { matched: true, planet: { index: p.index, name: p.name }, candidates: [] };
  }
  if (exact.length > 1) {
    return {
      matched: false,
      candidates: exact.map((p) => ({ index: p.index, name: p.name, score: 0 })),
      hint: "Multiple planets match this name exactly — disambiguate by index.",
    };
  }

  const qn = normalizeQueryName(trimmed);
  if (qn.length > 0) {
    const normalized = planets.filter((p) => normalizeQueryName(p.name) === qn);
    if (normalized.length === 1) {
      const p = normalized[0]!;
      return { matched: true, planet: { index: p.index, name: p.name }, candidates: [] };
    }
    if (normalized.length > 1) {
      return {
        matched: false,
        candidates: normalized.map((p) => ({
          index: p.index,
          name: p.name,
          score: 0,
        })),
        hint: "Multiple planets match after normalization — disambiguate by index.",
      };
    }
  }

  const scored: PlanetCandidate[] = [];
  for (const p of planets) {
    const pn = normalizeQueryName(p.name);
    const distance = levenshtein(qn, pn);
    const isPrefix = qn.length >= 3 && pn.startsWith(qn);
    if (distance <= RESOLVE_MAX_DISTANCE || isPrefix) {
      scored.push({ index: p.index, name: p.name, score: distance });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const candidates = scored.slice(0, RESOLVE_MAX_CANDIDATES);
  return {
    matched: false,
    candidates,
    hint:
      candidates.length > 0
        ? "No exact match. Ranked near-matches listed (score = edit distance, lower is closer) — pick one explicitly; this server never substitutes a planet."
        : "No planet name is close to this query. Check spelling, or list active planets via get_campaigns.",
  };
}

/**
 * Stage 6, Part B: AND-combined filters over the ALREADY-normalized campaign
 * list — filtering only narrows the returned array; every invariant ran
 * identically before this is called. An unset (or false) flag filters
 * nothing, so the no-args call is byte-identical to the unfiltered list.
 * Faction comparison is case-insensitive on the INPUT only; output strings
 * stay verbatim upstream.
 */
export function filterCampaigns(
  campaigns: ReadonlyArray<EnrichedCampaign>,
  filters: CampaignFilters,
): EnrichedCampaign[] {
  const faction = filters.faction?.trim().toLowerCase();
  return campaigns.filter(
    (c) =>
      (!faction || c.faction.toLowerCase() === faction) &&
      (!filters.major_order_only || c.is_major_order_target) &&
      (!filters.has_rate || c.hp_per_hour != null) &&
      (!filters.hpc_only || c.hpc),
  );
}

/**
 * Stage 6, Part A: the MO ↔ live-trajectory join — for each Major Order
 * target planet index, the live state of exactly that planet, echoed from
 * the already-normalized campaign when one is active. A target with NO
 * active campaign is still included (never dropped) with the planet's
 * static state and has_active_campaign: false; the campaign-derived fields
 * (hp_per_hour, stabilizing, hpc, decay) are null there — unknowns, never
 * fabricated. Pure assembly of existing facts; no ordering by desirability
 * (indices keep the MO map's upstream order).
 */
export function buildMajorOrderTargets(
  planetIndices: Iterable<number>,
  campaigns: ReadonlyArray<EnrichedCampaign>,
  planetByIndex: ReadonlyMap<number, RawPlanet>,
): WarBriefTarget[] {
  const campaignByPlanet = new Map(
    campaigns.map((c) => [c.planet_index, c] as const),
  );
  const targets: WarBriefTarget[] = [];
  for (const index of planetIndices) {
    const c = campaignByPlanet.get(index);
    if (c) {
      targets.push({
        index,
        name: c.planet_name,
        has_active_campaign: true,
        campaign_kind: c.campaign_kind,
        faction: c.faction,
        raw_hp: c.raw_hp,
        max_hp: c.max_hp,
        hp_per_hour: c.hp_per_hour,
        direction: c.direction,
        stabilizing: c.stabilizing,
        hpc: c.hpc,
        decay_per_hour: c.decay_per_hour,
        player_count: c.statistics?.player_count ?? null,
      });
      continue;
    }
    const planet = planetByIndex.get(index);
    targets.push({
      index,
      name: typeof planet?.name === "string" ? planet.name : null,
      has_active_campaign: false,
      campaign_kind: null,
      faction:
        typeof planet?.currentOwner === "string" ? planet.currentOwner : null,
      raw_hp: finiteOrNull(planet?.health),
      max_hp: finiteOrNull(planet?.maxHealth),
      hp_per_hour: null,
      direction: "unknown" satisfies Direction,
      stabilizing: null,
      hpc: null,
      decay_per_hour: null,
      player_count: finiteOrNull(planet?.statistics?.playerCount),
    });
  }
  return targets;
}

/**
 * Stage 6, Part A: campaigns with a live event surfaced at a glance —
 * presence + identity facts echoed verbatim from the normalized campaigns.
 * Empty array when no events are live (the current norm), never an error.
 */
export function buildActiveEvents(
  campaigns: ReadonlyArray<EnrichedCampaign>,
): WarBriefEvent[] {
  return campaigns
    .filter((c) => c.event_type != null || c.modifier != null)
    .map((c) => ({
      planet_index: c.planet_index,
      planet_name: c.planet_name,
      faction: c.faction,
      campaign_kind: c.campaign_kind,
      event_type: c.event_type,
      modifier: c.modifier,
      defense_ends_at: c.defense_ends_at ?? null,
      defense_hours_remaining: c.defense_hours_remaining ?? null,
    }));
}

/* ----------------------------- Stage 7 -------------------------------- */

/**
 * Stage 7, Part A: the explicit win-state orientation for a campaign kind.
 *
 * Verified against live data on 2026-06-11 — the type:0 lesson (never assume
 * an enum or orientation) applied to defense direction:
 *
 * - liberation: planet.health counts DOWN; zero = liberated (long-verified).
 * - defense: event.health ALSO counts DOWN under successful defense play —
 *   observed live on Crimsica (index 78, 16k+ players defending: event
 *   health fell 1,359,043 → 1,040,310 over 7.6h) and Bore Rock (index 124:
 *   746,788 → 728,250). Depleting the event health to zero IS repelling the
 *   attack; an event still near max_hp close to its deadline is nearly
 *   LOST, not nearly won.
 *
 * Both kinds therefore share "raw_hp_to_zero". The function stays kind-keyed
 * so a future kind with a different verified orientation gets its own enum
 * value instead of silently inheriting this one.
 */
export function winCondition(kind: "liberation" | "defense"): WinCondition {
  void kind; // both verified orientations coincide today — see above
  return "raw_hp_to_zero";
}

/**
 * Stage 7, Part A: distance to the win state, oriented so SMALLER = closer
 * to the desired outcome regardless of campaign kind. Because both kinds'
 * win state is the tracked health reaching zero (see winCondition), the
 * distance equals the raw/event health itself — restated under an
 * orientation-explicit name so the reader never has to know the sign
 * convention to read it. Always ≥ 0; null when HP is unknown, never
 * substituted.
 */
export function hpRemainingToObjective(rawHp: number | null): number | null {
  if (rawHp == null || !Number.isFinite(rawHp)) return null;
  return Math.max(0, rawHp);
}

/**
 * Stage 7, Part B: the defense timing-vs-trajectory gap, co-located as
 * numbers. Deterministic arithmetic over fields the payload already carries
 * — NOT a success/failure prediction:
 *
 * - projected_hp_at_defense_end: raw_hp − hp_per_hour ×
 *   defense_hours_remaining, a straight linear extrapolation of the one
 *   signed rate (positive depletes) to the defense deadline. ≤ 0 means the
 *   extrapolation reaches the win state inside the window; deliberately
 *   unclamped so the arithmetic stays verifiable against the inputs.
 * - resolution_within_defense_window: hours_to_resolution ≤
 *   defense_hours_remaining — a comparison of two numbers already returned
 *   side by side, nothing more.
 *
 * Both null when the rate is null (no projection possible — the same
 * honesty as hours_to_resolution); the boolean is also null on a stalemate
 * (rate 0), where no resolution projection exists to compare.
 */
export function defenseWindowProjection(args: {
  rawHp: number | null;
  hpPerHour: number | null;
  defenseHoursRemaining: number | null;
  hoursToResolution: number | null;
}): DefenseWindowProjection {
  const { rawHp, hpPerHour, defenseHoursRemaining, hoursToResolution } = args;
  const windowKnown =
    defenseHoursRemaining != null && Number.isFinite(defenseHoursRemaining);
  return {
    projected_hp_at_defense_end:
      rawHp != null &&
      Number.isFinite(rawHp) &&
      hpPerHour != null &&
      Number.isFinite(hpPerHour) &&
      windowKnown
        ? rawHp - hpPerHour * defenseHoursRemaining
        : null,
    resolution_within_defense_window:
      hoursToResolution != null &&
      Number.isFinite(hoursToResolution) &&
      windowKnown
        ? hoursToResolution <= defenseHoursRemaining
        : null,
  };
}

/**
 * Stage 7, Part D: assignment task `type` → readable objective kind.
 * Configurable map with the EVENT_MODIFIER_NAMES fail-safe: an unmapped
 * value keeps its raw number and gets a NULL label — a label is never
 * fabricated. Seeded ONLY with values confirmed against live Major Orders
 * (2026-06-11):
 *
 * - 9 → "complete_operations": MO 2616794736, briefing "Complete the
 *   required number of Operations on Omicron…", progress counting toward a
 *   1,750,000 goal.
 * - 13 → "hold_planet": MO 3257352995, briefing "Hold Crimsica…", goal 1
 *   with progress 1 while the planet was held.
 *
 * Candidates awaiting live confirmation (community readings, NOT seeded):
 * 2 extract, 3 eradicate, 11 liberate, 12 defend.
 */
export const TASK_TYPE_NAMES: ReadonlyMap<number, string> = new Map<
  number,
  string
>([
  [9, "complete_operations"],
  [13, "hold_planet"],
]);

/**
 * Stage 7, Part D: assignment task `valueTypes` entry → readable label.
 * Same fail-safe as TASK_TYPE_NAMES — unknown values keep the raw number
 * with a null label. Seeded only with live-confirmed values:
 *
 * - 3 → "goal" (TASK_VALUE_TYPE_GOAL — see its confirmation note).
 * - 12 → "planet_index" (TASK_VALUE_TYPE_PLANET — drives the MO planet join
 *   and invariant 5; long-confirmed).
 *
 * Values 1, 8, 9, 11 have been observed live with plausible community
 * readings (e.g. 1 = faction id) but no payload-verifiable confirmation —
 * they stay unmapped.
 */
export const TASK_VALUE_TYPE_NAMES: ReadonlyMap<number, string> = new Map<
  number,
  string
>([
  [TASK_VALUE_TYPE_GOAL, "goal"],
  [TASK_VALUE_TYPE_PLANET, "planet_index"],
]);

/** Stage 7, Part A: the hp_per_hour sign convention, restated inline on
 * every rate-bearing payload (the history tool's notes proved inline
 * self-documentation is what makes the correct read possible). */
export const RATE_SIGN_NOTE =
  "hp_per_hour = (previous − current) health / hours elapsed, sampled by this server. Positive = health falling toward zero = progressing toward this campaign's win state; negative = health rising = losing ground. The SAME orientation holds for liberation AND defense campaigns — a successful defense depletes the event health to zero (verified against live defenses 2026-06-11); win_condition / hp_remaining_to_objective state the target explicitly. Null until two samples >60s apart exist.";

/** Stage 7, Part A: direction label semantics — kind-aware since 2026-06-11. */
export const DIRECTION_NOTE =
  "Objective-relative rendering of the hp_per_hour sign: 'liberating' (liberation campaign) or 'repelling' (defense campaign) = positive rate, progressing toward the win state; 'losing' = negative rate, for both kinds; 'stalemate' = exactly 0; 'unknown' = no rate. Defenses previously reported 'liberating' on a positive rate, which misread as nearly-won on a nearly-lost defense — the label is now kind-aware; liberation labels are unchanged.";

/** Stage 7, Part A: win_condition / hp_remaining_to_objective semantics. */
export const WIN_CONDITION_NOTE =
  "win_condition states what reaching the objective means for THIS campaign: raw_hp_to_zero = the tracked health (planet health on a liberation, event health on a defense) must reach ZERO. hp_remaining_to_objective is the distance to that win state, always oriented so smaller = closer to the desired outcome for both kinds (it equals raw_hp because health counts down; the field exists so no sign convention has to be known to read it). A defense still near max_hp as its window expires is therefore nearly LOST — orientation verified against live defenses, not assumed.";

/** Stage 7, Part C: the liberation-% formula, stated inline (invariant 2:
 * the value is cosmetic and never used in math — documentation only). */
export const LIBERATION_PCT_NOTE =
  "Cosmetic display value only: liberation_pct_display_only = (max_hp − raw_hp) / max_hp × 100. raw_hp is authoritative — all quantitative logic (rates, projections) uses raw_hp, never this field. On a defense it reads as the % of event health already depleted toward the win state, NOT how safe the planet is.";

/** Stage 7, Part B: the defense window projection fields, documented as the
 * deterministic comparisons they are — never a success/failure prediction. */
export const DEFENSE_WINDOW_NOTE =
  "Defense campaigns only. projected_hp_at_defense_end = raw_hp − hp_per_hour × defense_hours_remaining: a linear extrapolation of the current signed rate to the defense deadline (≤ 0 means the extrapolation reaches the win state inside the window; unclamped so the arithmetic is verifiable). resolution_within_defense_window = hours_to_resolution ≤ defense_hours_remaining: a deterministic comparison of two fields already in this payload — it co-locates the timing gap, it does NOT predict success or failure. Both null when no rate exists; the boolean is also null on a stalemate (no resolution projection to compare).";

/** Stage 7, Part D: the Major Order objective decode, documented inline. */
export const MO_OBJECTIVE_DECODE_NOTE =
  "Decoded named fields ride alongside the raw arrays, never replacing them: target = the value whose value_types entry is 3 ('goal'; first such slot), progress = upstream per-objective progress, progress_pct = progress / target × 100 (null when the target is 0 or unknown — never a divide-by-zero), objective_kind / value_labels = readable labels only for enum values confirmed against live Major Orders. An unknown enum value keeps its raw number with a null label — a name is never fabricated. The raw values / value_types arrays remain authoritative, so every decoded field is verifiable against them.";

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

/* ----------------------------- Stage 8 -------------------------------- */

/**
 * Stage 8: the current poll cycle's Major Order progress observations, one
 * per objective, from the SAME raw assignments every poll already fetches.
 * progress is upstream's per-objective progress entry and target is the
 * shared Stage 7 goal-slot decode (decodeObjectiveTarget) — never a second,
 * independent decode of the positional arrays. An assignment without a
 * finite id is skipped (no usable series identity); a missing progress or
 * goal slot is null in the observation, never fabricated.
 */
export function moProgressObservations(
  assignments: RawAssignment[],
): MoProgressObservation[] {
  const out: MoProgressObservation[] = [];
  for (const a of assignments) {
    if (typeof a.id !== "number" || !Number.isFinite(a.id)) continue;
    (a.tasks ?? []).forEach((task, i) => {
      out.push({
        majorOrderId: a.id,
        objectiveIndex: i,
        taskType: finiteOrNull(task.type),
        progress: finiteOrNull(a.progress?.[i]),
        target: decodeObjectiveTarget(task),
      });
    });
  }
  return out;
}

/**
 * Stage 8: shape one retained MO objective series for
 * get_major_order_history — observed points with raw consecutive deltas,
 * exactly the planet/global history pattern:
 *
 * - delta_progress = current − previous progress; null on the first point or
 *   when either end's progress is null (missing is never treated as 0).
 *   Negative deltas (an upstream progress reset) pass through as observed.
 * - latest_progress / target echo the NEWEST sample; progress_pct reuses the
 *   shared Stage 7 derivation (objectiveProgressPct — target 0/unknown →
 *   null, never a divide-by-zero).
 * - objective_kind decodes the stored raw task_type against TASK_TYPE_NAMES
 *   at READ time (a later-confirmed label applies retroactively); an
 *   unconfirmed type keeps its raw number with a null label.
 * - fewer than 2 points → insufficient_history: true, span/deltas null —
 *   the same honesty as the other history tools. No forecast, required
 *   pace, or on-track verdict exists anywhere in this shape, by design.
 */
export function buildMoHistorySeries(
  series: MoObjectiveSeries,
  names: ReadonlyMap<number, string> = TASK_TYPE_NAMES,
): MoHistorySeries {
  const samples = series.samples;
  const points = samples.map((s, i) => {
    const prev = i > 0 ? samples[i - 1] : undefined;
    return {
      t: s.t,
      observed_at: new Date(s.t).toISOString(),
      progress: s.progress,
      target: s.target,
      delta_progress:
        prev && s.progress != null && prev.progress != null
          ? s.progress - prev.progress
          : null,
      delta_hours: prev ? (s.t - prev.t) / MS_PER_HOUR : null,
    };
  });
  const first = samples[0];
  const last = samples[samples.length - 1];
  const insufficient = samples.length < 2;
  return {
    major_order_id: series.major_order_id,
    objective_index: series.objective_index,
    task_type: series.task_type,
    objective_kind:
      series.task_type != null ? (names.get(series.task_type) ?? null) : null,
    points: points.length,
    samples: points,
    latest_progress: last?.progress ?? null,
    target: last?.target ?? null,
    progress_pct: objectiveProgressPct(
      last?.progress ?? null,
      last?.target ?? null,
    ),
    samples_span_hours:
      !insufficient && first && last ? (last.t - first.t) / MS_PER_HOUR : null,
    insufficient_history: insufficient,
  };
}
