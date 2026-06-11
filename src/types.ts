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

/** Objective-relative rendering of the hp_per_hour sign, per campaign kind
 * (Stage 7). A positive rate (health falling toward zero — the win state for
 * BOTH kinds; see WinCondition) reads "liberating" on a liberation campaign
 * and "repelling" on a defense; a negative rate is "losing" for both.
 * Liberation labels are unchanged from the original enum; "repelling"
 * replaced "liberating" on defenses (2026-06-11) because a defense at high
 * event HP labeled "liberating" misread as nearly-won when it was nearly
 * lost (regression-tested in stage7.test.ts). */
export type Direction =
  | "liberating"
  | "repelling"
  | "losing"
  | "stalemate"
  | "unknown";

/** Stage 7, Part A: what reaching the objective means for a campaign.
 * Both current kinds deplete the tracked health to ZERO — for defenses this
 * was VERIFIED live (Crimsica index 78 / Bore Rock index 124, 2026-06-11:
 * event health observed falling under active defense play), never assumed.
 * An enum rather than a bare constant so a future campaign kind with a
 * different verified orientation gets its own value. */
export type WinCondition = "raw_hp_to_zero";

/** Stage 7, Part B: the defense timing-vs-trajectory gap as co-located
 * numbers — emitted only on defense campaigns. Deterministic arithmetic
 * over fields already in the payload (signed hp_per_hour,
 * defense_hours_remaining, hours_to_resolution), NOT a success/failure
 * prediction. Null when no rate exists — the same honesty as
 * hours_to_resolution itself. */
export interface DefenseWindowProjection {
  /** raw_hp − hp_per_hour × defense_hours_remaining: linear extrapolation of
   * the current signed rate to the defense deadline. ≤ 0 means the
   * extrapolation reaches the win state inside the window; deliberately
   * unclamped so the arithmetic stays verifiable. */
  projected_hp_at_defense_end: number | null;
  /** hours_to_resolution ≤ defense_hours_remaining — a comparison of two
   * fields already returned side by side, nothing more. Null when either
   * side is null (no rate, or stalemate). */
  resolution_within_defense_window: boolean | null;
}
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

/** Defense deadline facts — emitted only when a defense event is active.
 * Stage 6, Part F: seconds + human-readable aliases sit alongside the
 * original hours field (additive — same instant, three unit renderings). */
export interface DefenseTiming {
  defense_started_at: string | null;
  defense_ends_at: string | null;
  defense_hours_remaining: number | null;
  /** Same remaining span as defense_hours_remaining, in whole seconds. */
  defense_seconds_remaining: number | null;
  /** Same remaining span, humanized ("1d 4h 12m") — a rendering, not data. */
  defense_time_remaining: string | null;
  defense_expired: boolean | null;
}

/** Stage 4: live special-faction event identity — presence + name only.
 * Decoded EXCLUSIVELY from the live API's own `event.eventType`; the wiki
 * lore source is never consulted for these fields. */
export interface EventModifier {
  /** Raw upstream `event.eventType`, passed through untouched (never
   * dropped); null when the planet has no active event. */
  event_type: number | null;
  /** Decoded human-readable name (e.g. "Jet Brigade") ONLY when the enum
   * value is confirmed in EVENT_MODIFIER_NAMES. Null when there is no event
   * OR the value is unmapped — an unrecognized event stays visible via
   * event_type as "something is here, name unknown"; a name is never
   * fabricated. No difficulty/threat interpretation, ever. */
  modifier: string | null;
}

/** NormalizedCampaign plus the additive Stage 1 fact pass-throughs. */
export interface EnrichedCampaign
  extends NormalizedCampaign,
    Partial<DefenseTiming>,
    Partial<DefenseWindowProjection>,
    EventModifier {
  /** Stage 7, Part A: explicit win-state orientation for this campaign kind
   * — see WinCondition. */
  win_condition: WinCondition;
  /** Stage 7, Part A: distance to the win state, oriented so SMALLER =
   * closer to the desired outcome for BOTH kinds. Equals raw_hp (health
   * counts down to zero); the field exists so the reader never has to know
   * the sign convention. Null when HP is unknown. */
  hp_remaining_to_objective: number | null;
  statistics: PlanetStatistics | null;
  biome: BiomeInfo | null;
  hazards: HazardInfo[];
  /** Stage 3: regen_per_second × 3600 — derived from the invariant-1
   * normalized regen, so it is always null for defense campaigns. */
  decay_per_hour: number | null;
  /** Stage 5: pure join against the current Major Order task planet set —
   * the same set invariant 5 already consumes. A membership fact, not a
   * priority/importance score. */
  is_major_order_target: boolean;
  /** Stage 5: id of the first assignment whose task list names this planet
   * (upstream array order), null when the planet is in no MO task. */
  major_order_id: number | null;
  /** Stage 9: dual ETAs (instantaneous + historical) toward this campaign's
   * win state, with divergence. Liberation campaigns carry EtaBlock; defense
   * campaigns carry DefenseEtaBlock (competing depletion ETAs vs the
   * deadline — never a success prediction). Optional in the TYPE only so
   * pre-Stage-9 fixtures keep compiling; the campaign loader always emits
   * it. */
  eta?: EtaBlock | DefenseEtaBlock;
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

/** Stage 4: get_planet_wiki payload — LORE source (helldivers.wiki.gg),
 * physically separate from all live war-state output. Carries mandatory
 * attribution on every outcome and never any live war number. */
export interface WikiResult {
  found: boolean;
  /** What the caller asked for, verbatim (trimmed). */
  requested: string;
  /** The wiki page title served (or attempted, when found: false). */
  title: string;
  /** Plain-text lead extract, capped at WIKI_EXTRACT_MAX_CHARS. */
  extract: string | null;
  truncated: boolean;
  /** Canonical page URL — part of the mandatory attribution. */
  url: string | null;
  /** Original title when a MediaWiki redirect was followed — never silent. */
  redirected_from: string | null;
  source: string;
  license: string;
  license_url: string;
  retrieved_at: string;
  /** Lore disclaimer: community-authored; live tools are authoritative. */
  notes: string;
  hint?: string;
}

/** Context passed into pure normalization — assembled by the handler layer. */
export interface NormalizeContext {
  hpPerHour: number | null;
  campaignAgeMs: number | null;
  hpcTypes: ReadonlySet<number>;
  moPlanetIndices: ReadonlySet<number>;
}

/* --------------------------- Stage 5 outputs --------------------------- */

/** Stage 5: one waypoint neighbor of a planet, joined against the full
 * planets list and the active campaign set. Upstream's own `waypoints`
 * array, in upstream order — never symmetrized or rerouted. A dangling
 * index (no matching planet) keeps name/owner null rather than being
 * dropped. */
export interface NeighborInfo {
  index: number;
  name: string | null;
  owner: string | null;
  has_active_campaign: boolean;
  campaign_kind: "liberation" | "defense" | null;
}

/** Stage 5: deterministic counts over a planet's neighbors. `by_owner` keys
 * are the verbatim upstream owner strings (no case-conversion) plus an
 * always-present `unknown` bucket for dangling neighbors. */
export interface NeighborSummary {
  total: number;
  by_owner: Record<string, number>;
  with_active_campaign: number;
}

/** Stage 5: observed-only aggregates over a planet's retained sample series.
 * Per-interval rates use the hp_per_hour sign convention from client.ts:
 * (previous.health − current.health) / hoursElapsed, positive = progressing.
 * All null when fewer than two usable points exist — never fabricated. */
export interface HistoryRateAggregates {
  rate_min: number | null;
  rate_max: number | null;
  /** Unweighted arithmetic mean of the per-interval rates — NOT total
   * change ÷ total time. */
  rate_mean: number | null;
  latest_rate: number | null;
  samples_span_hours: number | null;
}

/** Stage 5: one observed point in the global war-statistics series, plus raw
 * deltas from the prior point. Values missing upstream are null, never 0;
 * deltas are null on the first point or when either end is null. */
export interface GlobalHistoryPoint {
  t: number;
  observed_at: string;
  player_count: number | null;
  missions_won: number | null;
  missions_lost: number | null;
  deaths: number | null;
  terminid_kills: number | null;
  automaton_kills: number | null;
  illuminate_kills: number | null;
  delta_hours: number | null;
  delta_player_count: number | null;
  delta_missions_won: number | null;
  delta_missions_lost: number | null;
  delta_deaths: number | null;
  delta_terminid_kills: number | null;
  delta_automaton_kills: number | null;
  delta_illuminate_kills: number | null;
}

/** Stage 5: one accumulated campaign-signature tuple as returned by
 * get_observed_signatures — the stored record plus ISO renderings. */
export interface ObservedSignatureInfo {
  campaign_type: number | null;
  event_type: number | null;
  has_event: boolean;
  faction: string | null;
  first_seen: number;
  last_seen: number;
  sample_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

/** Stage 5: per-faction deterministic rollup on get_war_status. Counts and
 * sums over data already fetched — never a verdict. `net_hp_per_hour` is the
 * SAME Stage-3 front aggregate echoed verbatim (never recomputed); a faction
 * with no active front reports null. `total_players_on_front` sums known
 * per-campaign player counts; null when none are known, with coverage
 * counts stating the gap. */
export interface FactionRollup {
  planets_owned: number;
  active_campaigns: number;
  net_hp_per_hour: number | null;
  total_players_on_front: number | null;
  campaigns_with_players: number;
  campaigns_total: number;
}

/** Stage 5: per-sector deterministic rollup on get_war_status. `owners` keys
 * are verbatim upstream owner strings. */
export interface SectorRollup {
  planet_count: number;
  owners: Record<string, number>;
  active_campaigns: number;
}

/* --------------------------- Stage 6 outputs --------------------------- */

/** Stage 6, Parts D+E: retrieval/freshness metadata on every response that
 * derives from an upstream fetch. Pure metadata — describes WHEN the data is
 * from, never what to think about it.
 *
 * `as_of` is the moment the war state in the response reflects; `fetched_at`
 * is when this server retrieved the underlying upstream payload (the cache
 * record's stored timestamp; the OLDEST contributing endpoint when several
 * are joined). The upstream API serves live state at request time and its
 * own war `now` field is game-epoch time (observed "1972-04-26T…", not a
 * comparable real-world timestamp — see ROADMAP), so the two coincide by
 * construction here; they stay separate fields because they answer different
 * questions (when the snapshot is FROM vs when WE fetched it). */
export interface FreshnessMeta {
  as_of: string | null;
  fetched_at: string | null;
  cache_age_seconds: number | null;
}

/** Stage 6, Part C: one ranked candidate from planet-name resolution.
 * `score` is the edit distance between the normalized query and the
 * normalized planet name — lower is closer; 0 = exact after normalization. */
export interface PlanetCandidate {
  index: number;
  name: string;
  score: number;
}

/** Stage 6, Part C: result of resolving a loose planet query. `matched` is
 * true only for an exact or punctuation/space-normalized exact match (the
 * same planet, never a substitution); any fuzzy near-miss or tie returns
 * ranked candidates with matched: false — the consumer disambiguates. */
export interface PlanetResolution {
  matched: boolean;
  planet?: { index: number; name: string };
  candidates: PlanetCandidate[];
  hint?: string;
}

/** Stage 6, Part B: optional get_campaigns filters. AND-combined; an unset
 * (or false) flag filters nothing, so no-args behavior is unchanged. */
export interface CampaignFilters {
  faction?: string;
  major_order_only?: boolean;
  has_rate?: boolean;
  hpc_only?: boolean;
}

/** Stage 6, Part A: one Major Order target planet in the war brief — the
 * MO ↔ live-campaign join. When the planet has no active campaign it is
 * still included (has_active_campaign: false) with its static state; the
 * campaign-derived fields are null there, never fabricated. */
export interface WarBriefTarget {
  index: number;
  name: string | null;
  has_active_campaign: boolean;
  campaign_kind: "liberation" | "defense" | null;
  /** Campaign faction when a campaign is active; otherwise the planet's
   * verbatim currentOwner. */
  faction: string | null;
  raw_hp: number | null;
  max_hp: number | null;
  hp_per_hour: number | null;
  direction: Direction;
  stabilizing: boolean | null;
  hpc: boolean | null;
  decay_per_hour: number | null;
  player_count: number | null;
}

/** Stage 6, Part A: one active special event surfaced in the war brief —
 * presence + identity facts echoed from the normalized campaign. */
export interface WarBriefEvent {
  planet_index: number;
  planet_name: string;
  faction: string;
  campaign_kind: "liberation" | "defense";
  event_type: number | null;
  modifier: string | null;
  defense_ends_at: string | null;
  defense_hours_remaining: number | null;
}

/* --------------------------- Stage 8 outputs --------------------------- */

/** Stage 8: one observed point in a Major Order objective's progress series.
 * `progress` / `target` are the Stage-7-decoded values get_major_order
 * returns (missing upstream → null, never 0). Deltas are raw differences
 * from the prior OBSERVATION — never a projection; null on the first point
 * or when either end's progress is null. */
export interface MoHistoryPoint {
  t: number;
  observed_at: string;
  progress: number | null;
  target: number | null;
  delta_progress: number | null;
  delta_hours: number | null;
}

/** Stage 8: one shaped Major Order objective series as returned by
 * get_major_order_history. Observed samples + deterministic derivations
 * only: no forecast, no required pace, no on-track/behind verdict — pace
 * judgment lives in the conversation layer. `objective_kind` reuses the
 * Stage 7 TASK_TYPE_NAMES decode (null when the task type is unconfirmed —
 * never fabricated); `progress_pct` = latest progress / target × 100, null
 * when the target is 0 or unknown (never a divide-by-zero or fabricated
 * denominator). With fewer than 2 points `insufficient_history` is true and
 * the span is null — the same honesty as the other history tools. */
export interface MoHistorySeries {
  major_order_id: number;
  objective_index: number;
  task_type: number | null;
  objective_kind: string | null;
  points: number;
  samples: MoHistoryPoint[];
  latest_progress: number | null;
  target: number | null;
  progress_pct: number | null;
  samples_span_hours: number | null;
  insufficient_history: boolean;
}

/* --------------------------- Stage 9 outputs --------------------------- */

/** Stage 9: machine-readable reason a projection is null. Every null ETA
 * carries one — the consumer can say WHY there is no estimate, not just that
 * there isn't one. A confident number faked from too little data would be
 * worse than no number. */
export type EtaReason =
  /** No current rate exists yet (cold start / fewer than two samples >60s
   * apart) — the same condition under which hp_per_hour itself is null. */
  | "no_current_rate"
  /** The rate is exactly 0 — no movement at the assumed rate, never a
   * divide-by-zero, never Infinity. */
  | "stalemate"
  /** The retained history series has too few points (< 2, the same
   * threshold the history tools flag as insufficient_history). */
  | "insufficient_history"
  /** The distance to the objective is unknown (missing HP / progress /
   * target) — never substituted with 0. */
  | "unknown_distance";

/** Stage 9: deterministic comparison of the instantaneous and historical
 * rates. This is arithmetic — "the two rates disagree by X" — explicitly NOT
 * a regime-change verdict; inferring WHY they disagree (a city fell, players
 * redeployed) is the consumer's. Null when either rate is null (one number
 * cannot be compared to nothing). */
export interface RateDivergence {
  /** |instantaneous_rate − historical_rate|. */
  abs_diff: number;
  /** abs_diff / max(|instantaneous|, |historical|) × 100 — a symmetric
   * relative measure; 0 when both rates are 0 (abs_diff is then 0 too). */
  pct_diff: number;
  /** pct_diff ≥ RATE_DIVERGENCE_THRESHOLD_PCT — a documented arithmetic
   * threshold, not a judgment. */
  diverging: boolean;
}

/** Stage 9: dual ETAs toward an objective — both projections presented with
 * their assumptions, side by side. The server never picks the "right" one:
 * the instantaneous ETA reacts to a regime change but is noisy; the
 * historical ETA is stable but lags. Their divergence is itself information
 * the consumer reads. ETA hours = distance ÷ |rate| (the invariant-3
 * magnitude convention — direction carries the sign elsewhere); a positive
 * ETA = time until the objective is reached at that assumed rate. */
export interface EtaBlock {
  /** distance ÷ |instantaneous_rate| — reacts immediately, noisy. */
  eta_instantaneous_hours: number | null;
  /** The signed current rate used (hp_per_hour for campaigns, the latest
   * observed progress delta per hour for MO objectives). */
  instantaneous_rate: number | null;
  eta_instantaneous_reason: EtaReason | null;
  /** distance ÷ |historical_rate| — stable, lags after a regime change. */
  eta_historical_hours: number | null;
  /** Unweighted mean of the per-interval observed rates over the retained
   * history window (the same rate_mean convention as get_planet_history). */
  historical_rate: number | null;
  eta_historical_reason: EtaReason | null;
  /** Points in the retained history series the historical rate is built on. */
  sample_count: number;
  samples_span_hours: number | null;
  /** Observed spread (max − min) of the per-interval rates — a variance
   * fact, NOT a confidence score. Null with fewer than two interval rates. */
  rate_stability: number | null;
  rate_divergence: RateDivergence | null;
}

/** Stage 9: a defense's competing clocks, side by side — NEVER a success
 * prediction. Both depletion ETAs (the dual model on the event health) are
 * presented against the fixed deadline; the deterministic comparison is
 * exposed against EACH rate, labeled. Calling the winner of the race is a
 * verdict and is deliberately absent. */
export interface DefenseEtaBlock {
  depletion_eta_instantaneous_hours: number | null;
  instantaneous_rate: number | null;
  depletion_eta_instantaneous_reason: EtaReason | null;
  depletion_eta_historical_hours: number | null;
  historical_rate: number | null;
  depletion_eta_historical_reason: EtaReason | null;
  sample_count: number;
  samples_span_hours: number | null;
  rate_stability: number | null;
  rate_divergence: RateDivergence | null;
  /** The fixed deadline, echoed for co-location with the two ETAs racing it. */
  defense_hours_remaining: number | null;
  /** depletion_eta_instantaneous_hours ≤ defense_hours_remaining — the Stage 7
   * comparison evaluated against the INSTANTANEOUS rate; null when that ETA
   * or the window is null. */
  resolution_within_defense_window_instantaneous: boolean | null;
  /** The same comparison evaluated against the HISTORICAL rate. */
  resolution_within_defense_window_historical: boolean | null;
}

/* --------------------------- Stage 10 types ---------------------------- */

/** Raw ArrowHead war-status planet entry (wrapper /raw endpoint — verified
 * live 2026-06-11). `owner` is the numeric faction enum (1=Humans,
 * 2=Terminids, 3=Automaton, 4=Illuminate — see RAW_FACTION_NAMES). Note:
 * carries NO maxHealth and NO liberation % — those are WarInfo / derived. */
export interface RawStatusPlanet {
  index: number;
  owner?: number;
  health?: number;
  regenPerSecond?: number;
  players?: number;
}

/** Raw ArrowHead campaign entry: `id` joins the normalized campaign id
 * exactly; `race` is the numeric faction enum. */
export interface RawStatusCampaign {
  id: number;
  planetIndex?: number;
  type?: number;
  race?: number;
}

/** Raw ArrowHead planet event (defense) entry. `health`/`maxHealth` are the
 * event health the defense path tracks; times are game-epoch (unusable —
 * the existing war.now lesson) and deliberately not cross-checked. */
export interface RawStatusEvent {
  id: number;
  planetIndex?: number;
  eventType?: number;
  race?: number;
  health?: number;
  maxHealth?: number;
  campaignId?: number;
}

/** The slice of /raw/api/WarSeason/{war}/Status this server cross-checks. */
export interface RawWarStatus {
  warId?: number;
  impactMultiplier?: number;
  planetStatus?: RawStatusPlanet[];
  campaigns?: RawStatusCampaign[];
  planetEvents?: RawStatusEvent[];
}

/** Raw ArrowHead assignment (wrapper /raw/api/v2/Assignment/War/{war}):
 * `id32` equals the normalized assignment id; `setting.tasks` carries the
 * SAME positional type/values/valueTypes arrays the normalized payload
 * does (verified byte-identical live 2026-06-11). */
export interface RawWarStatusAssignment {
  id32: number;
  progress?: number[];
  expiresIn?: number;
  setting?: {
    type?: number;
    overrideTitle?: string;
    tasks?: RawAssignmentTask[];
  };
}

/** Stage 10: the normalized-side view a cross-check runs against — assembled
 * by the handler from values the payload itself carries, so every check is
 * verifiable in place. campaign_id null/-1 = no real campaign (a quiet-planet
 * probe makes no campaign_type claim to check). */
export interface CrossCheckSubject {
  planet_index: number;
  campaign_id: number | null;
  campaign_kind: "liberation" | "defense";
  campaign_type: number | null;
  current_owner: string | null;
  raw_hp: number | null;
  max_hp: number | null;
  regen_per_second: number | null;
  liberation_pct_display_only: number | null;
  event_type: number | null;
  player_count: number | null;
}

/** Stage 10: one cross-checked field. `agrees` is exact for discrete fields,
 * within CROSS_CHECK_FLOAT_TOLERANCE for floats, and null (with a reason)
 * when one side has no counterpart. `expected_transform: true` marks a field
 * an invariant DELIBERATELY transforms — documented behavior, never a
 * mismatch. Both values always ride together: a disagreement is presented,
 * never resolved — no field anywhere names a side as correct. */
export interface CrossCheckField {
  field: string;
  normalized_value: number | string | boolean | null;
  raw_value: number | string | boolean | null;
  agrees: boolean | null;
  abs_diff?: number;
  pct_diff?: number;
  expected_transform?: true;
  reason?: string;
}

/** Stage 10: the cross_check block on get_planet. When /raw cannot be
 * served the block degrades to available: false with a machine-readable
 * reason — the primary response is never blocked, the missing side never
 * guessed. Both sides' retrieval timestamps are exposed so fetch-moment
 * skew is visible, not silently compared across time. */
export type CrossCheckBlock =
  | {
      available: true;
      raw_source: string;
      checked: CrossCheckField[];
      fields_checked: number;
      agreements: number;
      unexpected_disagreements: number;
      expected_transforms: number;
      uncheckable: number;
      normalized_as_of: string;
      raw_as_of: string;
      raw_stale?: true;
      note: string;
    }
  | {
      available: false;
      raw_source: string;
      reason: "raw_unavailable" | "normalized_unavailable";
      detail?: string;
      note: string;
    };

/** Worker environment bindings. */
export interface Env {
  WAR_CACHE?: KVNamespace;
  SUPER_CLIENT?: string;
  SUPER_CONTACT?: string;
}
