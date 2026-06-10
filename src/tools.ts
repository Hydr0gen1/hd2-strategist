/**
 * The seven MCP tools. Orchestration layer: fetch raw data via client.ts,
 * assemble NormalizeContext (rates, ages, MO planet set), and run the pure
 * invariant normalization from invariants.ts (plus the pure Stage 1/2
 * enrichment shapers from enrichment.ts).
 */
import {
  fetchUpstream,
  readPlanetSamples,
  samplePlanetRates,
  type SampleInput,
} from "./client";
import {
  aggregateFrontRate,
  buildHistoryPoints,
  decayPerHour,
  defenseTiming,
  selectBiome,
  selectHazards,
  selectPlanetStatistics,
  shapeDispatches,
  shapePatchNotes,
} from "./enrichment";
import {
  HPC_CAMPAIGN_TYPES,
  campaignKind,
  normalizeCampaign,
} from "./invariants";
import {
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLES_PER_PLANET,
} from "./sampling";
import type {
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

/** Upstream assignment task valueType that denotes a planet index. */
const TASK_VALUE_TYPE_PLANET = 12;

export class ToolError extends Error {}

function moPlanetIndicesFrom(
  assignments: RawAssignment[],
): ReadonlySet<number> {
  const indices = new Set<number>();
  for (const assignment of assignments) {
    for (const task of assignment.tasks ?? []) {
      const types = task.valueTypes ?? [];
      const values = task.values ?? [];
      for (let i = 0; i < types.length; i++) {
        if (types[i] === TASK_VALUE_TYPE_PLANET && values[i] != null) {
          indices.add(values[i]!);
        }
      }
    }
  }
  return indices;
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
}

async function loadNormalizedCampaigns(env: Env): Promise<CampaignBundle> {
  const [campaignsRes, assignmentsRes] = await Promise.all([
    fetchUpstream<RawCampaign[]>(env, "/api/v1/campaigns"),
    fetchUpstream<RawAssignment[]>(env, "/api/v1/assignments"),
  ]);
  const raw = campaignsRes.data ?? [];
  const moPlanetIndices = moPlanetIndicesFrom(assignmentsRes.data ?? []);
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
    return {
      ...normalized,
      // Stage 3: unit conversion of the invariant-1 normalized regen (already
      // force-nulled for defenses) — never of the raw upstream regen.
      decay_per_hour: decayPerHour(normalized.regen_per_second),
      statistics: selectPlanetStatistics(c.planet.statistics),
      biome: selectBiome(c.planet.biome),
      hazards: selectHazards(c.planet.hazards),
      ...(c.planet.event ? defenseTiming(c.planet.event, nowMs) : {}),
    };
  });

  return { campaigns, stale: campaignsRes.stale || assignmentsRes.stale };
}

export async function getWarStatus(env: Env): Promise<unknown> {
  const [warRes, bundle] = await Promise.all([
    fetchUpstream<RawWar>(env, "/api/v1/war"),
    loadNormalizedCampaigns(env),
  ]);
  const war = warRes.data;

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

  return {
    war_started: war.started,
    war_ends: war.ended,
    client_version: war.clientVersion,
    factions: war.factions,
    impact_multiplier: war.impactMultiplier,
    total_planets_in_play: bundle.campaigns.length,
    active_fronts: fronts,
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
        "Per-front sum of the same signed per-campaign hp_per_hour values (positive = progressing toward resolution). Only planets with a known rate are summed — planets_with_rate vs planets_total states the coverage. Null means no planet on the front has a rate yet (e.g. cold start), not zero.",
    },
    ...(warRes.stale || bundle.stale ? { stale: true } : {}),
  };
}

export async function getCampaigns(env: Env): Promise<unknown> {
  const bundle = await loadNormalizedCampaigns(env);
  return {
    count: bundle.campaigns.length,
    campaigns: bundle.campaigns,
    notes: {
      liberation_pct_display_only:
        "Cosmetic display value only. All quantitative logic must use raw_hp.",
      hp_per_hour:
        "Net signed rate sampled by this server: positive = progressing toward resolution, negative = losing ground. Null until two samples >60s apart exist.",
      mission_success_rate:
        "Derived per planet as mission_wins / (mission_wins + mission_losses) × 100. Null when no missions are recorded — never 0.",
      defense_hours_remaining:
        "Defense campaigns only: (endTime − now) in hours, clamped at 0 with defense_expired: true once past. A deadline fact, not an urgency judgment.",
      decay_per_hour:
        "regen_per_second × 3600 — regen in the same units as hp_per_hour. Derived from the invariant-normalized regen, so it is always null on defense campaigns (cosmetic decay stays suppressed) and null when regen is unknown.",
    },
    ...(bundle.stale ? { stale: true } : {}),
  };
}

function humanizeSeconds(totalSeconds: number): string {
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

export async function getMajorOrder(env: Env): Promise<unknown> {
  const res = await fetchUpstream<RawAssignment[]>(env, "/api/v1/assignments");
  const assignments = res.data ?? [];
  if (assignments.length === 0) {
    return {
      active: false,
      message: "No active Major Order at this time.",
      ...(res.stale ? { stale: true } : {}),
    };
  }

  const orders = assignments.map((a) => {
    const expiresInSeconds = Math.max(
      0,
      Math.floor((Date.parse(a.expiration) - Date.now()) / 1000),
    );
    return {
      id: a.id,
      title: a.title,
      briefing: a.briefing,
      description: a.description,
      objectives: (a.tasks ?? []).map((task, i) => ({
        index: i,
        task_type: task.type,
        progress: a.progress?.[i] ?? null,
        values: task.values,
        value_types: task.valueTypes,
        planet_indices: (task.valueTypes ?? []).flatMap((vt, j) =>
          vt === TASK_VALUE_TYPE_PLANET && task.values?.[j] != null
            ? [task.values[j]!]
            : [],
        ),
      })),
      rewards: a.rewards?.length ? a.rewards : a.reward ? [a.reward] : [],
      expires_in_seconds: expiresInSeconds,
      expires_in: humanizeSeconds(expiresInSeconds),
      expiration: a.expiration,
    };
  });

  return {
    active: true,
    major_orders: orders,
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
    const needle = args.name!.trim().toLowerCase();
    planet = planets.find((p) => p.name.toLowerCase() === needle);
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
    defense_event: planet.event
      ? {
          event_type: planet.event.eventType,
          attacker: planet.event.faction,
          start_time: planet.event.startTime,
          end_time: planet.event.endTime,
        }
      : null,
    ...(planet.event ? defenseTiming(planet.event, Date.now()) : {}),
    player_count: planet.statistics?.playerCount ?? null,
    statistics: selectPlanetStatistics(planet.statistics),
    biome: selectBiome(planet.biome),
    hazards: selectHazards(planet.hazards),
    ...(planetsRes.stale || bundle.stale ? { stale: true } : {}),
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
        "Raw observed change per point: current − previous (negative = health depleting). hp_per_hour elsewhere uses the opposite orientation, (previous − current) / hours, positive = progressing toward resolution. Both are stated so the sign conventions are explicit.",
      sampling:
        "Observed data points and deterministic deltas only — no smoothing, no forecast, no trend verdict. Sample timestamps use the Worker clock (upstream war time is game-epoch and not comparable).",
    },
    ...(planetsRes.stale || campaignsRes.stale ? { stale: true } : {}),
  };
}
