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
  waypoints?: number[];
  position?: { x: number; y: number };
  statistics?: RawStatistics;
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

/**
 * One supply-line link, enriched by a deterministic join against the full
 * planets list and the active-campaign set. Facts only — no routing,
 * reachability, or targeting judgment.
 */
export interface WaypointLink {
  index: number;
  /** Null when the waypoint index has no matching planet — never guessed. */
  name: string | null;
  owner: string | null;
  has_active_campaign: boolean;
  campaign_kind: "liberation" | "defense" | null;
}

/** Additive connectivity fields shared by get_planet/get_campaigns/get_supply_lines. */
export interface ConnectivityFields {
  /** Galactic-map coordinates; null when absent — NEVER {x:0,y:0} (a real origin). */
  position: { x: number; y: number } | null;
  /** Degree: raw waypoint count, dangling indices included. Pure count. */
  connection_count: number;
  waypoints: WaypointLink[];
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
