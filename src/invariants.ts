/**
 * The five domain invariants, as pure functions. No I/O here — everything
 * needed from other endpoints (Major Order planet set, sampled rates) is
 * passed in via NormalizeContext by the handler layer.
 */
import type {
  Direction,
  NormalizeContext,
  NormalizedCampaign,
  Projection,
  RawCampaign,
  TrajectorySignal,
} from "./types";

/**
 * Invariant 4: campaigns younger than this emit `stabilizing: true` instead
 * of any collapse/failure signal. Default 1 hour.
 */
export const RAMP_UP_THRESHOLD_MS = 3_600_000;

/**
 * Invariant 5: campaign `type` values treated as High Priority Campaigns.
 * Type 0 is a standard liberation campaign; anything else is classified as
 * HPC. When in doubt, classify AS HPC — over-inclusion is fail-safe,
 * under-inclusion reintroduces the false-collapse bug.
 */
export const HPC_CAMPAIGN_TYPES: ReadonlySet<number> = new Set([1, 2, 3]);

export function campaignKind(raw: RawCampaign): "liberation" | "defense" {
  return raw.planet.event != null ? "defense" : "liberation";
}

/**
 * Invariant 1: defense-campaign decay is cosmetic — force-null it even when
 * upstream sends a real-looking value. Liberation regen passes through.
 */
export function nullifyDefenseDecay(raw: RawCampaign): number | null {
  if (campaignKind(raw) === "defense") return null;
  const regen = raw.planet.regenPerSecond;
  return typeof regen === "number" && Number.isFinite(regen) ? regen : null;
}

/**
 * Invariant 2: liberation % is display-only. It is computed here solely so it
 * can be labeled and quarantined; nothing else in this module reads it.
 */
export function isolateLiberationPct(
  rawHp: number | null,
  maxHp: number | null,
): number | null {
  if (rawHp == null || maxHp == null || !(maxHp > 0)) return null;
  return Math.round((1 - rawHp / maxHp) * 10000) / 100;
}

/**
 * Invariant 3: projections derive from raw HP ÷ |HP-per-hour| — never from
 * liberation %. Explicitly guards hp_per_hour === 0 (stalemate) and missing
 * data; never divides by zero, never substitutes 0 for a missing value.
 *
 * The result is a sign-blind magnitude: hpPerHour's sign (liberating vs
 * losing) is carried exclusively by the `direction` flag — see
 * directionFromRate and the convention documented in client.ts.
 */
export function projectResolution(
  rawHp: number | null,
  hpPerHour: number | null,
): Projection {
  if (rawHp == null || !Number.isFinite(rawHp)) {
    return { hours_to_resolution: null, status: "data_error" };
  }
  if (hpPerHour == null || !Number.isFinite(hpPerHour)) {
    return { hours_to_resolution: null, status: "insufficient_data" };
  }
  if (hpPerHour === 0) {
    return { hours_to_resolution: null, status: "stalemate" };
  }
  return {
    hours_to_resolution: rawHp / Math.abs(hpPerHour),
    status: "projected",
  };
}

/**
 * Direction comes from the sign of the one shared hp_per_hour value
 * (positive = health depleting = progressing toward resolution; negative =
 * health rising = losing ground; see the convention block in client.ts).
 */
export function directionFromRate(hpPerHour: number | null): Direction {
  if (hpPerHour == null || !Number.isFinite(hpPerHour)) return "unknown";
  if (hpPerHour === 0) return "stalemate";
  return hpPerHour > 0 ? "liberating" : "losing";
}

/**
 * Invariant 4: ramp-up stabilization. Freshly opened campaigns have volatile
 * early rates; suppress collapse/failure signals and flag `stabilizing`
 * instead. An unknown age is treated as young (fail-safe: no false alarm).
 */
export function applyRampUpStabilization(
  signal: TrajectorySignal,
  campaignAgeMs: number | null,
  thresholdMs: number = RAMP_UP_THRESHOLD_MS,
): TrajectorySignal {
  if (campaignAgeMs != null && campaignAgeMs >= thresholdMs) return signal;
  return { ...signal, alert: null, stabilizing: true };
}

export function isHighPriorityCampaign(
  campaignType: number,
  planetIndex: number,
  hpcTypes: ReadonlySet<number>,
  moPlanetIndices: ReadonlySet<number>,
): boolean {
  return hpcTypes.has(campaignType) || moPlanetIndices.has(planetIndex);
}

/**
 * Invariant 5: High Priority Campaign decay is intentionally deceptive —
 * never emit a failure/collapse alert for an HPC, and annotate that the
 * apparent decay is not indicative of a losing trajectory.
 */
export function suppressHpcFalseFailure(
  signal: TrajectorySignal,
  ctx: {
    campaignType: number;
    planetIndex: number;
    hpcTypes: ReadonlySet<number>;
    moPlanetIndices: ReadonlySet<number>;
  },
): TrajectorySignal {
  if (
    !isHighPriorityCampaign(
      ctx.campaignType,
      ctx.planetIndex,
      ctx.hpcTypes,
      ctx.moPlanetIndices,
    )
  ) {
    return signal;
  }
  return {
    ...signal,
    alert: null,
    hpc: true,
    hpc_note:
      "High Priority Campaign: upstream decay is intentionally deceptive and must not be read as a failing trajectory.",
  };
}

/**
 * Orchestrates all five invariants over one raw campaign. Pure: every
 * external fact (rate, age, MO planet set) arrives via ctx.
 */
export function normalizeCampaign(
  raw: RawCampaign,
  ctx: NormalizeContext,
): NormalizedCampaign {
  const kind = campaignKind(raw);
  const source = kind === "defense" ? raw.planet.event! : raw.planet;
  const rawHp = Number.isFinite(source.health) ? source.health : null;
  const maxHp = Number.isFinite(source.maxHealth) ? source.maxHealth : null;
  const degraded = rawHp == null || maxHp == null;

  // Data-quality gate: a record with missing/garbled HP is excluded from
  // projections and flagged — never patched with 0, which would fake math.
  const hpPerHour = degraded ? null : ctx.hpPerHour;

  let signal: TrajectorySignal = {
    direction: directionFromRate(hpPerHour),
    alert: null,
    stabilizing: false,
    hpc: false,
  };
  if (signal.direction === "losing") signal.alert = "collapse";

  signal = applyRampUpStabilization(signal, ctx.campaignAgeMs);
  signal = suppressHpcFalseFailure(signal, {
    campaignType: raw.type,
    planetIndex: raw.planet.index,
    hpcTypes: ctx.hpcTypes,
    moPlanetIndices: ctx.moPlanetIndices,
  });

  const projection = projectResolution(rawHp, hpPerHour);

  return {
    campaign_id: raw.id,
    planet_name: raw.planet.name,
    planet_index: raw.planet.index,
    faction:
      kind === "defense" ? raw.planet.event!.faction : raw.planet.currentOwner,
    campaign_type: raw.type,
    campaign_kind: kind,
    raw_hp: rawHp,
    max_hp: maxHp,
    hp_per_hour: hpPerHour,
    regen_per_second: nullifyDefenseDecay(raw),
    liberation_pct_display_only: isolateLiberationPct(rawHp, maxHp),
    ...signal,
    ...projection,
    ...(degraded ? { data_quality: "degraded" as const } : {}),
  };
}
