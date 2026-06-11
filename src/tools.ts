/**
 * The twelve MCP tools. Orchestration layer: fetch raw data via client.ts,
 * assemble NormalizeContext (rates, ages, MO planet set), and run the pure
 * invariant normalization from invariants.ts (plus the pure Stage 1/2
 * enrichment shapers from enrichment.ts). The one non-war-state tool,
 * get_planet_wiki, uses its own separate source pipeline (wiki.ts +
 * wikiClient.ts) — lore never flows into a live war-state field.
 */
import {
  fetchUpstream,
  readGlobalSamples,
  readObservedSignatures,
  readPlanetSamples,
  samplePlanetRates,
  SAMPLES_KEY_TTL_SECONDS,
  type SampleInput,
} from "./client";
import {
  aggregateFrontRate,
  buildActiveEvents,
  buildFactionRollup,
  buildGlobalHistoryPoints,
  buildHistoryPoints,
  buildMajorOrderTargets,
  buildNeighbors,
  buildSectorRollup,
  decayPerHour,
  decodeEventModifier,
  DEFENSE_WINDOW_NOTE,
  defenseTiming,
  defenseWindowProjection,
  DIRECTION_NOTE,
  filterCampaigns,
  freshnessFrom,
  FRESHNESS_NOTE,
  historyRateAggregates,
  hpRemainingToObjective,
  LIBERATION_PCT_NOTE,
  MO_OBJECTIVE_DECODE_NOTE,
  moPlanetAssignmentMap,
  RATE_SIGN_NOTE,
  resolvePlanetName,
  selectBiome,
  selectHazards,
  selectPlanetStatistics,
  shapeDispatches,
  shapeMajorOrders,
  shapeObservedSignatures,
  shapePatchNotes,
  WIN_CONDITION_NOTE,
  winCondition,
} from "./enrichment";
import { planWikiQuery, shapeWikiResult } from "./wiki";
import { fetchWikiQuery } from "./wikiClient";
import {
  HPC_CAMPAIGN_TYPES,
  campaignKind,
  normalizeCampaign,
} from "./invariants";
import {
  MAX_GLOBAL_SAMPLES,
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLES_PER_PLANET,
  MAX_SIGNATURES,
  type SignatureObservation,
} from "./sampling";
import type {
  CampaignFilters,
  EnrichedCampaign,
  Env,
  FrontRateAggregate,
  NormalizedCampaign,
  RawAssignment,
  RawCampaign,
  RawDispatch,
  RawPlanet,
  RawSteamNews,
  RawWar,
} from "./types";

export class ToolError extends Error {}

/**
 * Stage 5, Part A: the observed signature tuple for each campaign. Every
 * field is straight upstream data; `faction` uses the SAME derivation as
 * normalizeCampaign (event attacker on a defense, planet owner otherwise)
 * so tuples stay verifiable against get_campaigns output. Missing field →
 * null inside the tuple, never fabricated.
 */
function signatureObservationsFrom(
  raw: RawCampaign[],
): SignatureObservation[] {
  return raw.map((c) => {
    const event = c.planet.event;
    const faction =
      campaignKind(c) === "defense"
        ? (typeof event?.faction === "string" ? event.faction : null)
        : typeof c.planet.currentOwner === "string"
          ? c.planet.currentOwner
          : null;
    return {
      campaign_type: typeof c.type === "number" ? c.type : null,
      event_type:
        typeof event?.eventType === "number" ? event.eventType : null,
      has_event: Boolean(event),
      faction,
    };
  });
}

function trackableHealth(planet: RawPlanet): number | null {
  const h = planet.event ? planet.event.health : planet.health;
  return typeof h === "number" && Number.isFinite(h) ? h : null;
}

function defenseAgeMs(planet: RawPlanet, nowMs: number): number | null {
  if (!planet.event?.startTime) return null;
  const started = Date.parse(planet.event.startTime);
  return Number.isFinite(started) ? Math.max(0, nowMs - started) : null;
}

interface CampaignBundle {
  campaigns: EnrichedCampaign[];
  stale: boolean;
  /** Raw assignments from the same fetch the MO planet map used — exposed so
   * the war brief can reuse the MO shaping without a second fetch. */
  assignments: RawAssignment[];
  /** Stage 6: retrieval timestamps of every contributing upstream fetch,
   * for the freshness metadata (oldest governs). */
  fetchedAts: number[];
  /** Present iff requested via { withWar: true } — the war fetch joins the
   * existing parallel fetch so its global statistics reach the single
   * sample-store write without a second round-trip. */
  war?: { data: RawWar; stale: boolean };
}

async function loadNormalizedCampaigns(
  env: Env,
  opts: { withWar?: boolean } = {},
): Promise<CampaignBundle> {
  const [campaignsRes, assignmentsRes, warRes] = await Promise.all([
    fetchUpstream<RawCampaign[]>(env, "/api/v1/campaigns"),
    fetchUpstream<RawAssignment[]>(env, "/api/v1/assignments"),
    opts.withWar
      ? fetchUpstream<RawWar>(env, "/api/v1/war")
      : Promise.resolve(null),
  ]);
  const raw = campaignsRes.data ?? [];
  // Stage 5: one shared planet→assignment map; the invariant-5 MO planet
  // set is derived from its keys, so HPC membership is unchanged.
  const moMap = moPlanetAssignmentMap(assignmentsRes.data ?? []);
  const moPlanetIndices = new Set(moMap.keys());
  const nowMs = Date.now();

  const samples = await samplePlanetRates(
    env,
    raw.map(
      (c): SampleInput => ({
        planetIndex: c.planet.index,
        health: trackableHealth(c.planet),
        campaignId: c.id,
      }),
    ),
    nowMs,
    {
      // Stage 5 accumulation layers — folded into the SAME single write.
      // Global statistics are present only on the get_war_status path (the
      // one place the war is fetched); signatures fold on every poll.
      signatures: signatureObservationsFrom(raw),
      globalStatistics: warRes?.data?.statistics ?? null,
    },
  );

  const campaigns = raw.map((c): EnrichedCampaign => {
    const sample = samples.get(c.planet.index);
    // Defense events carry an authoritative start time; prefer it over the
    // Worker's first-seen tracking for ramp-up age.
    const campaignAgeMs =
      campaignKind(c) === "defense"
        ? (defenseAgeMs(c.planet, nowMs) ?? sample?.campaignAgeMs ?? null)
        : (sample?.campaignAgeMs ?? null);
    const normalized = normalizeCampaign(c, {
      hpPerHour: sample?.hpPerHour ?? null,
      campaignAgeMs,
      hpcTypes: HPC_CAMPAIGN_TYPES,
      moPlanetIndices,
    });
    const timing = c.planet.event ? defenseTiming(c.planet.event, nowMs) : null;
    return {
      ...normalized,
      // Stage 3: unit conversion of the invariant-1 normalized regen (already
      // force-nulled for defenses) — never of the raw upstream regen.
      decay_per_hour: decayPerHour(normalized.regen_per_second),
      statistics: selectPlanetStatistics(c.planet.statistics),
      biome: selectBiome(c.planet.biome),
      hazards: selectHazards(c.planet.hazards),
      // Stage 4: live event identity — raw enum + confirmed-map name only,
      // decoded from the live API's own event data (never the wiki).
      ...decodeEventModifier(c.planet.event),
      ...(timing ?? {}),
      // Stage 7, Part A: objective-relative framing — the win-state target
      // and the always-positive distance to it (smaller = closer), so the
      // direction of progress never has to be inferred from sign conventions.
      win_condition: winCondition(normalized.campaign_kind),
      hp_remaining_to_objective: hpRemainingToObjective(normalized.raw_hp),
      // Stage 7, Part B: the defense timing gap as co-located numbers —
      // derived from the SAME signed rate and projection invariant 3 made.
      ...(timing
        ? defenseWindowProjection({
            rawHp: normalized.raw_hp,
            hpPerHour: normalized.hp_per_hour,
            defenseHoursRemaining: timing.defense_hours_remaining,
            hoursToResolution: normalized.hours_to_resolution,
          })
        : {}),
      // Stage 5: pure join against the MO task planet set — the same map
      // invariant 5 consumes; membership fact, not a priority score.
      is_major_order_target: moMap.has(c.planet.index),
      major_order_id: moMap.get(c.planet.index) ?? null,
    };
  });

  return {
    campaigns,
    stale: campaignsRes.stale || assignmentsRes.stale,
    assignments: assignmentsRes.data ?? [],
    fetchedAts: [
      campaignsRes.fetchedAt,
      assignmentsRes.fetchedAt,
      ...(warRes ? [warRes.fetchedAt] : []),
    ],
    ...(warRes ? { war: { data: warRes.data, stale: warRes.stale } } : {}),
  };
}

/**
 * Cron-driven sampling entry: the Worker's `scheduled` handler (index.ts,
 * fired by the wrangler.toml [triggers] schedule) delegates here. It drives
 * EXACTLY the request path's poll — loadNormalizedCampaigns with the war
 * fetch joined: the same cache/fetch logic, the same 60s minimum sample
 * interval, and the same single merged sample-store write (planet series +
 * signatures + global statistics) inside samplePlanetRates. The cron path
 * cannot drift from the request path because it IS the request path's
 * loader — never a forked sampler. Best-effort by design: no user is
 * watching a cron tick, so an upstream failure is logged and swallowed and
 * the next tick retries.
 */
export async function runScheduledSample(env: Env): Promise<void> {
  try {
    await loadNormalizedCampaigns(env, { withWar: true });
  } catch (err) {
    console.warn(
      `scheduled sample skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getWarStatus(env: Env): Promise<unknown> {
  // Stage 5: the war fetch rides inside loadNormalizedCampaigns (withWar) so
  // its global statistics reach the single sample-store write; the planets
  // list (already KV-cached, used by get_planet) feeds the rollups.
  const [planetsRes, bundle] = await Promise.all([
    fetchUpstream<RawPlanet[]>(env, "/api/v1/planets"),
    loadNormalizedCampaigns(env, { withWar: true }),
  ]);
  const war = bundle.war!.data;
  const planets = planetsRes.data ?? [];

  const byFaction = new Map<string, EnrichedCampaign[]>();
  for (const c of bundle.campaigns) {
    const list = byFaction.get(c.faction) ?? [];
    list.push(c);
    byFaction.set(c.faction, list);
  }

  const fronts: Record<
    string,
    {
      campaigns: number;
      defenses: number;
      planets: string[];
    } & FrontRateAggregate
  > = {};
  for (const [faction, list] of byFaction) {
    fronts[faction] = {
      campaigns: list.length,
      defenses: list.filter((c) => c.campaign_kind === "defense").length,
      planets: list.map((c) => c.planet_name),
      // Stage 3: the SAME signed per-campaign rates, summed — no recompute.
      ...aggregateFrontRate(list.map((c) => c.hp_per_hour)),
    };
  }

  // Stage 5: rollups reuse the front aggregates verbatim — one signed
  // source of truth, never a recompute.
  const netRateByFaction = new Map<string, number | null>(
    Object.entries(fronts).map(([f, v]) => [f, v.net_hp_per_hour]),
  );

  return {
    war_started: war.started,
    war_ends: war.ended,
    client_version: war.clientVersion,
    factions: war.factions,
    impact_multiplier: war.impactMultiplier,
    total_planets_in_play: bundle.campaigns.length,
    active_fronts: fronts,
    faction_rollup: buildFactionRollup(
      planets,
      bundle.campaigns,
      netRateByFaction,
    ),
    sector_rollup: buildSectorRollup(planets, bundle.campaigns),
    global_statistics: {
      player_count: war.statistics.playerCount,
      missions_won: war.statistics.missionsWon,
      missions_lost: war.statistics.missionsLost,
      mission_success_rate: war.statistics.missionSuccessRate,
      terminid_kills: war.statistics.terminidKills,
      automaton_kills: war.statistics.automatonKills,
      illuminate_kills: war.statistics.illuminateKills,
      deaths: war.statistics.deaths,
    },
    notes: {
      net_hp_per_hour:
        "Per-front sum of the same signed per-campaign hp_per_hour values (positive = progressing toward the win state, for liberation AND defense alike — a successful defense depletes its event health toward zero). Only planets with a known rate are summed — planets_with_rate vs planets_total states the coverage. Null means no planet on the front has a rate yet (e.g. cold start), not zero.",
      faction_rollup:
        "Deterministic counts/sums per faction over data already fetched: planets owned (by currentOwner over the full planets list), active campaigns on that faction's front, the SAME Stage-3 net_hp_per_hour front aggregate echoed verbatim (null when the faction has no active front — e.g. Humans), and the sum of known per-campaign player counts (null when none known; campaigns_with_players vs campaigns_total states the coverage). Facts only — no ranking, no verdict.",
      sector_rollup:
        "Per-sector planet count, owner tallies (verbatim upstream owner strings), and number of active campaigns in the sector. Counts only.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom(
      [planetsRes.fetchedAt, ...bundle.fetchedAts],
      Date.now(),
    ),
    ...(planetsRes.stale || bundle.war!.stale || bundle.stale
      ? { stale: true }
      : {}),
  };
}

export async function getCampaigns(
  env: Env,
  filters: CampaignFilters = {},
): Promise<unknown> {
  const bundle = await loadNormalizedCampaigns(env);
  // Stage 6, Part B: filtering runs AFTER normalization — every invariant
  // already ran over the full list; filters only narrow what is returned.
  const filtered = filterCampaigns(bundle.campaigns, filters);
  const isFiltered =
    filtered.length !== bundle.campaigns.length ||
    filters.faction != null ||
    filters.major_order_only ||
    filters.has_rate ||
    filters.hpc_only;
  return {
    count: filtered.length,
    total_count: bundle.campaigns.length,
    filtered_count: filtered.length,
    ...(isFiltered ? { filters_applied: { ...filters } } : {}),
    campaigns: filtered,
    notes: {
      liberation_pct_display_only: LIBERATION_PCT_NOTE,
      hp_per_hour: RATE_SIGN_NOTE,
      direction: DIRECTION_NOTE,
      win_condition: WIN_CONDITION_NOTE,
      defense_window: DEFENSE_WINDOW_NOTE,
      mission_success_rate:
        "Derived per planet as mission_wins / (mission_wins + mission_losses) × 100. Null when no missions are recorded — never 0.",
      defense_hours_remaining:
        "Defense campaigns only: (endTime − now) in hours, clamped at 0 with defense_expired: true once past. A deadline fact, not an urgency judgment.",
      decay_per_hour:
        "regen_per_second × 3600 — regen in the same units as hp_per_hour. Derived from the invariant-normalized regen, so it is always null on defense campaigns (cosmetic decay stays suppressed) and null when regen is unknown.",
      modifier:
        "Decoded special-faction name for event_type, only when the enum value is confirmed in EVENT_MODIFIER_NAMES. event_type non-null with modifier null = an active event whose enum value is not yet confirmed — visible, never named by guess. Both null = no event. Identity only, no difficulty judgment; lore/meaning lives in get_planet_wiki.",
      is_major_order_target:
        "Pure membership join against the current Major Order task planet set (the same set HPC detection consumes). major_order_id is the id of the first assignment naming the planet (upstream array order) when it appears in several; null when the planet is in no MO task. A fact, not a priority score.",
      filters:
        "Optional args (faction, major_order_only, has_rate, hpc_only) AND-combine and only narrow the returned array — normalization always runs over the full campaign list first. filtered_count vs total_count states the coverage; no args returns every campaign.",
      units:
        "Unit conventions: *_per_hour fields are per hour; regen_per_second is per second (decay_per_hour is its ×3600 conversion); *_seconds fields are whole seconds; *_hours fields are fractional hours; humanized strings (expires_in, defense_time_remaining) are renderings of an adjacent raw-seconds field, never the only carrier.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom(bundle.fetchedAts, Date.now()),
    ...(bundle.stale ? { stale: true } : {}),
  };
}

export async function getMajorOrder(env: Env): Promise<unknown> {
  const res = await fetchUpstream<RawAssignment[]>(env, "/api/v1/assignments");
  const assignments = res.data ?? [];
  const freshness = freshnessFrom([res.fetchedAt], Date.now());
  if (assignments.length === 0) {
    return {
      active: false,
      message: "No active Major Order at this time.",
      ...freshness,
      ...(res.stale ? { stale: true } : {}),
    };
  }

  return {
    active: true,
    major_orders: shapeMajorOrders(assignments, Date.now()),
    notes: {
      objectives: MO_OBJECTIVE_DECODE_NOTE,
      freshness: FRESHNESS_NOTE,
    },
    ...freshness,
    ...(res.stale ? { stale: true } : {}),
  };
}

/**
 * Shared index/name resolution for get_planet and get_planet_history:
 * numeric index match, or trimmed case-insensitive name match. Not-found
 * errors carry a hint listing up to 10 planets with active campaigns.
 */
function assertPlanetArgs(args: { index?: number; name?: string }): void {
  if (args.index == null && !args.name) {
    throw new ToolError(
      "Provide either a planet `index` (number) or `name` (string).",
    );
  }
}

function resolvePlanet(
  planets: RawPlanet[],
  args: { index?: number; name?: string },
  activePlanets: { name: string; index: number }[],
): RawPlanet {
  let planet: RawPlanet | undefined;
  if (args.index != null) {
    planet = planets.find((p) => p.index === args.index);
  } else {
    // Stage 6, Part C: shared resolution. An exact or normalized-exact match
    // resolves (the same name modulo case/punctuation — never a different
    // planet); a fuzzy near-miss surfaces ranked candidates in the error
    // instead of a bare not-found. The server never silently substitutes.
    const resolution = resolvePlanetName(args.name!, planets);
    if (resolution.matched) {
      planet = planets.find((p) => p.index === resolution.planet!.index);
    } else if (resolution.candidates.length > 0) {
      const list = resolution.candidates
        .map((c) => `${c.name} (index ${c.index})`)
        .join(", ");
      throw new ToolError(
        `Planet not found for name "${args.name}". Did you mean: ${list}? ` +
          `No planet is ever substituted automatically — retry with one of these names or an index, or call resolve_planet to disambiguate.`,
      );
    }
  }

  if (!planet) {
    const activeHint = activePlanets
      .slice(0, 10)
      .map((p) => `${p.name} (index ${p.index})`)
      .join(", ");
    throw new ToolError(
      `Planet not found for ${args.index != null ? `index ${args.index}` : `name "${args.name}"`}. ` +
        `Valid indices are 0–${Math.max(0, planets.length - 1)}. ` +
        `Planets with active campaigns include: ${activeHint || "none currently"}.`,
    );
  }
  return planet;
}

export async function getPlanet(
  env: Env,
  args: { index?: number; name?: string },
): Promise<unknown> {
  assertPlanetArgs(args);

  const [planetsRes, bundle] = await Promise.all([
    fetchUpstream<RawPlanet[]>(env, "/api/v1/planets"),
    loadNormalizedCampaigns(env),
  ]);
  const planets = planetsRes.data ?? [];

  const planet = resolvePlanet(
    planets,
    args,
    bundle.campaigns.map((c) => ({
      name: c.planet_name,
      index: c.planet_index,
    })),
  );

  const active = bundle.campaigns.find(
    (c) => c.planet_index === planet!.index,
  );

  let normalized: NormalizedCampaign;
  if (active) {
    normalized = active;
  } else {
    // No active campaign: normalize a synthetic record so invariants
    // (defense decay nulling, display-only %, projection guards) still apply.
    const nowMs = Date.now();
    const samples = await samplePlanetRates(
      env,
      [
        {
          planetIndex: planet.index,
          health: trackableHealth(planet),
          campaignId: null,
        },
      ],
      nowMs,
      // Single-planet probe: carry the rest of the store forward so one
      // lookup doesn't wipe other planets' series / campaign ages.
      { carryForward: true },
    );
    const sample = samples.get(planet.index);
    normalized = normalizeCampaign(
      { id: -1, planet, type: 0, count: 0, faction: planet.currentOwner },
      {
        hpPerHour: sample?.hpPerHour ?? null,
        campaignAgeMs: defenseAgeMs(planet, nowMs),
        hpcTypes: HPC_CAMPAIGN_TYPES,
        moPlanetIndices: new Set(),
      },
    );
  }

  // Stage 7: defense timing computed once so the Part B window projection
  // derives from the same clamped hours value the payload itself carries.
  const timing = planet.event ? defenseTiming(planet.event, Date.now()) : null;

  return {
    planet_index: planet.index,
    planet_name: planet.name,
    sector: planet.sector,
    current_owner: planet.currentOwner,
    initial_owner: planet.initialOwner,
    has_active_campaign: Boolean(active),
    campaign_kind: normalized.campaign_kind,
    raw_hp: normalized.raw_hp,
    max_hp: normalized.max_hp,
    hp_per_hour: normalized.hp_per_hour,
    regen_per_second: normalized.regen_per_second,
    // Stage 3: derived from the invariant-1 normalized regen above — a
    // defense planet can never re-expose its cosmetic decay here.
    decay_per_hour: decayPerHour(normalized.regen_per_second),
    liberation_pct_display_only: normalized.liberation_pct_display_only,
    // Stage 7, Part A: objective-relative framing — win-state target plus
    // the always-positive distance to it (smaller = closer, both kinds).
    win_condition: winCondition(normalized.campaign_kind),
    hp_remaining_to_objective: hpRemainingToObjective(normalized.raw_hp),
    hours_to_resolution: normalized.hours_to_resolution,
    projection_status: normalized.status,
    direction: normalized.direction,
    alert: normalized.alert,
    stabilizing: normalized.stabilizing,
    hpc: normalized.hpc,
    ...(normalized.hpc_note ? { hpc_note: normalized.hpc_note } : {}),
    ...(normalized.data_quality
      ? { data_quality: normalized.data_quality }
      : {}),
    // Stage 4: live event identity — raw enum + confirmed-map name only,
    // decoded from the live API's own event data (never the wiki).
    ...decodeEventModifier(planet.event),
    defense_event: planet.event
      ? {
          event_type: planet.event.eventType,
          attacker: planet.event.faction,
          start_time: planet.event.startTime,
          end_time: planet.event.endTime,
        }
      : null,
    ...(timing ?? {}),
    // Stage 7, Part B: the timing-vs-trajectory gap as co-located numbers,
    // from the SAME signed rate and projection already in this payload.
    ...(timing
      ? defenseWindowProjection({
          rawHp: normalized.raw_hp,
          hpPerHour: normalized.hp_per_hour,
          defenseHoursRemaining: timing.defense_hours_remaining,
          hoursToResolution: normalized.hours_to_resolution,
        })
      : {}),
    player_count: planet.statistics?.playerCount ?? null,
    statistics: selectPlanetStatistics(planet.statistics),
    biome: selectBiome(planet.biome),
    hazards: selectHazards(planet.hazards),
    // Stage 5: waypoint neighbors joined against data already in hand — the
    // full planets list and the active campaign set. Adds neighbors,
    // neighbor_summary, frontline.
    ...buildNeighbors(
      planet,
      new Map(planets.map((p) => [p.index, p])),
      new Map(
        bundle.campaigns.map((c) => [c.planet_index, c.campaign_kind]),
      ),
    ),
    notes: {
      hp_per_hour: RATE_SIGN_NOTE,
      direction: DIRECTION_NOTE,
      win_condition: WIN_CONDITION_NOTE,
      liberation_pct_display_only: LIBERATION_PCT_NOTE,
      defense_window: DEFENSE_WINDOW_NOTE,
      neighbors:
        "Upstream's own waypoints array for this planet, in upstream order — joined by index against the full planets list and the active campaign set, never symmetrized or rerouted (direction semantics are upstream's). A dangling index still counts in neighbor_summary.total with name/owner null, tallied under by_owner.unknown.",
      frontline:
        "Deterministic adjacency fact: true iff at least one neighbor has a known owner different from this planet's current_owner — 'borders territory of a different owner', nothing more. Not a strategic judgment; neighbors with unknown owners never set it.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom(
      [planetsRes.fetchedAt, ...bundle.fetchedAts],
      Date.now(),
    ),
    ...(planetsRes.stale || bundle.stale ? { stale: true } : {}),
  };
}

/**
 * Stage 4: the LORE tool — a standalone source (helldivers.wiki.gg), never a
 * field on a live tool. Accepts a planet name (resolved to the wiki's title
 * casing) or an explicit page title (enemy/subfaction/topic lookups). The
 * payload carries mandatory attribution and the lore disclaimer on every
 * outcome and contains no live war-state numbers.
 */
export async function getPlanetWiki(
  env: Env,
  args: { name?: string; title?: string },
): Promise<unknown> {
  const requested = (args.title ?? args.name)?.trim();
  if (!requested) {
    throw new ToolError(
      "Provide either a planet `name` (string) or an explicit wiki page `title` (string), e.g. name: \"Gacrux\" or title: \"Jet Brigade\".",
    );
  }
  const plan = planWikiQuery(args);
  const res = await fetchWikiQuery(env, plan);
  return {
    ...shapeWikiResult(res.body, plan, Date.now()),
    ...(res.stale ? { stale: true } : {}),
  };
}

export async function getDispatches(
  env: Env,
  args: { limit?: number },
): Promise<unknown> {
  const res = await fetchUpstream<RawDispatch[]>(env, "/api/v1/dispatches");
  const dispatches = shapeDispatches(res.data, args.limit);
  return {
    count: dispatches.length,
    dispatches,
    ...(dispatches.length === 0
      ? { note: "No dispatches currently available from upstream." }
      : {}),
    ...freshnessFrom([res.fetchedAt], Date.now()),
    ...(res.stale ? { stale: true } : {}),
  };
}

export async function getPatchNotes(
  env: Env,
  args: { limit?: number },
): Promise<unknown> {
  const res = await fetchUpstream<RawSteamNews[]>(env, "/api/v1/steam");
  const patchNotes = shapePatchNotes(res.data, args.limit);
  return {
    count: patchNotes.length,
    patch_notes: patchNotes,
    notes: {
      content:
        "Verbatim Steam BBCode exactly as published — the upstream has no summary field and this server derives none; rendering is the consumer's job.",
    },
    ...(patchNotes.length === 0
      ? { note: "No Steam news currently available from upstream." }
      : {}),
    ...freshnessFrom([res.fetchedAt], Date.now()),
    ...(res.stale ? { stale: true } : {}),
  };
}

export async function getPlanetHistory(
  env: Env,
  args: { index?: number; name?: string },
): Promise<unknown> {
  assertPlanetArgs(args);

  const [planetsRes, campaignsRes] = await Promise.all([
    fetchUpstream<RawPlanet[]>(env, "/api/v1/planets"),
    fetchUpstream<RawCampaign[]>(env, "/api/v1/campaigns"),
  ]);
  const planets = planetsRes.data ?? [];

  const planet = resolvePlanet(
    planets,
    args,
    (campaignsRes.data ?? []).map((c) => ({
      name: c.planet.name,
      index: c.planet.index,
    })),
  );

  // Read-only: history never writes to the sample store.
  const samples = await readPlanetSamples(env, planet.index);
  const points = buildHistoryPoints(samples);
  const first = samples[0];
  const last = samples[samples.length - 1];

  return {
    planet_index: planet.index,
    planet_name: planet.name,
    points: points.length,
    window_hours:
      first && last && samples.length >= 2
        ? (last.t - first.t) / 3_600_000
        : null,
    samples: points,
    // Stage 5: observed-only aggregates over the same retained series —
    // rate_min/rate_max/rate_mean/latest_rate + samples_span_hours, all
    // null when fewer than two usable points exist.
    ...historyRateAggregates(samples),
    insufficient_history: points.length < 2,
    ...(points.length < 2
      ? {
          note:
            points.length === 0
              ? "No samples retained for this planet yet. Samples accrue only when this server polls while the planet is in an active campaign (or is queried via get_planet) — a cold start or a dormant planet is expected to be empty, not an error."
              : "Only one sample retained so far; deltas need at least two samples >60s apart.",
        }
      : {}),
    retention: {
      max_points: MAX_SAMPLES_PER_PLANET,
      max_age_hours: MAX_SAMPLE_AGE_MS / 3_600_000,
      note: "The retained window survives only while the server keeps being polled (sample store KV TTL is 24h, refreshed on every poll).",
    },
    notes: {
      delta_health:
        "Raw observed change per point: current − previous (negative = health depleting). hp_per_hour elsewhere uses the opposite orientation, (previous − current) / hours, positive = progressing toward resolution. Both are stated so the sign conventions are explicit. Both conventions apply to defense campaigns identically — the tracked health there is the EVENT health, which depletes toward zero while the defense is being won (verified live), so a falling series is progress for both kinds.",
      sampling:
        "Observed data points and deterministic deltas only — no smoothing, no forecast, no trend verdict. Sample timestamps use the Worker clock (upstream war time is game-epoch and not comparable).",
      rate_aggregates:
        "rate_min/rate_max/rate_mean/latest_rate are plain stats over the per-interval observed rates, using the hp_per_hour sign convention ((previous − current) / hours, positive = progressing). rate_mean is the unweighted mean of per-interval rates — NOT total change ÷ total time. Observed values only: no trend direction, no smoothing, no projection from history (projection lives in get_planet and is current-rate based).",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom(
      [planetsRes.fetchedAt, campaignsRes.fetchedAt],
      Date.now(),
    ),
    ...(planetsRes.stale || campaignsRes.stale ? { stale: true } : {}),
  };
}

/**
 * Stage 5, Part A: the accumulated campaign-signature record — every
 * distinct {campaign_type, event_type, has_event, faction} tuple this
 * server has observed, with first/last seen timestamps. Read-only (zero KV
 * writes); accumulation happens passively on every poll cycle inside the
 * existing single sample-store write. This is the instrumentation for the
 * ROADMAP watch-list items: it captures a special-faction event_type or a
 * non-zero (e.g. defense) campaign_type the moment one appears.
 */
export async function getObservedSignatures(env: Env): Promise<unknown> {
  const signatures = shapeObservedSignatures(
    await readObservedSignatures(env),
  );
  return {
    count: signatures.length,
    max_signatures: MAX_SIGNATURES,
    signatures,
    ...(signatures.length === 0
      ? {
          note: "No signatures accumulated yet. Tuples accrue passively whenever this server polls campaigns (get_war_status, get_campaigns, get_planet) — a cold start is expected to be empty, not an error.",
        }
      : {}),
    notes: {
      purpose:
        "Passive observation record of every distinct {campaign_type, event_type, has_event, faction} tuple seen upstream, so rare states (special-faction events, defense campaign types) are captured with timestamps instead of requiring someone to be watching live. Raw observed values only — no interpretation; a missing upstream field is recorded as null within the tuple.",
      faction:
        "Same derivation as the campaign payloads: the event's attacker on a defense, the planet's current owner otherwise — so tuples are verifiable against get_campaigns.",
      sample_count:
        "Number of distinct observations at least 60s apart (the sampler's minimum interval) — rapid re-polls of the 45s response cache do not inflate it.",
      persistence: `Stored alongside the planet sample series under one KV key with a ${SAMPLES_KEY_TTL_SECONDS / 86_400}-day TTL refreshed on every poll; a record older than that without any polling evaporates.`,
    },
  };
}

/**
 * Stage 5, Part E: the retained global war-statistics series with raw
 * observed deltas — playerbase/tempo history sampled by this server.
 * Read-only (zero KV writes); samples accrue inside the existing single
 * sample-store write, and only on get_war_status polls (the one path that
 * fetches /api/v1/war).
 */
export async function getGlobalHistory(env: Env): Promise<unknown> {
  const samples = await readGlobalSamples(env);
  const points = buildGlobalHistoryPoints(samples);
  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    points: points.length,
    window_hours:
      first && last && samples.length >= 2
        ? (last.t - first.t) / 3_600_000
        : null,
    samples: points,
    insufficient_history: points.length < 2,
    ...(points.length < 2
      ? {
          note:
            points.length === 0
              ? "No global samples retained yet. Samples accrue only when get_war_status is polled (the one tool that fetches the war state) — a cold start is expected to be empty, not an error."
              : "Only one global sample retained so far; deltas need at least two samples >60s apart.",
        }
      : {}),
    retention: {
      max_points: MAX_GLOBAL_SAMPLES,
      max_age_hours: MAX_SAMPLE_AGE_MS / 3_600_000,
      note: `Bounded like the planet series (oldest evicted first); the combined store key carries a ${SAMPLES_KEY_TTL_SECONDS / 86_400}-day KV TTL refreshed on every poll.`,
    },
    notes: {
      sampling:
        "A lean named subset of upstream war.statistics sampled over time on the Worker clock. A field missing upstream is null at that point, never 0; deltas are null when either end is null. Observed values and raw consecutive differences only — no smoothing, no forecast, no trend verdict.",
    },
  };
}

/**
 * Stage 6, Part A: the single-call war digest. Pure ASSEMBLY of the same
 * normalized facts get_war_status / get_campaigns / get_major_order return —
 * the MO ↔ live-trajectory join, per-faction rollups, active events, and
 * totals — pre-joined so the common opening question is one call instead of
 * three. NO recommendation, ranking, or verdict anywhere: the digest
 * enriches and assembles; judgment lives in the conversation layer.
 *
 * Fetch budget: planets + campaigns + assignments + war — exactly the union
 * the three tools already fetch (shared 45s raw cache), and the same single
 * sample-store write a get_war_status poll performs. Never more.
 */
export async function getWarBrief(env: Env): Promise<unknown> {
  const [planetsRes, bundle] = await Promise.all([
    fetchUpstream<RawPlanet[]>(env, "/api/v1/planets"),
    loadNormalizedCampaigns(env, { withWar: true }),
  ]);
  const war = bundle.war!.data;
  const planets = planetsRes.data ?? [];
  const nowMs = Date.now();

  const orders = shapeMajorOrders(bundle.assignments, nowMs);
  const moMap = moPlanetAssignmentMap(bundle.assignments);

  // Fronts: the same Stage 3 aggregate + Stage 5 faction rollup the war
  // status returns — echoed via the same pure functions, never recomputed.
  const byFaction = new Map<string, EnrichedCampaign[]>();
  for (const c of bundle.campaigns) {
    const list = byFaction.get(c.faction) ?? [];
    list.push(c);
    byFaction.set(c.faction, list);
  }
  const netRateByFaction = new Map<string, number | null>(
    [...byFaction].map(([faction, list]) => [
      faction,
      aggregateFrontRate(list.map((c) => c.hp_per_hour)).net_hp_per_hour,
    ]),
  );

  const planetsInPlay = new Set(bundle.campaigns.map((c) => c.planet_index));

  return {
    major_order: orders[0] ?? null,
    major_order_count: orders.length,
    ...(orders.length > 1 ? { additional_major_orders: orders.slice(1) } : {}),
    major_order_targets: buildMajorOrderTargets(
      moMap.keys(),
      bundle.campaigns,
      new Map(planets.map((p) => [p.index, p])),
    ),
    fronts: buildFactionRollup(planets, bundle.campaigns, netRateByFaction),
    active_events: buildActiveEvents(bundle.campaigns),
    totals: {
      player_count: war.statistics?.playerCount ?? null,
      active_campaigns: bundle.campaigns.length,
      planets_in_play: planetsInPlay.size,
    },
    notes: {
      digest:
        "Pre-joined assembly of the SAME normalized facts get_war_status, get_campaigns, and get_major_order return — every field is verifiable against those tools. No recommendation, priority ranking, or war-is-going-well/badly verdict is present by design; that reasoning belongs to the consumer.",
      major_order_targets:
        "The live trajectory of exactly the planets the current Major Order(s) name, in upstream assignment order. A target with no active campaign is included with its static planet state and has_active_campaign: false — campaign-derived fields are null there, never fabricated.",
      hp_per_hour: RATE_SIGN_NOTE,
      direction: DIRECTION_NOTE,
      major_order_objectives: MO_OBJECTIVE_DECODE_NOTE,
      fronts:
        "Per-faction deterministic rollup (same as get_war_status faction_rollup): planets owned, active campaigns, the Stage-3 net_hp_per_hour aggregate echoed verbatim with coverage counts, and known player sums.",
      active_events:
        "Campaigns with a live event (non-null event_type), presence + identity only. Empty array = no special events live right now.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom([planetsRes.fetchedAt, ...bundle.fetchedAts], nowMs),
    ...(planetsRes.stale || bundle.war!.stale || bundle.stale
      ? { stale: true }
      : {}),
  };
}

/**
 * Stage 6, Part C: resolve a loose planet query to the canonical upstream
 * planet — exact, then punctuation/space-normalized, then fuzzy. Ambiguity
 * or a near-miss returns ranked candidates with matched: false; the server
 * never guesses. Read-only: one planets fetch (shared cache), no sampling,
 * no KV write.
 */
export async function resolvePlanetTool(
  env: Env,
  args: { query?: string },
): Promise<unknown> {
  const query = args.query?.trim();
  if (!query) {
    throw new ToolError('Provide `query` (string), e.g. query: "Gacrux".');
  }
  const planetsRes = await fetchUpstream<RawPlanet[]>(env, "/api/v1/planets");
  const resolution = resolvePlanetName(query, planetsRes.data ?? []);
  return {
    query,
    ...resolution,
    notes: {
      resolution:
        "matched: true only for an exact or punctuation/space-normalized exact match (the same name — never a substitution). Fuzzy near-misses and ties return ranked candidates (score = edit distance on normalized names, lower is closer) with matched: false — the consumer chooses. Names are verbatim upstream casing.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom([planetsRes.fetchedAt], Date.now()),
    ...(planetsRes.stale ? { stale: true } : {}),
  };
}
