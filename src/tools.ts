/**
 * The eighteen MCP tools. Orchestration layer: fetch raw data via client.ts,
 * assemble NormalizeContext (rates, ages, MO planet set), and run the pure
 * invariant normalization from invariants.ts (plus the pure Stage 1/2
 * enrichment shapers from enrichment.ts). The one non-war-state tool,
 * get_wiki_page, uses its own separate source pipeline (wiki.ts +
 * wikiClient.ts) — lore never flows into a live war-state field.
 */
import {
  ARCHIVE_DEFAULT_SINCE_HOURS,
  ARCHIVE_MAX_LIMIT,
  clampLimit,
  readArchiveCoverage,
  readGlobalArchive,
  readGlobalEdgeRow,
  readMoArchive,
  readMoEdgeRows,
  readPlanetArchive,
  readPlanetEdgeRows,
  sinceCutoffMs,
  untilCutoffMs,
} from "./archive";
import {
  cacheBulkPlanets,
  commitSampleTick,
  fetchUpstream,
  prepareSampleTick,
  readBulkPlanetsSnapshot,
  readGlobalSamples,
  readMoSeries,
  readObservedSignatures,
  readPlanetSamples,
  samplePlanetRates,
  SAMPLES_KEY_TTL_SECONDS,
  UpstreamError,
  type PreparedSampleTick,
  type SampleInput,
} from "./client";
import {
  aggregateFrontRate,
  buildActiveEvents,
  buildAdjacencySummary,
  buildDefenseEtaBlock,
  buildEtaBlock,
  buildFactionRollup,
  buildGambitOrigins,
  buildGlobalArchivePoints,
  buildGlobalHistoryPoints,
  buildHistoryPoints,
  buildInboundNeighbors,
  buildIsolationRisk,
  buildMajorOrderTargets,
  buildMoArchiveSeries,
  buildMoHistorySeries,
  buildMoPace,
  buildNeighbors,
  buildPlanetArchivePoints,
  buildReverseAdjacency,
  buildSectorRollup,
  buildSupplyGraph,
  buildWarDiff,
  decayPerHour,
  decodeEventModifier,
  DEFENSE_ETA_NOTE,
  DEFENSE_WINDOW_NOTE,
  defenseTiming,
  defenseWindowProjection,
  DIRECTION_NOTE,
  ETA_NOTE,
  filterCampaigns,
  freshnessFrom,
  FRESHNESS_NOTE,
  GAMBIT_ORIGIN_NOTE,
  historyRateAggregates,
  hpRemainingToObjective,
  INBOUND_NEIGHBORS_NOTE,
  ISOLATION_RISK_NOTE,
  LIBERATION_PCT_NOTE,
  MO_OBJECTIVE_DECODE_NOTE,
  MO_PACE_NOTE,
  WAR_DIFF_NOTE,
  moIntervalRates,
  moPlanetAssignmentMap,
  moProgressObservations,
  perIntervalRates,
  PER_PLAYER_RATES_NOTE,
  perPlayerRates,
  RATE_SIGN_NOTE,
  REGIONS_NOTE,
  resolvePlanetName,
  selectRegions,
  seriesSpanHours,
  selectBiome,
  selectHazards,
  selectPlanetStatistics,
  shapeDispatches,
  shapeMajorOrders,
  shapeObservedSignatures,
  shapePatchNotes,
  SUPPLY_GRAPH_NOTE,
  WIN_CONDITION_NOTE,
  winCondition,
} from "./enrichment";
import {
  allFresh,
  anyDegraded,
  campaignView,
  planetProvenanceOf,
  provenanceReasons,
  type CampaignProvenance,
  type CampaignView,
  type PlanetProvenance,
} from "./provenance";
import {
  buildCrossCheckBlock,
  CROSS_CHECK_NOTE,
  crossCheckAssignments,
  crossCheckSubject,
  RAW_ASSIGNMENT_PATH,
  RAW_STATUS_PATH,
  summarizeChecks,
  unavailableCrossCheck,
  unmatchedCampaigns,
} from "./crosscheck";
import { fetchWikiPage } from "./wikiClient";
import {
  HPC_CAMPAIGN_TYPES,
  campaignKind,
  normalizeCampaign,
} from "./invariants";
import {
  MAX_GLOBAL_SAMPLES,
  MAX_MO_SAMPLES,
  MAX_MO_SERIES,
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLES_PER_PLANET,
  MAX_SIGNATURES,
  type HealthSample,
  type MoObjectiveSeries,
  type SignatureObservation,
} from "./sampling";
import type {
  CampaignFilters,
  CrossCheckField,
  CrossCheckSubject,
  DefenseTiming,
  EnrichedCampaign,
  Env,
  EtaBlock,
  FrontRateAggregate,
  NormalizedCampaign,
  RawAssignment,
  RawCampaign,
  RawDispatch,
  RawPlanet,
  RawSteamNews,
  RawWar,
  RawWarStatus,
  RawWarStatusAssignment,
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
    return {
      campaign_type: typeof c.type === "number" ? c.type : null,
      event_type:
        typeof event?.eventType === "number" ? event.eventType : null,
      has_event: Boolean(event),
      faction: campaignFaction(c),
    };
  });
}

/** The campaign's tracked faction — the event's attacker on a defense, the
 * planet's current owner otherwise. The SAME derivation normalizeCampaign and
 * the signature tuples use, so the archived faction stays verifiable. */
function campaignFaction(c: RawCampaign): string | null {
  const event = c.planet.event;
  if (campaignKind(c) === "defense") {
    return typeof event?.faction === "string" ? event.faction : null;
  }
  return typeof c.planet.currentOwner === "string"
    ? c.planet.currentOwner
    : null;
}

function trackableHealth(planet: RawPlanet): number | null {
  const h = planet.event ? planet.event.health : planet.health;
  return typeof h === "number" && Number.isFinite(h) ? h : null;
}

/** The tracked health's ceiling: event.maxHealth on a defense, planet.maxHealth
 * otherwise (mirrors trackableHealth). Stage 12 archive context only. */
function trackableMaxHealth(planet: RawPlanet): number | null {
  const h = planet.event ? planet.event.maxHealth : planet.maxHealth;
  return typeof h === "number" && Number.isFinite(h) ? h : null;
}

function defenseAgeMs(planet: RawPlanet, nowMs: number): number | null {
  if (!planet.event?.startTime) return null;
  const started = Date.parse(planet.event.startTime);
  return Number.isFinite(started) ? Math.max(0, nowMs - started) : null;
}

/**
 * Stage 9: the eta block for one campaign — assembled from facts already in
 * hand, never a second computation path: the distance is the Stage 7
 * orientation (hp_remaining_to_objective), the instantaneous rate is THE
 * sampled hp_per_hour (post data-quality gate, so a degraded record gets
 * reason no_current_rate like every other projection), and the historical
 * trend comes from the SAME retained sample series the single KV read
 * supplied (perIntervalRates — the get_planet_history derivation). A defense
 * gets the competing-clocks block against its deadline.
 */
function campaignEta(
  normalized: NormalizedCampaign,
  samples: HealthSample[],
  timing: DefenseTiming | null,
): EnrichedCampaign["eta"] {
  const inputs = {
    distance: hpRemainingToObjective(normalized.raw_hp),
    instantaneousRate: normalized.hp_per_hour,
    intervalRates: perIntervalRates(samples),
    sampleCount: samples.length,
    samplesSpanHours: seriesSpanHours(samples),
  };
  return timing
    ? buildDefenseEtaBlock({
        ...inputs,
        defenseHoursRemaining: timing.defense_hours_remaining,
      })
    : buildEtaBlock(inputs);
}

/**
 * Stage 10: best-effort raw-side fetch through the SAME fetchUpstream
 * machinery (same host, headers, raw: cache envelope, stale fallback). A
 * /raw failure degrades the cross-check to a reasoned null — it must never
 * block the primary (normalized) response.
 */
async function tryFetchRaw<T>(
  env: Env,
  path: string,
): Promise<
  | { ok: true; data: T; fetchedAt: number; stale: boolean }
  | { ok: false; detail: string }
> {
  try {
    const res = await fetchUpstream<T>(env, path);
    return {
      ok: true,
      data: res.data,
      fetchedAt: res.fetchedAt,
      stale: res.stale,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Feature 5: fetch the full planets list with the warm-cache fallback. On a
 * genuine network fetch (not a plain cache hit) the durable bulk snapshot is
 * refreshed; if the live fetch cannot complete AND the short raw: cache has
 * already evaporated (fetchUpstream throws), the most recent bulk snapshot is
 * served with stale: true instead of hard-failing. Used by get_planet and
 * get_supply_graph (and get_war_status, to keep the snapshot warm). The
 * snapshot feeds adjacency/ownership/HP context only — never the history path.
 */
async function fetchPlanetsWithFallback(env: Env): Promise<{
  planets: RawPlanet[];
  fetchedAt: number;
  /** The ONE planet-provenance enum downstream reads — never `source`/`stale`.
   * Distinguishes a fresh fetch from an expired raw cache (both upstream-served)
   * from the durable snapshot fallback. */
  planet_provenance: PlanetProvenance;
}> {
  try {
    const res = await fetchUpstream<RawPlanet[]>(env, "/api/v1/planets");
    const planets = Array.isArray(res.data) ? res.data : [];
    // Refresh the durable snapshot ONLY on a real upstream fetch — never on a
    // cache hit (that would add a KV write to the hot path) and never on a
    // stale fallback (it carries the older fetchedAt already).
    if (!res.cached && !res.stale && Array.isArray(res.data)) {
      await cacheBulkPlanets(env, planets, res.fetchedAt);
    }
    return {
      planets,
      fetchedAt: res.fetchedAt,
      planet_provenance: planetProvenanceOf("live", res.stale),
    };
  } catch (err) {
    if (err instanceof UpstreamError) {
      const snapshot = await readBulkPlanetsSnapshot<RawPlanet[]>(env);
      if (snapshot && Array.isArray(snapshot.data)) {
        return {
          planets: snapshot.data,
          fetchedAt: snapshot.fetchedAt,
          planet_provenance: planetProvenanceOf("snapshot", true),
        };
      }
    }
    throw err;
  }
}

interface CampaignBundle {
  campaigns: EnrichedCampaign[];
  /** The ONE campaign-provenance enum (single source of truth): 'ok' = fresh
   * live; 'stale' = last-known cache; 'unavailable' = resilient-empty / fetch
   * failed (state UNKNOWN, never "no active campaigns"). The freshness gate and
   * the staleness rollup derive from this via the shared predicates — no
   * separate ok/stale booleans to drift. */
  campaign_provenance: CampaignProvenance;
  /** The tri-state campaign accessor over this bundle — annotation builders
   * consume it so an absent entry is never silently `false`. */
  view: CampaignView;
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
  /** P1: the COMPUTED-BUT-UNWRITTEN sample tick. The loader is side-effect-free
   * — it persists nothing. The handler commits this via commitSampleTick ONLY
   * after all input provenance is known and the all-inputs-live gate passes.
   * Absent when there were no campaign inputs to sample. */
  pendingTick?: PreparedSampleTick;
}

/**
 * P1: SIDE-EFFECT-FREE campaign loader. Fetches + normalizes and computes the
 * sample tick READ-ONLY (one KV read, zero writes); the unwritten tick rides
 * back in `bundle.pendingTick`. The handler decides — after all input
 * provenance is known — whether to commit it (commitCampaignTick). No loader
 * writes, so persistence is order-independent and can never leak a snapshot/
 * resilient-empty observation into the record.
 */
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

  // Campaign provenance: a complete live fetch vs a stale-fallback copy. A
  // successful fetch (even an empty live list) is 'ok' / 'stale'; the
  // resilient-empty 'unavailable' case is set by loadCampaignsResilient's catch.
  const liveFetch =
    !campaignsRes.stale &&
    !assignmentsRes.stale &&
    (warRes ? !warRes.stale : true);
  const campaign_provenance: CampaignProvenance = liveFetch ? "ok" : "stale";
  // The tri-state accessor over THIS bundle — the single way every annotation
  // builder reads campaign/MO membership (absence is never silently `false`).
  const view = campaignView(
    new Map(raw.map((c) => [c.planet.index, campaignKind(c)])),
    moPlanetIndices,
    campaign_provenance,
  );

  const prepared = await prepareSampleTick(
    env,
    raw.map(
      (c): SampleInput => ({
        planetIndex: c.planet.index,
        health: trackableHealth(c.planet),
        campaignId: c.id,
        // Stage 12 archive context — pass-through only; the KV rate path
        // ignores these. kind/faction use the same derivations the normalized
        // payload and signature tuples use, so archived rows stay verifiable.
        maxHealth: trackableMaxHealth(c.planet),
        campaignKind: campaignKind(c),
        faction: campaignFaction(c),
      }),
    ),
    nowMs,
    {
      // Stage 5/8 accumulation layers — folded into the SAME single write.
      // Global statistics are present only on the get_war_status path (the
      // one place the war is fetched); signatures and MO progress fold on
      // every poll (assignments are always part of this fetch set).
      signatures: signatureObservationsFrom(raw),
      globalStatistics: warRes?.data?.statistics ?? null,
      // Stage 11: co-sampled into the same global point (gated, like the
      // statistics, on the war fetch being present). impactMultiplier sits
      // at the war-payload root (verified live 2026-06-11); the campaign
      // count is the length of the same campaigns list this poll fetched.
      globalImpactMultiplier: warRes?.data?.impactMultiplier ?? null,
      globalActiveCampaignCount: campaignsRes.data ? raw.length : null,
      moProgress: moProgressObservations(assignmentsRes.data ?? []),
    },
  );
  const samples = prepared.results;

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
    const eta = campaignEta(normalized, sample?.samples ?? [], timing);
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
      // Stage 5: MO membership via the SAME tri-state accessor the nested
      // annotations use (here the load is live/known, so it resolves boolean).
      is_major_order_target: view.moMembership(c.planet.index) === true,
      major_order_id: moMap.get(c.planet.index) ?? null,
      // Stage 9: dual ETAs (instantaneous + historical) + divergence, from
      // the SAME signed rate and the SAME retained sample series the single
      // KV read already supplied. Defenses get competing depletion ETAs vs
      // the deadline — never a single ETA, never a success prediction.
      eta,
    };
  });

  return {
    campaigns,
    campaign_provenance,
    view,
    assignments: assignmentsRes.data ?? [],
    fetchedAts: [
      campaignsRes.fetchedAt,
      assignmentsRes.fetchedAt,
      ...(warRes ? [warRes.fetchedAt] : []),
    ],
    // The computed-but-unwritten tick — the handler commits it only when ALL
    // inputs are live. Always present (it also carries the global-stats /
    // signature / MO accumulation layers, which advance even when the campaign
    // list is empty); the eligibility gate, not its presence, governs the write.
    pendingTick: prepared,
    ...(warRes ? { war: { data: warRes.data, stale: warRes.stale } } : {}),
  };
}

/**
 * P1: the terminal gated persistence step. Commit the loader's computed-but-
 * unwritten sample tick ONLY when `eligible` — i.e. after the handler has
 * resolved ALL input provenance and confirmed every input is perfectly fresh
 * (the shared allFresh predicate). A loader never calls this; the write happens
 * here, once, order-independently.
 */
async function commitCampaignTick(
  env: Env,
  bundle: CampaignBundle,
  eligible: boolean,
): Promise<void> {
  if (eligible && bundle.pendingTick) {
    await commitSampleTick(env, bundle.pendingTick);
  }
}

/**
 * Cron-driven sampling entry: the Worker's `scheduled` handler (index.ts,
 * fired by the wrangler.toml [triggers] schedule) delegates here. It drives
 * EXACTLY the request path's poll — loadNormalizedCampaigns with the war
 * fetch joined: the same cache/fetch logic, the same 60s minimum sample
 * interval, and the same single merged sample-store write (planet series +
 * signatures + global statistics). P1: the loader is side-effect-free; the
 * cron path performs the terminal gated commit itself (cron fetches no planet
 * list, so its gate is campaign provenance alone — a stale/resilient-empty
 * campaign fetch records nothing). Best-effort by design: an upstream failure
 * is logged and swallowed and the next tick retries.
 */
export async function runScheduledSample(env: Env): Promise<void> {
  try {
    const bundle = await loadNormalizedCampaigns(env, { withWar: true });
    // No planet-list input on the cron path → gate on campaign provenance only
    // (a complete live campaign fetch). Same as allFresh with no planet input.
    await commitCampaignTick(env, bundle, bundle.campaign_provenance === "ok");
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
  const [planetsResult, bundle] = await Promise.all([
    // Feature 5: keep the durable bulk snapshot warm on the most-frequent
    // planets-fetching tool (refresh on a real fetch, fallback on outage).
    fetchPlanetsWithFallback(env),
    loadNormalizedCampaigns(env, { withWar: true }),
  ]);
  const war = bundle.war!.data;
  const planets = planetsResult.planets;

  // P1: single terminal gated commit — only when ALL inputs are perfectly
  // fresh (allFresh). A snapshot/expired-cache planet list or a stale/
  // unavailable campaign fetch records nothing.
  await commitCampaignTick(
    env,
    bundle,
    allFresh(planetsResult.planet_provenance, bundle.campaign_provenance),
  );

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
      [planetsResult.fetchedAt, ...bundle.fetchedAts],
      Date.now(),
    ),
    // Top-level rollup: any input degraded (the shared anyDegraded predicate;
    // campaign provenance already folds in war-fetch staleness). The sample
    // RECORD is gated separately on allFresh, so a stale DISPLAY never means
    // degraded data was recorded.
    ...(anyDegraded(planetsResult.planet_provenance, bundle.campaign_provenance)
      ? { stale: true }
      : {}),
  };
}

export async function getCampaigns(
  env: Env,
  filters: CampaignFilters = {},
): Promise<unknown> {
  const bundle = await loadNormalizedCampaigns(env);
  // P1: terminal gated commit. No planet-list input here → gate on campaign
  // provenance alone (a stale campaign fetch records nothing).
  await commitCampaignTick(env, bundle, bundle.campaign_provenance === "ok");
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
      eta: ETA_NOTE,
      defense_eta: DEFENSE_ETA_NOTE,
      mission_success_rate:
        "Derived per planet as mission_wins / (mission_wins + mission_losses) × 100. Null when no missions are recorded — never 0.",
      defense_hours_remaining:
        "Defense campaigns only: (endTime − now) in hours, clamped at 0 with defense_expired: true once past. A deadline fact, not an urgency judgment.",
      decay_per_hour:
        "regen_per_second × 3600 — regen in the same units as hp_per_hour. Derived from the invariant-normalized regen, so it is always null on defense campaigns (cosmetic decay stays suppressed) and null when regen is unknown.",
      modifier:
        "Decoded special-faction name for event_type, only when the enum value is confirmed in EVENT_MODIFIER_NAMES. event_type non-null with modifier null = an active event whose enum value is not yet confirmed — visible, never named by guess. Both null = no event. Identity only, no difficulty judgment; lore/meaning lives in get_wiki_page.",
      is_major_order_target:
        "Pure membership join against the current Major Order task planet set (the same set HPC detection consumes). major_order_id is the id of the first assignment naming the planet (upstream array order) when it appears in several; null when the planet is in no MO task. A fact, not a priority score.",
      filters:
        "Optional args (faction, major_order_only, has_rate, hpc_only) AND-combine and only narrow the returned array — normalization always runs over the full campaign list first. filtered_count vs total_count states the coverage; no args returns every campaign.",
      units:
        "Unit conventions: *_per_hour fields are per hour; regen_per_second is per second (decay_per_hour is its ×3600 conversion); *_seconds fields are whole seconds; *_hours fields are fractional hours; humanized strings (expires_in, defense_time_remaining) are renderings of an adjacent raw-seconds field, never the only carrier.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom(bundle.fetchedAts, Date.now()),
    // No planet input → rollup is campaign provenance alone.
    ...(bundle.campaign_provenance !== "ok" ? { stale: true } : {}),
  };
}

/**
 * Stage 9: the dual-ETA block for one Major Order objective. Distance =
 * target − progress (the decoded Stage 7 values, clamped at 0 — progress
 * counts UP toward the target, so smaller distance = closer, the same
 * orientation discipline as hp_remaining_to_objective). The instantaneous
 * rate is the LATEST observed per-interval delta of the Stage 8 series; the
 * historical rate is the mean across the retained window — both from the
 * same observed points get_major_order_history serves, never a parallel
 * derivation. No series / a cold start → null ETAs with reasons.
 */
function moObjectiveEta(
  progress: number | null,
  target: number | null,
  series: MoObjectiveSeries | undefined,
): EtaBlock {
  const samples = series?.samples ?? [];
  const rates = moIntervalRates(samples);
  return buildEtaBlock({
    distance:
      progress != null && target != null ? Math.max(0, target - progress) : null,
    instantaneousRate: rates.length > 0 ? rates[rates.length - 1]! : null,
    intervalRates: rates,
    sampleCount: samples.length,
    samplesSpanHours: seriesSpanHours(samples),
  });
}

export async function getMajorOrder(env: Env): Promise<unknown> {
  // Stage 9: the retained MO progress series joins the assignment fetch so
  // each objective can carry its dual ETAs. Read-only on the sample store —
  // one KV read, zero writes (the get_major_order_history discipline).
  const [res, moSeries] = await Promise.all([
    fetchUpstream<RawAssignment[]>(env, "/api/v1/assignments"),
    readMoSeries(env),
  ]);
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
    major_orders: shapeMajorOrders(assignments, Date.now()).map((order) => ({
      ...order,
      objectives: order.objectives.map((objective) => ({
        ...objective,
        // Stage 9: additive eta beside the untouched decode fields.
        eta: moObjectiveEta(
          objective.progress,
          objective.target,
          moSeries.find(
            (s) =>
              s.major_order_id === order.id &&
              s.objective_index === objective.index,
          ),
        ),
      })),
    })),
    notes: {
      objectives: MO_OBJECTIVE_DECODE_NOTE,
      eta: ETA_NOTE,
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

  const [planetsResult, bundle, rawStatus] = await Promise.all([
    // Feature 5: planets via the warm-cache fallback — a live-fetch failure
    // degrades to the most recent bulk snapshot (stale: true), never an error.
    fetchPlanetsWithFallback(env),
    // Feature 5: the campaign bundle degrades to empty if its own fetches
    // fail, so adjacency/ownership/region context still resolves from the
    // planet snapshot rather than hard-failing the whole lookup.
    loadCampaignsResilient(env),
    // Stage 10: the raw ArrowHead status rides the same client/cache path;
    // a /raw failure degrades the cross_check block, never this response.
    tryFetchRaw<RawWarStatus>(env, RAW_STATUS_PATH),
  ]);
  const planets = planetsResult.planets;
  // Feature 1/2: one snapshot index, shared by the outbound/inbound neighbor
  // joins and the gambit inversion. The tri-state campaign accessor (bundle.view)
  // is the ONLY way these builders read campaign/MO membership — never a raw map.
  const planetByIndex = new Map<number, RawPlanet>(
    planets.map((p) => [p.index, p]),
  );
  const view = bundle.view;

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

  // Provenance. `campaignStateKnown` = campaign state is not UNKNOWN; when
  // unknown (outage) it is never "quiet". `live` (= allFresh) is the SINGLE
  // predicate that governs BOTH the write gate and the response `stale` flag.
  const campaignStateKnown = view.known;
  const live = allFresh(
    planetsResult.planet_provenance,
    bundle.campaign_provenance,
  );

  // P1: terminal gated commit of the campaign batch — runs AFTER both inputs'
  // provenance is known. A snapshot-backed get_planet (planetsLive false) now
  // writes NOTHING even when campaigns are fresh: the loader recorded nothing,
  // and this gate suppresses the commit. The quiet-probe write below shares the
  // same `live` gate, so the whole response is read-only unless fully live.
  await commitCampaignTick(env, bundle, live);

  let normalized: NormalizedCampaign;
  let probeSamples: HealthSample[] = [];
  if (active) {
    normalized = active;
  } else if (campaignStateKnown) {
    // Campaign state is KNOWN and this planet has no active campaign — a
    // genuine quiet planet. Probe its health, but PERSIST only on a fully-live
    // observation (P1): a snapshot/stale planet is served, never recorded.
    const nowMs = Date.now();
    const samples = await samplePlanetRates(
      env,
      [
        {
          planetIndex: planet.index,
          health: trackableHealth(planet),
          campaignId: null,
          // Archive context for a quiet-planet probe: no active campaign, so
          // campaign_kind stays null; max_health and the owner faction are
          // still observable facts worth archiving.
          maxHealth: trackableMaxHealth(planet),
          campaignKind: null,
          faction:
            typeof planet.currentOwner === "string"
              ? planet.currentOwner
              : null,
        },
      ],
      nowMs,
      // Single-planet probe: carry the rest of the store forward so one
      // lookup doesn't wipe other planets' series / campaign ages. P1: write
      // nothing unless the probed planet data is a complete live fetch.
      { carryForward: true, persist: live },
    );
    const sample = samples.get(planet.index);
    probeSamples = sample?.samples ?? [];
    normalized = normalizeCampaign(
      { id: -1, planet, type: 0, count: 0, faction: planet.currentOwner },
      {
        hpPerHour: sample?.hpPerHour ?? null,
        campaignAgeMs: defenseAgeMs(planet, nowMs),
        hpcTypes: HPC_CAMPAIGN_TYPES,
        moPlanetIndices: new Set(),
      },
    );
  } else {
    // Campaign state UNKNOWN (outage / resilient-empty). Unknown ≠ quiet: do
    // NOT enter the sampling branch (it would both misclassify AND contaminate
    // the store). Serve READ-ONLY from last-known samples — zero writes.
    const nowMs = Date.now();
    probeSamples = await readPlanetSamples(env, planet.index);
    const knownRates = perIntervalRates(probeSamples);
    const lastKnownRate =
      knownRates.length > 0 ? knownRates[knownRates.length - 1]! : null;
    normalized = normalizeCampaign(
      { id: -1, planet, type: 0, count: 0, faction: planet.currentOwner },
      {
        hpPerHour: lastKnownRate,
        campaignAgeMs: defenseAgeMs(planet, nowMs),
        hpcTypes: HPC_CAMPAIGN_TYPES,
        moPlanetIndices: new Set(),
      },
    );
  }

  // Stage 7: defense timing computed once so the Part B window projection
  // derives from the same clamped hours value the payload itself carries.
  const timing = planet.event ? defenseTiming(planet.event, Date.now()) : null;

  // Stage 9: the campaign's own eta block when one is active (computed once
  // in the loader — never recomputed); otherwise from the probe's series.
  const eta = active ? active.eta : campaignEta(normalized, probeSamples, timing);

  // Stage 10: cross-check the normalized fields THIS payload carries against
  // the raw ArrowHead status. The subject is assembled from the same values
  // returned below, so every check is verifiable in place; a quiet-planet
  // probe makes no campaign_type claim (campaign_id null skips that check).
  const crossCheckMeta: CrossCheckSubject = {
    planet_index: planet.index,
    campaign_id: active ? active.campaign_id : null,
    campaign_kind: normalized.campaign_kind,
    campaign_type: active ? active.campaign_type : null,
    current_owner: planet.currentOwner ?? null,
    raw_hp: normalized.raw_hp,
    max_hp: normalized.max_hp,
    regen_per_second: normalized.regen_per_second,
    liberation_pct_display_only: normalized.liberation_pct_display_only,
    event_type: planet.event?.eventType ?? null,
    player_count: planet.statistics?.playerCount ?? null,
  };
  const cross_check = rawStatus.ok
    ? buildCrossCheckBlock(crossCheckMeta, rawStatus.data, {
        normalizedFetchedAtMs: Math.min(
          planetsResult.fetchedAt,
          ...bundle.fetchedAts,
        ),
        rawFetchedAtMs: rawStatus.fetchedAt,
        rawStale: rawStatus.stale,
      })
    : unavailableCrossCheck("raw_unavailable", rawStatus.detail);

  // Feature 1: outbound (existing) + inbound (inverted) adjacency over the same
  // snapshot, plus the combined summary with the borders_super_earth fact.
  const adjacency = buildNeighbors(planet, planetByIndex, view);
  const inbound_neighbors = buildInboundNeighbors(planet, planetByIndex, view);
  const adjacency_summary = buildAdjacencySummary(
    adjacency.neighbors,
    inbound_neighbors,
  );

  // Item 4: which active campaigns lose their sole Super Earth warp link if
  // this planet flips owner — a deterministic one-hop fact over the same
  // observed edge set the supply graph serves, read through the tri-state
  // accessor (null, never [], when campaign state is unknown).
  const isolation_risk = buildIsolationRisk(
    planet,
    planetByIndex,
    buildReverseAdjacency(planets),
    view,
  );

  // Feature 2: defense gambit origin(s) — the planet(s) attacking this defense,
  // from the inverted source→target pairs. Raw state + tri-state MO membership
  // (null, never false, when campaign state is unknown).
  const gambitFields: Record<string, unknown> = {};
  if (planet.event) {
    const origins = buildGambitOrigins(planet, planetByIndex, view);
    if (origins.length === 0) {
      gambitFields.gambit_origin = null;
      gambitFields.gambit_origin_reason = "no_attack_origin_in_raw";
    } else if (origins.length === 1) {
      gambitFields.gambit_origin = origins[0];
    } else {
      gambitFields.gambit_origins = origins;
    }
  }

  // Feature 3: per-player effective rates, consuming the SAME signed
  // hp_per_hour and the invariant-1 normalized decay (defense decay stays null).
  const per_player_rates = perPlayerRates({
    hpPerHour: normalized.hp_per_hour,
    decayPerHour: decayPerHour(normalized.regen_per_second),
    campaignKind: normalized.campaign_kind,
    playerCount: planet.statistics?.playerCount ?? null,
  });

  // Feature 4: faithful per-region/city passthrough (isolated — a schema
  // surprise here cannot affect features 1–3 above).
  const regionInfo = selectRegions(planet.regions);

  // Campaign-derived CLASSIFICATION fields come from the synthetic `normalized`
  // record, which DEFAULTS a kind/trajectory even when the campaign overlay is
  // unavailable (a non-event planet defaults to 'liberation'). When campaign
  // state is UNKNOWN, null them ALL uniformly at this single locus — so nothing
  // can assert a kind/direction/HPC the sibling has_active_campaign:null /
  // campaign_state_known:false already disclaim, and a future field added here
  // is gated in one place (no sibling leak). Planet-state facts (HP, regen,
  // lib%, projection math) are NOT campaign-derived and ride through unchanged.
  const campaignDerived = campaignStateKnown
    ? {
        campaign_kind: normalized.campaign_kind,
        win_condition: winCondition(normalized.campaign_kind),
        direction: normalized.direction,
        alert: normalized.alert,
        stabilizing: normalized.stabilizing,
        hpc: normalized.hpc,
        ...(normalized.hpc_note ? { hpc_note: normalized.hpc_note } : {}),
      }
    : {
        campaign_kind: null,
        win_condition: null,
        direction: null,
        alert: null,
        stabilizing: null,
        hpc: null,
      };

  return {
    planet_index: planet.index,
    planet_name: planet.name,
    sector: planet.sector,
    current_owner: planet.currentOwner,
    initial_owner: planet.initialOwner,
    // Output honesty via the tri-state accessor: when campaign state is UNKNOWN
    // (outage) has_active_campaign is null (never false), campaign_state_known
    // is false. The accessor is the SAME one the nested neighbor/gambit
    // annotations consume, so the planet and its neighbors can never disagree.
    has_active_campaign: view.hasActiveCampaign(planet.index),
    campaign_state_known: campaignStateKnown,
    // Campaign-derived classification (campaign_kind / win_condition /
    // direction / alert / stabilizing / hpc[/ _note]) — all null when campaign
    // state is unknown (see campaignDerived above).
    ...campaignDerived,
    raw_hp: normalized.raw_hp,
    max_hp: normalized.max_hp,
    hp_per_hour: normalized.hp_per_hour,
    regen_per_second: normalized.regen_per_second,
    // Stage 3: derived from the invariant-1 normalized regen above — a
    // defense planet can never re-expose its cosmetic decay here.
    decay_per_hour: decayPerHour(normalized.regen_per_second),
    liberation_pct_display_only: normalized.liberation_pct_display_only,
    // Stage 7, Part A: objective-relative distance to the win state (a
    // planet-HP fact, smaller = closer); orientation rides win_condition above.
    hp_remaining_to_objective: hpRemainingToObjective(normalized.raw_hp),
    hours_to_resolution: normalized.hours_to_resolution,
    projection_status: normalized.status,
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
          // Feature 2: the attack origin(s) the consumer can clear to end the
          // defense — raw state only, never a viability/timing verdict.
          ...gambitFields,
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
    // Stage 9: dual ETAs + divergence (competing depletion ETAs vs the
    // deadline on a defense) — projections under stated assumptions only.
    eta,
    player_count: planet.statistics?.playerCount ?? null,
    // Feature 3: per-player effective rates beside the gross hp_per_hour.
    per_player_rates,
    statistics: selectPlanetStatistics(planet.statistics),
    biome: selectBiome(planet.biome),
    hazards: selectHazards(planet.hazards),
    // Feature 4: per-region/city sub-objectives (regions / regions_available /
    // has_city_region) — faithful passthrough, no derived contribution math.
    ...regionInfo,
    // Stage 5: waypoint neighbors joined against data already in hand — the
    // full planets list and the active campaign set. Adds neighbors,
    // neighbor_summary, frontline.
    ...adjacency,
    // Feature 1: the inverted (inbound) waypoint set + the combined adjacency
    // summary with the borders_super_earth fact. Existing `neighbors`
    // (outbound) is unchanged.
    inbound_neighbors,
    adjacency_summary,
    // Item 4: the sole-Super-Earth-link dependency fact (see notes).
    isolation_risk,
    // Stage 10: normalized-vs-raw verification block — surfaced
    // disagreement is data; no side is ever picked or averaged.
    cross_check,
    notes: {
      hp_per_hour: RATE_SIGN_NOTE,
      direction: DIRECTION_NOTE,
      win_condition: WIN_CONDITION_NOTE,
      liberation_pct_display_only: LIBERATION_PCT_NOTE,
      cross_check: CROSS_CHECK_NOTE,
      defense_window: DEFENSE_WINDOW_NOTE,
      eta: ETA_NOTE,
      defense_eta: DEFENSE_ETA_NOTE,
      ...(campaignStateKnown
        ? {}
        : {
            campaign_state_known:
              "Campaign/assignment data could not be fetched this request (outage), so campaign state is UNKNOWN — has_active_campaign is null (never asserted false), campaign_kind/eta reflect last-known or synthetic state, and NOTHING was recorded to the history store. stale: true. Retry when upstream recovers.",
          }),
      neighbors:
        "Upstream's own waypoints array for this planet, in upstream order — joined by index against the full planets list and the active campaign set, never symmetrized or rerouted (direction semantics are upstream's). A dangling index still counts in neighbor_summary.total with name/owner null, tallied under by_owner.unknown.",
      frontline:
        "Deterministic adjacency fact: true iff at least one neighbor has a known owner different from this planet's current_owner — 'borders territory of a different owner', nothing more. Not a strategic judgment; neighbors with unknown owners never set it.",
      inbound_neighbors: INBOUND_NEIGHBORS_NOTE,
      isolation_risk: ISOLATION_RISK_NOTE,
      ...(planet.event ? { gambit_origin: GAMBIT_ORIGIN_NOTE } : {}),
      per_player_rates: PER_PLAYER_RATES_NOTE,
      regions: REGIONS_NOTE,
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom(
      [planetsResult.fetchedAt, ...bundle.fetchedAts],
      Date.now(),
    ),
    // P1 predicate unity: `stale: true` is exactly `!live` — the SAME condition
    // that gated the quiet-probe write above. A stale response recorded
    // nothing; a response that recorded was not stale.
    ...(!live ? { stale: true } : {}),
  };
}

/**
 * Feature 5 + P1: load the normalized campaign bundle, degrading to a
 * resilient-empty bundle (`campaign_provenance: 'unavailable'`) when its own
 * upstream fetches cannot complete. This lets get_planet still answer
 * adjacency/ownership/region questions from the planet snapshot during an
 * outage instead of hard-failing. 'unavailable' means campaign state is UNKNOWN
 * (not "no active campaigns"): the tri-state view returns 'unknown' for every
 * planet, so callers neither persist against it nor emit has_active_campaign as
 * a fact.
 */
async function loadCampaignsResilient(env: Env): Promise<CampaignBundle> {
  try {
    return await loadNormalizedCampaigns(env);
  } catch {
    return {
      campaigns: [],
      campaign_provenance: "unavailable",
      view: campaignView(new Map(), new Set(), "unavailable"),
      assignments: [],
      fetchedAts: [],
    };
  }
}

/**
 * Feature 1: the supply-line graph tool. Default (no args) returns the
 * active-campaign subgraph (every active-campaign planet plus its one-hop
 * inbound+outbound neighbors); full: true returns the whole galaxy. Edges are
 * ONLY observed waypoints (observed: true) — no implied reverse edges.
 *
 * READ-ONLY: this tool records nothing (the campaign load is forced
 * persist:false), so no fallback path can ever sample. Staleness names its
 * SOURCE via a structured `provenance` block — planet-list provenance
 * (topology) and campaign-overlay provenance (annotations + active-only
 * selection) are independent, so a campaign-only outage is no longer
 * mislabeled as a planet-snapshot fallback. Topology stays complete under a
 * campaign outage; only the annotations and the active-only selection degrade.
 */
export async function getSupplyGraph(
  env: Env,
  args: {
    root?: number | string;
    depth?: number;
    active_only?: boolean;
    full?: boolean;
  } = {},
): Promise<unknown> {
  const [planetsResult, bundle] = await Promise.all([
    fetchPlanetsWithFallback(env),
    // Read-only: the loader is side-effect-free and this tool never commits the
    // tick — a topology/overlay query never drives the sampling cadence.
    loadCampaignsResilient(env),
  ]);
  const planets = planetsResult.planets;

  // The two provenance enums — the single source of truth. Everything below
  // (overlay, reasons, rollup, selection) derives MECHANICALLY from these; no
  // separately-maintained booleans drift out of sync.
  const planetProvenance = planetsResult.planet_provenance;
  const campaigns = bundle.campaign_provenance;
  const campaignStateKnown = campaigns !== "unavailable";
  const overlay: "complete" | "degraded" | "unavailable" =
    campaigns === "ok" ? "complete" : campaigns === "stale" ? "degraded" : "unavailable";
  const campaignOutage = campaigns === "unavailable";

  // Reasons derived mechanically from the two enums (provenance module).
  const reasons = provenanceReasons(planetProvenance, campaigns);

  // Resolve an optional root (index or name) — a near-miss surfaces ranked
  // candidates, never a silent substitution (the resolve_planet discipline).
  let rootIndex: number | null = null;
  if (typeof args.root === "number" && Number.isFinite(args.root)) {
    if (!planets.some((p) => p.index === args.root)) {
      throw new ToolError(
        `Planet not found for root index ${args.root}. Valid indices are 0–${Math.max(
          0,
          planets.length - 1,
        )}, or pass a name / omit root for the active-campaign subgraph.`,
      );
    }
    rootIndex = args.root;
  } else if (typeof args.root === "string" && args.root.trim()) {
    const resolution = resolvePlanetName(args.root, planets);
    if (resolution.matched) {
      rootIndex = resolution.planet!.index;
    } else {
      const list = resolution.candidates
        .map((c) => `${c.name} (index ${c.index})`)
        .join(", ");
      throw new ToolError(
        `Planet not found for root "${args.root}".` +
          (list ? ` Did you mean: ${list}?` : "") +
          " Retry with one of these names or an index, or call resolve_planet.",
      );
    }
  }

  const depth = Math.min(3, Math.max(1, Math.floor(args.depth ?? 1)));
  const activeOnly = Boolean(args.active_only);
  const full = Boolean(args.full);
  // A default (active-campaign) selection cannot be trusted under a campaign
  // outage — the active set is UNKNOWN, not empty. Return the full topology
  // instead, flagged campaign_state_known:false, rather than a bare empty node
  // set that would read as "no active campaigns". Topology is unaffected by a
  // campaign outage; only the annotations degrade.
  const defaultSelection = rootIndex == null && !full;
  const effectiveFull = full || (defaultSelection && campaignOutage);
  const graph = buildSupplyGraph(planets, bundle.view, {
    rootIndex,
    depth,
    activeOnly,
    full: effectiveFull,
  });
  // P2: active_only requested but skipped (campaign state unknown) — say so, so
  // the full topology returned isn't mistaken for "filter applied, empty".
  if (activeOnly && !graph.active_only_applied) {
    reasons.push("active_only_filter_skipped_campaign_state_unknown");
  }

  const scope = full
    ? "full_galaxy"
    : rootIndex != null
      ? "root_subgraph"
      : campaignOutage
        ? "active_campaign_subgraph_unknown" // topology returned, active set unknown
        : "active_campaign_subgraph";

  return {
    scope,
    ...(rootIndex != null ? { root_index: rootIndex } : {}),
    depth,
    active_only: activeOnly,
    // P2: whether the active_only deletion actually ran (false = requested but
    // skipped because campaign state was unknown — full topology returned).
    active_only_applied: graph.active_only_applied,
    full,
    // Split provenance — staleness names its source(s). The three-state
    // planet_provenance covers the expired-cache case (live but stale); the
    // back-compat booleans are DERIVED from the enums, never stored separately.
    provenance: {
      planet_provenance: planetProvenance,
      planet_stale: planetProvenance !== "live_fresh",
      planet_source:
        planetProvenance === "snapshot_fallback" ? "snapshot" : "live",
      planet_snapshot_used: planetProvenance === "snapshot_fallback",
      campaigns,
      campaign_outage: campaignOutage,
      reasons,
    },
    // The active-overlay consequence stated explicitly.
    active_campaign_overlay: overlay,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    nodes: graph.nodes,
    edges: graph.edges,
    notes: {
      supply_graph: SUPPLY_GRAPH_NOTE,
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom([planetsResult.fetchedAt, ...bundle.fetchedAts], Date.now()),
    // Top-level `stale` is the shared anyDegraded rollup (back-compat): true
    // when ANY input was not perfectly fresh. `provenance` names which. The tool
    // records nothing on any path, so this never implies degraded persistence.
    ...(anyDegraded(planetProvenance, campaigns) ? { stale: true } : {}),
  };
}

/**
 * Stage 4: the LORE tool — a standalone source (helldivers.wiki.gg), never a
 * field on a live tool. Fetches any wiki page by `title` (weapon, warbond,
 * stratagem, enemy/subfaction, booster, passive, mission, biome, planet, …);
 * `full: true` returns the raw page wikitext instead of the intro extract.
 * The caller supplies the exact page title — no planet-index resolution. The
 * payload carries mandatory attribution and contains no live war-state numbers.
 */
export async function getWikiPage(
  env: Env,
  args: { title?: string; full?: boolean },
): Promise<unknown> {
  const title = args.title?.trim();
  if (!title) {
    throw new ToolError(
      'Provide a wiki page `title` (string), e.g. title: "Eruptor", title: "Democratic Detonation", or title: "Jet Brigade".',
    );
  }
  return fetchWikiPage(env, { title, full: args.full === true });
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
      impact_multiplier:
        "Stage 11: the raw upstream war.impactMultiplier observed at sample time, with active_campaign_count (campaigns-list length) co-sampled beside it. Points stored before these fields existed read as null — never backfilled. Raw observed series only; any relationship between the multiplier, player count, and campaign count is for the consumer to read off the curves — the server computes no correlation, model, or prediction.",
    },
  };
}

/**
 * Stage 8: the retained Major Order objective-progress series with raw
 * observed deltas — one bounded series per {major_order_id, objective_index},
 * sampled passively inside the existing single sample-store write on every
 * campaign poll (and every cron tick). Read-only here: one assignments fetch
 * (shared 45s cache, to know the active MO ids) + one KV read, ZERO sample-
 * store writes. No args → every series of the currently active MO(s); a
 * prior MO's series is retained until it ages out and stays queryable by
 * major_order_id. Observed points and deterministic deltas only — never a
 * forecast, required pace, or on-track/behind verdict; that judgment belongs
 * to the conversation layer.
 */
export async function getMajorOrderHistory(
  env: Env,
  args: { major_order_id?: number; objective_index?: number },
): Promise<unknown> {
  const res = await fetchUpstream<RawAssignment[]>(env, "/api/v1/assignments");
  const assignments = res.data ?? [];
  const activeIds = assignments
    .map((a) => a.id)
    .filter((id): id is number => typeof id === "number" && Number.isFinite(id));

  // Read-only: history never writes to the sample store.
  const retained = await readMoSeries(env);
  const retainedIds = [...new Set(retained.map((s) => s.major_order_id))];

  const requestedId = args.major_order_id;
  const wanted = retained.filter(
    (s) =>
      (requestedId != null
        ? s.major_order_id === requestedId
        : activeIds.includes(s.major_order_id)) &&
      (args.objective_index == null ||
        s.objective_index === args.objective_index),
  );
  const series = wanted
    .sort(
      (a, b) =>
        a.major_order_id - b.major_order_id ||
        a.objective_index - b.objective_index,
    )
    .map((s) => {
      // Stage 9: eta rides BESIDE the untouched observed-series shape —
      // distance from the series' own latest progress/target, rates from the
      // same retained points the samples array shows (verifiable in place).
      const shaped = buildMoHistorySeries(s);
      return {
        ...shaped,
        eta: moObjectiveEta(shaped.latest_progress, shaped.target, s),
      };
    });

  let note: string | undefined;
  if (series.length === 0) {
    if (requestedId != null) {
      note = `No retained series for major_order_id ${requestedId}${args.objective_index != null ? ` / objective_index ${args.objective_index}` : ""}. Retained ids are listed in retained_major_order_ids; a Major Order's series exists only while this server sampled it and ages out ${MAX_SAMPLE_AGE_MS / 3_600_000}h after its last sample.`;
    } else if (activeIds.length === 0) {
      note =
        "No active Major Order right now — there is no current-MO series to return (not an error). A prior MO's retained series (see retained_major_order_ids) can still be requested by major_order_id until it ages out.";
    } else {
      note =
        "No progress samples retained for the active Major Order yet. Samples accrue whenever this server polls campaigns (get_war_status, get_campaigns, get_planet, get_war_brief, and the 10-minute cron) — a cold start is expected to be empty, not an error, and populates after two polls >60s apart.";
    }
  }

  return {
    active_major_order: activeIds.length > 0,
    active_major_order_ids: activeIds,
    retained_major_order_ids: retainedIds,
    ...(requestedId != null
      ? {
          requested: {
            major_order_id: requestedId,
            ...(args.objective_index != null
              ? { objective_index: args.objective_index }
              : {}),
          },
        }
      : {}),
    series_count: series.length,
    series,
    ...(note ? { note } : {}),
    retention: {
      max_points_per_objective: MAX_MO_SAMPLES,
      max_age_hours: MAX_SAMPLE_AGE_MS / 3_600_000,
      max_series: MAX_MO_SERIES,
      note: `Bounded like the planet/global series (oldest evicted first). On MO turnover the prior MO's series stops accruing and is retained as historical record until its samples age out; the combined store key carries a ${SAMPLES_KEY_TTL_SECONDS / 86_400}-day KV TTL refreshed on every poll.`,
    },
    notes: {
      sampling:
        "Observed Major Order objective progress sampled by this server on its poll cadence (request polls + the 10-minute cron), timestamped on the Worker clock. progress and target are the SAME Stage-7-decoded values get_major_order returns (target = the first valueType-3 'goal' slot) — one decode, so every sample is verifiable against the live MO payload. A value missing upstream is null at that point, never 0; a new sample appends only when the previous one is >60s old.",
      deltas:
        "delta_progress / delta_hours are raw differences between consecutive OBSERVATIONS — what was seen between two samples, never a projection. No forecast, completion estimate, required pace, or on-track/behind verdict exists anywhere in this payload by design: pace and completion judgment belong to the consumer, grounded on these observed points.",
      progress_pct:
        "latest_progress / target × 100, from the newest sample — deterministic; null when the target is 0 or unknown or progress is unknown (never a divide-by-zero, never a fabricated denominator).",
      objective_kind:
        "Decoded from the stored raw task_type only for enum values confirmed against live Major Orders (TASK_TYPE_NAMES); an unconfirmed type keeps its raw number with objective_kind null — a name is never fabricated.",
      eta: ETA_NOTE,
      turnover:
        "Series are keyed by major_order_id + objective_index, each objective tracked independently. When a Major Order is replaced, its series stop accruing but remain queryable by major_order_id until they age out; the new MO starts fresh series — points are never mixed across MO ids.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom([res.fetchedAt], Date.now()),
    ...(res.stale ? { stale: true } : {}),
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
  // getWarBrief reads planets via the plain cache (never the durable snapshot),
  // so its planet provenance is live_fresh or live_expired_cache.
  const planetProvenance = planetProvenanceOf("live", planetsRes.stale);

  // P1: single terminal gated commit — every input perfectly fresh (allFresh).
  await commitCampaignTick(
    env,
    bundle,
    allFresh(planetProvenance, bundle.campaign_provenance),
  );

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
    // Top-level rollup: any input degraded (shared anyDegraded; campaign
    // provenance folds in war-fetch staleness). The RECORD is gated separately
    // on allFresh, so a stale brief never means degraded data was recorded.
    ...(anyDegraded(planetProvenance, bundle.campaign_provenance)
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

/**
 * Stage 10: the normalization-faithfulness health check — every active
 * campaign and Major Order objective cross-checked against the raw ArrowHead
 * payloads (the wrapper's /raw endpoints: same host, auth, and cache as
 * every other fetch). Returns deterministic tallies (agreements, unexpected
 * disagreements excluding the documented expected transforms, uncheckable
 * fields) plus the specific divergent fields with BOTH values and the diff.
 * Pure observation: no verdict on which side is right exists anywhere — a
 * divergence is surfaced for the consumer to interpret. Fetch budget: the
 * normalized side is exactly a get_campaigns poll (same shared cache, same
 * single sample-store write); the raw side is two read-through-cached
 * fetches with zero additional sample-store writes.
 */
export async function getSourceCrossCheck(env: Env): Promise<unknown> {
  const [planetsRes, bundle, rawStatus, rawAssignments] = await Promise.all([
    fetchUpstream<RawPlanet[]>(env, "/api/v1/planets"),
    loadNormalizedCampaigns(env),
    tryFetchRaw<RawWarStatus>(env, RAW_STATUS_PATH),
    tryFetchRaw<RawWarStatusAssignment[]>(env, RAW_ASSIGNMENT_PATH),
  ]);
  // P1: terminal gated commit — all inputs perfectly fresh (allFresh).
  await commitCampaignTick(
    env,
    bundle,
    allFresh(
      planetProvenanceOf("live", planetsRes.stale),
      bundle.campaign_provenance,
    ),
  );
  const planetByIndex = new Map(
    (planetsRes.data ?? []).map((p) => [p.index, p]),
  );
  const normalizedFetchedAtMs = Math.min(
    planetsRes.fetchedAt,
    ...bundle.fetchedAts,
  );

  let campaignsSection: unknown;
  if (rawStatus.ok) {
    const allChecks: CrossCheckField[] = [];
    const divergent: ({ planet_index: number; planet_name: string } & CrossCheckField)[] =
      [];
    for (const c of bundle.campaigns) {
      const planet = planetByIndex.get(c.planet_index);
      const checks = crossCheckSubject(
        {
          planet_index: c.planet_index,
          campaign_id: c.campaign_id,
          campaign_kind: c.campaign_kind,
          campaign_type: c.campaign_type,
          // The planet's verbatim currentOwner (a defense campaign's
          // `faction` is the ATTACKER, not the owner — different fact).
          current_owner: planet?.currentOwner ?? null,
          raw_hp: c.raw_hp,
          max_hp: c.max_hp,
          regen_per_second: c.regen_per_second,
          liberation_pct_display_only: c.liberation_pct_display_only,
          event_type: c.event_type,
          player_count: c.statistics?.player_count ?? null,
        },
        rawStatus.data,
      );
      allChecks.push(...checks);
      for (const check of checks) {
        if (check.agrees === false) {
          divergent.push({
            planet_index: c.planet_index,
            planet_name: c.planet_name,
            ...check,
          });
        }
      }
    }
    campaignsSection = {
      available: true,
      raw_source: RAW_STATUS_PATH,
      campaigns_checked: bundle.campaigns.length,
      ...summarizeChecks(allChecks),
      divergent_fields: divergent,
      // Campaign-set membership on one side only — reported, never dropped.
      unmatched: unmatchedCampaigns(
        bundle.campaigns.map((c) => c.planet_index),
        rawStatus.data,
      ),
      normalized_as_of: new Date(normalizedFetchedAtMs).toISOString(),
      raw_as_of: new Date(rawStatus.fetchedAt).toISOString(),
      ...(rawStatus.stale ? { raw_stale: true } : {}),
    };
  } else {
    campaignsSection = {
      available: false,
      raw_source: RAW_STATUS_PATH,
      reason: "raw_unavailable",
      detail: rawStatus.detail,
    };
  }

  let majorOrdersSection: unknown;
  if (rawAssignments.ok) {
    const perAssignment = crossCheckAssignments(
      bundle.assignments,
      rawAssignments.data ?? [],
    );
    const allChecks = perAssignment.flatMap((a) => a.checked);
    majorOrdersSection = {
      available: true,
      raw_source: RAW_ASSIGNMENT_PATH,
      assignments_checked: perAssignment.length,
      ...summarizeChecks(allChecks),
      divergent_fields: perAssignment.flatMap((a) =>
        a.checked
          .filter((check) => check.agrees === false)
          .map((check) => ({ major_order_id: a.major_order_id, ...check })),
      ),
      unmatched_assignments: perAssignment
        .filter((a) => !a.matched_in_raw)
        .map((a) => a.major_order_id),
      normalized_as_of: new Date(normalizedFetchedAtMs).toISOString(),
      raw_as_of: new Date(rawAssignments.fetchedAt).toISOString(),
      ...(rawAssignments.stale ? { raw_stale: true } : {}),
    };
  } else {
    majorOrdersSection = {
      available: false,
      raw_source: RAW_ASSIGNMENT_PATH,
      reason: "raw_unavailable",
      detail: rawAssignments.detail,
    };
  }

  return {
    campaigns: campaignsSection,
    major_orders: majorOrdersSection,
    notes: {
      purpose:
        "Normalization-faithfulness health check: the server's normalized fields verified against the raw ArrowHead payloads they derive from (the wrapper's /raw endpoints — same host, auth, and cache as every other fetch; not a new provider). Counts and the specific divergent fields only — no verdict on which side is right, ever.",
      cross_check: CROSS_CHECK_NOTE,
      unexpected_disagreements:
        "Fields where both sides have a value and they differ beyond the documented tolerance — EXCLUDING the expected transforms (defense decay force-nulled by invariant 1, liberation % recomputed by invariant 2), which are normalization doing its job. A non-zero count can also reflect fetch-moment skew between the two cached payloads (live values move) — the normalized_as_of / raw_as_of timestamps expose that; interpreting a divergence is the consumer's.",
      uncheckable:
        "Fields with no counterpart on one side (e.g. liberation max_hp — the raw status carries event maxHealth only) or an unconfirmed raw enum value — agrees: null with a reason, never counted as a mismatch.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom([planetsRes.fetchedAt, ...bundle.fetchedAts], Date.now()),
    // Shared anyDegraded rollup over both inputs.
    ...(anyDegraded(
      planetProvenanceOf("live", planetsRes.stale),
      bundle.campaign_provenance,
    )
      ? { stale: true }
      : {}),
  };
}

/* ------------------------------------------------------------------------
 * Stage 12: the D1 archive tools — the long-range counterpart to the KV
 * history tools. The KV history tools (get_planet_history /
 * get_global_history / get_major_order_history) stay the fast recent-window
 * view and are UNCHANGED; these read the unbounded D1 archive instead. Same
 * honesty discipline throughout: observed points and raw consecutive deltas
 * only — insufficient_history below two points, null deltas at series start,
 * NO forecast, NO trend verdict. KV remains the source of truth for all live
 * logic; the archive serves a different (longer) time range and the two never
 * reconcile.
 * ---------------------------------------------------------------------- */

const ARCHIVE_RETENTION_NOTE =
  "The D1 archive is append-only and effectively unbounded (Cloudflare D1 free tier: 5 GB) — it is the long-term counterpart to the KV history tools' bounded recent window. Rows accrue one per sample tick (request polls + the 10-minute cron); a within-60s replay never duplicates a row.";

const ARCHIVE_SAMPLING_NOTE =
  "Observed data points and deterministic consecutive deltas only — no smoothing, no forecast, no trend verdict. Sample timestamps use the Worker clock (upstream war time is game-epoch and not comparable). These are the SAME observations the KV history tools serve, persisted durably; the two views can differ only by time range, never by interpretation.";

const ARCHIVE_WINDOW_NOTE =
  "The window has BOTH edges: since_hours (start, hours back from now — default 168) and optional until_hours (end, hours back from now; omit for 'up to now'). since_hours must be LARGER than until_hours (further back). With more rows in the window than `limit`, the NEWEST rows are returned — page backward through older history by walking until_hours outward (e.g. since_hours: 400, until_hours: 200, then 600/400, …); adjacent slices reconstruct the full table.";

/**
 * Item 2: resolve the two-edged archive window from the tool args. The upper
 * edge is optional (absent = up to now); an inverted pair (until further back
 * than since) is an empty window and rejected loudly rather than returning [].
 */
function archiveWindow(
  args: { since_hours?: number; until_hours?: number },
  nowMs: number,
): { sinceMs: number; untilMs: number | null } {
  const sinceMs = sinceCutoffMs(args.since_hours, nowMs);
  const untilMs = untilCutoffMs(args.until_hours, nowMs);
  if (untilMs != null && sinceMs > untilMs) {
    throw new ToolError(
      `Empty window: since_hours (${args.since_hours ?? ARCHIVE_DEFAULT_SINCE_HOURS}) must be LARGER than until_hours (${args.until_hours}) — both count hours back from now, so the window start must lie further back than its end.`,
    );
  }
  return { sinceMs, untilMs };
}

/**
 * Stage 12: a planet's UNBOUNDED observed health series from the D1 archive —
 * the long-range counterpart to get_planet_history's recent KV window. Resolves
 * the planet by index or name (one planets fetch, shared cache), then reads the
 * archive within the requested window (default last 7 days), capped at
 * ARCHIVE_MAX_LIMIT rows. Observed points + raw deltas only, never a forecast.
 */
export async function getPlanetArchive(
  env: Env,
  args: {
    index?: number;
    name?: string;
    since_hours?: number;
    until_hours?: number;
    limit?: number;
  },
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

  const nowMs = Date.now();
  const limit = clampLimit(args.limit);
  const { sinceMs, untilMs } = archiveWindow(args, nowMs);
  const rows = await readPlanetArchive(
    env,
    planet.index,
    sinceMs,
    limit,
    untilMs,
  );
  const points = buildPlanetArchivePoints(rows);
  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    planet_index: planet.index,
    planet_name: planet.name,
    source: "d1_archive",
    since_hours: args.since_hours ?? ARCHIVE_DEFAULT_SINCE_HOURS,
    ...(args.until_hours != null ? { until_hours: args.until_hours } : {}),
    limit,
    max_limit: ARCHIVE_MAX_LIMIT,
    truncated: rows.length === limit,
    points: points.length,
    window_hours:
      first && last && rows.length >= 2
        ? (last.sampled_at - first.sampled_at) / 3_600_000
        : null,
    samples: points,
    insufficient_history: points.length < 2,
    ...(points.length < 2
      ? {
          note:
            points.length === 0
              ? "No archived samples for this planet in the requested window. The archive fills one tick at a time once the server is polling (and after the D1 migration is applied) — a cold start, a too-narrow since_hours, or a planet never in an active campaign is expected to be empty, not an error."
              : "Only one archived sample in the window; deltas need at least two samples >60s apart. Widen since_hours or wait for more ticks.",
        }
      : {}),
    notes: {
      delta_health:
        "Raw observed change per point: current − previous health (negative = health depleting). hp_per_hour stored on each point uses the opposite orientation, (previous − current) / hours, positive = progressing toward resolution. Both conventions apply to defense campaigns identically (the tracked health is the EVENT health, which depletes toward zero while the defense is won).",
      hp_per_hour: RATE_SIGN_NOTE,
      window: ARCHIVE_WINDOW_NOTE,
      sampling: ARCHIVE_SAMPLING_NOTE,
      retention: ARCHIVE_RETENTION_NOTE,
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom([planetsRes.fetchedAt, campaignsRes.fetchedAt], nowMs),
    ...(planetsRes.stale || campaignsRes.stale ? { stale: true } : {}),
  };
}

/**
 * Stage 12: the UNBOUNDED global war-statistics series from the D1 archive —
 * the long-range counterpart to get_global_history. This is the view that
 * answers the impact-multiplier-vs-population question over days, not hours.
 * Observed points + raw deltas only; any relationship between the curves is the
 * consumer's to read off — the server computes no correlation or model.
 */
export async function getGlobalArchive(
  env: Env,
  args: { since_hours?: number; until_hours?: number; limit?: number },
): Promise<unknown> {
  const nowMs = Date.now();
  const limit = clampLimit(args.limit);
  const { sinceMs, untilMs } = archiveWindow(args, nowMs);
  const rows = await readGlobalArchive(env, sinceMs, limit, untilMs);
  const points = buildGlobalArchivePoints(rows);
  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    source: "d1_archive",
    since_hours: args.since_hours ?? ARCHIVE_DEFAULT_SINCE_HOURS,
    ...(args.until_hours != null ? { until_hours: args.until_hours } : {}),
    limit,
    max_limit: ARCHIVE_MAX_LIMIT,
    truncated: rows.length === limit,
    points: points.length,
    window_hours:
      first && last && rows.length >= 2
        ? (last.sampled_at - first.sampled_at) / 3_600_000
        : null,
    samples: points,
    insufficient_history: points.length < 2,
    ...(points.length < 2
      ? {
          note:
            points.length === 0
              ? "No archived global samples in the requested window. Global samples accrue only on get_war_status / get_war_brief polls and the cron (the paths that fetch the war state) — a cold start or too-narrow since_hours is expected to be empty, not an error."
              : "Only one archived global sample in the window; deltas need at least two samples >60s apart.",
        }
      : {}),
    notes: {
      sampling: ARCHIVE_SAMPLING_NOTE,
      window: ARCHIVE_WINDOW_NOTE,
      impact_multiplier:
        "The raw upstream war.impactMultiplier observed at sample time, with active_campaign_count co-sampled beside it. Over a multi-day window the daily population cycle and the multiplier relationship become legible — but any correlation, model, or prediction relating them is for the consumer to read off the curves; the server computes none.",
      retention: ARCHIVE_RETENTION_NOTE,
    },
    queried_at: new Date(nowMs).toISOString(),
  };
}

/**
 * Stage 12: the UNBOUNDED Major Order objective-progress series from the D1
 * archive — the long-range counterpart to get_major_order_history. Grounds MO
 * pace across a whole order rather than the recent KV window. Optional
 * major_order_id / objective_index narrow the query. Observed points + raw
 * deltas only — never a forecast, required pace, or on-track/behind verdict.
 */
export async function getMajorOrderArchive(
  env: Env,
  args: {
    major_order_id?: number;
    objective_index?: number;
    since_hours?: number;
    until_hours?: number;
    limit?: number;
  },
): Promise<unknown> {
  const nowMs = Date.now();
  const limit = clampLimit(args.limit);
  const { sinceMs, untilMs } = archiveWindow(args, nowMs);
  const rows = await readMoArchive(env, sinceMs, limit, {
    majorOrderId: args.major_order_id,
    objectiveIndex: args.objective_index,
    untilMs,
  });
  const series = buildMoArchiveSeries(rows);
  const retainedIds = [...new Set(rows.map((r) => r.major_order_id))];

  return {
    source: "d1_archive",
    since_hours: args.since_hours ?? ARCHIVE_DEFAULT_SINCE_HOURS,
    ...(args.until_hours != null ? { until_hours: args.until_hours } : {}),
    limit,
    max_limit: ARCHIVE_MAX_LIMIT,
    truncated: rows.length === limit,
    ...(args.major_order_id != null || args.objective_index != null
      ? {
          requested: {
            ...(args.major_order_id != null
              ? { major_order_id: args.major_order_id }
              : {}),
            ...(args.objective_index != null
              ? { objective_index: args.objective_index }
              : {}),
          },
        }
      : {}),
    archived_major_order_ids: retainedIds,
    series_count: series.length,
    series,
    ...(series.length === 0
      ? {
          note: "No archived Major Order progress in the requested window. Samples accrue whenever the server polls campaigns (request polls + the 10-minute cron); a cold start, a too-narrow since_hours, or a major_order_id never sampled is expected to be empty, not an error.",
        }
      : {}),
    notes: {
      sampling: ARCHIVE_SAMPLING_NOTE,
      window: ARCHIVE_WINDOW_NOTE,
      deltas:
        "delta_progress / delta_hours are raw differences between consecutive OBSERVATIONS — never a projection. No forecast, completion estimate, required pace, or on-track/behind verdict exists anywhere in this payload by design; pace judgment belongs to the consumer, grounded on these observed points.",
      progress_pct:
        "latest_progress / target × 100, from the newest archived sample — deterministic; null when the target is 0 or unknown or progress is unknown.",
      objective_kind:
        "Always null in the archive: the D1 schema does not store the raw task_type, so the objective-kind label is not decoded here. get_major_order_history (the recent KV view) carries it. progress/target are identical between the two.",
      retention: ARCHIVE_RETENTION_NOTE,
    },
    queried_at: new Date(nowMs).toISOString(),
  };
}

/* ------------------------------------------------------------------------
 * Next-features wave, Tier 2: the three new analysis tools. All three follow
 * the enrich-never-conclude discipline — observed numbers and deterministic
 * transforms side by side, judgment stays in the conversation layer.
 * ---------------------------------------------------------------------- */

/**
 * Item 3: get_mo_pace — per Major Order objective, the OBSERVED progress rate
 * (from the retained MO progress series) and the REQUIRED rate (remaining ÷
 * time left) side by side, with their inputs. Two numbers, no verdict — the
 * reader decides "on track". Read-only: one assignments fetch (shared 45s
 * cache) + one KV read, ZERO sample-store writes (the get_major_order
 * discipline).
 */
export async function getMoPace(env: Env): Promise<unknown> {
  const [res, moSeries] = await Promise.all([
    fetchUpstream<RawAssignment[]>(env, "/api/v1/assignments"),
    readMoSeries(env),
  ]);
  const assignments = res.data ?? [];
  const nowMs = Date.now();
  const freshness = freshnessFrom([res.fetchedAt], nowMs);
  if (assignments.length === 0) {
    return {
      active: false,
      message: "No active Major Order at this time — no pace to report.",
      ...freshness,
      ...(res.stale ? { stale: true } : {}),
    };
  }

  const orders = shapeMajorOrders(assignments, nowMs);
  return {
    active: true,
    major_orders: orders.map((order) => ({
      id: order.id,
      title: order.title,
      expires_in_seconds: order.expires_in_seconds,
      expires_in: order.expires_in,
      expiration: order.expiration,
      objectives: buildMoPace(order, moSeries),
    })),
    notes: {
      pace: MO_PACE_NOTE,
      observed_rates:
        "Observed rates come from the same retained progress series get_major_order_history serves (samples accrue on every campaign poll + the 10-minute cron; a cold start reports insufficient_history, not 0). _latest is the newest per-interval delta; _mean is the unweighted mean over the retained window.",
      freshness: FRESHNESS_NOTE,
    },
    ...freshness,
    ...(res.stale ? { stale: true } : {}),
  };
}

/**
 * Item 5: get_gambits — the gambit board: every active defense with its
 * attack-origin planet(s) (the inverted source→target attack pairs), each
 * origin joined with its live liberation state and MO membership. Facts only —
 * no viability score, no clear-the-origin-in-time verdict. READ-ONLY like
 * get_supply_graph: the loader is side-effect-free and this tool never commits
 * the tick.
 */
export async function getGambits(env: Env): Promise<unknown> {
  const [planetsResult, bundle] = await Promise.all([
    fetchPlanetsWithFallback(env),
    loadCampaignsResilient(env),
  ]);
  const planets = planetsResult.planets;
  const planetByIndex = new Map<number, RawPlanet>(
    planets.map((p) => [p.index, p]),
  );
  const view = bundle.view;
  const campaignByIndex = new Map(
    bundle.campaigns.map((c) => [c.planet_index, c]),
  );

  // Under a campaign outage the defense set is UNKNOWN, never "no defenses" —
  // serve null with the reason instead of an empty board.
  const campaignStateKnown = view.known;
  const defenses = campaignStateKnown
    ? bundle.campaigns.filter((c) => c.campaign_kind === "defense")
    : null;

  const board = defenses?.map((d) => {
    const planet = planetByIndex.get(d.planet_index);
    const origins = planet
      ? buildGambitOrigins(planet, planetByIndex, view)
      : [];
    return {
      planet_index: d.planet_index,
      planet_name: d.planet_name,
      attacker: d.faction,
      is_major_order_target: d.is_major_order_target,
      raw_hp: d.raw_hp,
      max_hp: d.max_hp,
      hp_per_hour: d.hp_per_hour,
      liberation_pct_display_only: d.liberation_pct_display_only,
      defense_ends_at: d.defense_ends_at ?? null,
      defense_hours_remaining: d.defense_hours_remaining ?? null,
      gambit_origins: origins.map((o) => {
        // Join the origin's live campaign trajectory when one is active —
        // the SAME normalized values get_campaigns returns, never recomputed.
        const oc = campaignByIndex.get(o.index);
        return {
          ...o,
          max_hp: oc?.max_hp ?? null,
          liberation_pct_display_only: oc?.liberation_pct_display_only ?? null,
          hp_per_hour: oc?.hp_per_hour ?? null,
          direction: oc?.direction ?? null,
        };
      }),
    };
  });

  return {
    campaign_state_known: campaignStateKnown,
    defense_count: defenses?.length ?? null,
    defenses: board ?? null,
    ...(campaignStateKnown
      ? defenses!.length === 0
        ? { note: "No active defense campaigns right now — an empty board, not an error." }
        : {}
      : {
          note: "Campaign state could not be fetched this request (outage), so the defense set is UNKNOWN — defenses is null, never an asserted-empty board. Retry when upstream recovers.",
        }),
    notes: {
      gambit_origin: GAMBIT_ORIGIN_NOTE,
      board:
        "One entry per active defense: the defended planet's live event trajectory (the same normalized values get_campaigns returns) plus its attack origin(s) with each origin's live liberation state (raw_hp / max_hp / liberation_pct_display_only / signed hp_per_hour, joined from the origin's active campaign when one exists — null otherwise, never fabricated) and is_major_order_target (a pure membership join). Facts only: there is deliberately NO gambit-viability score or clear-in-time verdict — that judgment is the consumer's.",
      liberation_pct_display_only: LIBERATION_PCT_NOTE,
      hp_per_hour: RATE_SIGN_NOTE,
      freshness: FRESHNESS_NOTE,
    },
    ...freshnessFrom(
      [planetsResult.fetchedAt, ...bundle.fetchedAts],
      Date.now(),
    ),
    ...(anyDegraded(planetsResult.planet_provenance, bundle.campaign_provenance)
      ? { stale: true }
      : {}),
  };
}

/** Item 6: default look-back for get_war_diff when the caller gives none. */
export const WAR_DIFF_DEFAULT_SINCE_HOURS = 24;

/**
 * Item 6: get_war_diff — "what changed since N hours ago" as deterministic
 * archive arithmetic: each subject's FIRST vs LAST archived observation inside
 * the window, with raw before/after values and subtractions. Reads ONLY the D1
 * archive (plus one cached planets fetch to join names); zero KV writes.
 */
export async function getWarDiff(
  env: Env,
  args: { since_hours?: number; until_hours?: number } = {},
): Promise<unknown> {
  const nowMs = Date.now();
  const sinceHours =
    args.since_hours != null &&
    Number.isFinite(args.since_hours) &&
    args.since_hours > 0
      ? args.since_hours
      : WAR_DIFF_DEFAULT_SINCE_HOURS;
  const sinceMs = nowMs - sinceHours * 3_600_000;
  const untilMs = untilCutoffMs(args.until_hours, nowMs) ?? nowMs;
  if (sinceMs > untilMs) {
    throw new ToolError(
      `Empty window: since_hours (${sinceHours}) must be LARGER than until_hours (${args.until_hours}) — both count hours back from now.`,
    );
  }

  const [
    planetFirst,
    planetLast,
    moFirst,
    moLast,
    globalFirst,
    globalLast,
    coverage,
  ] = await Promise.all([
    readPlanetEdgeRows(env, sinceMs, untilMs, "first"),
    readPlanetEdgeRows(env, sinceMs, untilMs, "last"),
    readMoEdgeRows(env, sinceMs, untilMs, "first"),
    readMoEdgeRows(env, sinceMs, untilMs, "last"),
    readGlobalEdgeRow(env, sinceMs, untilMs, "first"),
    readGlobalEdgeRow(env, sinceMs, untilMs, "last"),
    readArchiveCoverage(env),
  ]);

  // Names are cosmetic joins — a planets-fetch failure degrades to indices
  // only, never blocks the archive diff.
  let planetNames = new Map<number, string>();
  let namesJoined = true;
  try {
    const planetsRes = await fetchUpstream<RawPlanet[]>(env, "/api/v1/planets");
    planetNames = new Map(
      (planetsRes.data ?? [])
        .filter((p) => typeof p.name === "string")
        .map((p) => [p.index, p.name]),
    );
  } catch {
    namesJoined = false;
  }

  const diff = buildWarDiff({
    planetFirst,
    planetLast,
    moFirst,
    moLast,
    globalFirst,
    globalLast,
    planetNames,
  });

  const insufficient =
    planetFirst.length === 0 && globalFirst == null && moFirst.length === 0;
  const windowPredatesArchive =
    coverage.earliest != null && sinceMs < coverage.earliest;

  return {
    source: "d1_archive",
    since_hours: sinceHours,
    ...(args.until_hours != null ? { until_hours: args.until_hours } : {}),
    window: {
      from: new Date(sinceMs).toISOString(),
      to: new Date(untilMs).toISOString(),
    },
    archive_coverage: {
      earliest:
        coverage.earliest != null
          ? new Date(coverage.earliest).toISOString()
          : null,
      latest:
        coverage.latest != null
          ? new Date(coverage.latest).toISOString()
          : null,
      window_start_before_archive: windowPredatesArchive,
    },
    insufficient_history: insufficient,
    ...(insufficient
      ? {
          note: "No archived observations inside the requested window — the archive fills one tick at a time while the server polls; a window predating the archive (see archive_coverage) or a cold start is expected to be empty, not an error.",
        }
      : windowPredatesArchive
        ? {
            note: "The window start predates the archive's earliest sample (see archive_coverage) — the diff covers only the archived part of the window.",
          }
        : {}),
    ...diff,
    ...(namesJoined ? {} : { planet_names_joined: false }),
    notes: {
      diff: WAR_DIFF_NOTE,
      sampling: ARCHIVE_SAMPLING_NOTE,
    },
    queried_at: new Date(nowMs).toISOString(),
  };
}
