/** Raw upstream types (api.helldivers2.dev, v1) — only the fields we consume. */

export interface RawStatistics {
  missionsWon: number;
  missionsLost: number;
  missionSuccessRate: number;
  terminidKills: number;
  automatonKills: number;
  illuminateKills: number;
  deaths: number;
  playerCount: number;
  accuracy: number;
}

export interface RawBiome {
  name?: string | null;
  description?: string | null;
}

export interface RawHazard {
  name?: string | null;
  description?: string | null;
}

export interface RawEvent {
  id: number;
  eventType: number;
  faction: string;
  health: number;
  maxHealth: number;
  startTime: string;
  endTime: string;
  campaignId: number;
}

export interface RawPlanet {
  index: number;
  name: string;
  sector: string;
  maxHealth: number;
  health: number;
  disabled: boolean;
  initialOwner: string;
  currentOwner: string;
  regenPerSecond: number;
  event: RawEvent | null;
  attacking: number[];
  waypoints: number[];
  statistics?: RawStatistics | null;
  biome?: RawBiome | null;
  hazards?: RawHazard[] | null;
}

export interface RawCampaign {
  id: number;
  planet: RawPlanet;
  type: number;
  count: number;
  faction: string;
}

export interface RawWar {
  started: string;
  ended: string;
  now: string;
  clientVersion: string;
  factions: string[];
  impactMultiplier: number;
  statistics: RawStatistics;
}

export interface RawAssignmentTask {
  type: number;
  values: number[];
  valueTypes: number[];
}

export interface RawAssignment {
  id: number;
  progress: number[];
  title: string | null;
  briefing: string | null;
  description: string | null;
  tasks: RawAssignmentTask[];
  reward: { type: number; amount: number } | null;
  rewards: { type: number; amount: number }[];
  expiration: string;
  flags: number;
}

/** In-fiction war news entry from /api/v1/dispatches. */
export interface RawDispatch {
  id: number;
  published: string;
  type: number;
  message: string;
}

/** Steam community announcement / patch note from /api/v1/steam. */
export interface RawSteamNews {
  id: string;
  title: string;
  url: string;
  author: string;
  content: string;
  publishedAt: string;
}

/** Normalized output types (what the MCP tools return). */

export type Direction = "liberating" | "losing" | "stalemate" | "unknown";
export type ProjectionStatus =
  | "projected"
  | "stalemate"
  | "insufficient_data"
  | "data_error";

export interface Projection {
  hours_to_resolution: number | null;
  status: ProjectionStatus;
}

export interface TrajectorySignal {
  direction: Direction;
  /** Only ever "collapse" or null; invariants 4 and 5 may suppress it. */
  alert: "collapse" | null;
  stabilizing: boolean;
  hpc: boolean;
  hpc_note?: string;
}

export interface NormalizedCampaign extends TrajectorySignal, Projection {
  campaign_id: number;
  planet_name: string;
  planet_index: number;
  faction: string;
  campaign_type: number;
  campaign_kind: "liberation" | "defense";
  raw_hp: number | null;
  max_hp: number | null;
  hp_per_hour: number | null;
  /** Invariant 1: always null for defense campaigns. */
  regen_per_second: number | null;
  /** Invariant 2: cosmetic only — never used in any math. */
  liberation_pct_display_only: number | null;
  data_quality?: "degraded";
}

/** Lean named subset of the upstream per-planet statistics block. */
export interface PlanetStatistics {
  player_count: number | null;
  mission_wins: number | null;
  mission_losses: number | null;
  /** Derived: wins / (wins + losses) × 100; null when zero missions. */
  mission_success_rate: number | null;
  kills: {
    terminid: number | null;
    automaton: number | null;
    illuminate: number | null;
  };
}

export interface BiomeInfo {
  name: string | null;
  description: string | null;
}

export interface HazardInfo {
  name: string | null;
  description: string | null;
}

/** Defense deadline facts — emitted only when a defense event is active. */
export interface DefenseTiming {
  defense_started_at: string | null;
  defense_ends_at: string | null;
  defense_hours_remaining: number | null;
  defense_expired: boolean | null;
}

/** NormalizedCampaign plus the additive Stage 1 fact pass-throughs. */
export interface EnrichedCampaign
  extends NormalizedCampaign,
    Partial<DefenseTiming> {
  statistics: PlanetStatistics | null;
  biome: BiomeInfo | null;
  hazards: HazardInfo[];
  /** Stage 3: regen_per_second × 3600 — derived from the invariant-1
   * normalized regen, so it is always null for defense campaigns. */
  decay_per_hour: number | null;
}

/** Stage 3: per-front sum of the signed per-campaign hp_per_hour values —
 * a bare sum plus coverage counts, never a verdict. Null rates (stabilizing
 * planets) are excluded from the sum, never coerced to 0; a front with no
 * known rates reports null, never a fake 0. */
export interface FrontRateAggregate {
  net_hp_per_hour: number | null;
  planets_with_rate: number;
  planets_total: number;
}

/** One dispatch as returned by get_dispatches — upstream facts, untouched. */
export interface DispatchInfo {
  id: number;
  published: string;
  type: number;
  message: string;
}

/** One patch note as returned by get_patch_notes. `content` is raw Steam
 * BBCode exactly as published — rendering is the consumer's job. */
export interface PatchNoteInfo {
  id: string;
  title: string;
  author: string;
  published: string;
  url: string;
  content: string;
}

/** One observed point in a planet's health series. Deltas are raw observed
 * differences from the prior point — never a projection or trend. */
export interface PlanetHistoryPoint {
  health: number;
  /** Worker-clock ms epoch, exactly as sampled. */
  t: number;
  /** ISO rendering of `t` — a unit conversion, same instant. */
  observed_at: string;
  /** current − previous health; null on the first point. */
  delta_health: number | null;
  /** hours since the previous point; null on the first point. */
  delta_hours: number | null;
}

/** Context passed into pure normalization — assembled by the handler layer. */
export interface NormalizeContext {
  hpPerHour: number | null;
  campaignAgeMs: number | null;
  hpcTypes: ReadonlySet<number>;
  moPlanetIndices: ReadonlySet<number>;
}

/** Worker environment bindings. */
export interface Env {
  WAR_CACHE?: KVNamespace;
  SUPER_CLIENT?: string;
  SUPER_CONTACT?: string;
}
