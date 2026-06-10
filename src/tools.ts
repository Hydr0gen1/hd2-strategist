/**
 * The four MCP tools. Orchestration layer: fetch raw data via client.ts,
 * assemble NormalizeContext (rates, ages, MO planet set), and run the pure
 * invariant normalization from invariants.ts.
 */
import {
  fetchUpstream,
  samplePlanetRates,
  type SampleInput,
} from "./client";
import {
  defenseTiming,
  selectBiome,
  selectHazards,
  selectPlanetStatistics,
} from "./enrichment";
import {
  HPC_CAMPAIGN_TYPES,
  campaignKind,
  normalizeCampaign,
} from "./invariants";
import type {
  EnrichedCampaign,
  Env,
  NormalizedCampaign,
  RawAssignment,
  RawCampaign,
  RawPlanet,
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

  const fronts: Record<
    string,
    { campaigns: number; defenses: number; planets: string[] }
  > = {};
  for (const c of bundle.campaigns) {
    const front = (fronts[c.faction] ??= {
      campaigns: 0,
      defenses: 0,
      planets: [],
    });
    front.campaigns += 1;
    if (c.campaign_kind === "defense") front.defenses += 1;
    front.planets.push(c.planet_name);
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

export async function getPlanet(
  env: Env,
  args: { index?: number; name?: string },
): Promise<unknown> {
  if (args.index == null && !args.name) {
    throw new ToolError(
      "Provide either a planet `index` (number) or `name` (string).",
    );
  }

  const [planetsRes, bundle] = await Promise.all([
    fetchUpstream<RawPlanet[]>(env, "/api/v1/planets"),
    loadNormalizedCampaigns(env),
  ]);
  const planets = planetsRes.data ?? [];

  let planet: RawPlanet | undefined;
  if (args.index != null) {
    planet = planets.find((p) => p.index === args.index);
  } else {
    const needle = args.name!.trim().toLowerCase();
    planet = planets.find((p) => p.name.toLowerCase() === needle);
  }

  if (!planet) {
    const activeHint = bundle.campaigns
      .slice(0, 10)
      .map((c) => `${c.planet_name} (index ${c.planet_index})`)
      .join(", ");
    throw new ToolError(
      `Planet not found for ${args.index != null ? `index ${args.index}` : `name "${args.name}"`}. ` +
        `Valid indices are 0–${Math.max(0, planets.length - 1)}. ` +
        `Planets with active campaigns include: ${activeHint || "none currently"}.`,
    );
  }

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
