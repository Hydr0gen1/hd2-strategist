/**
 * The ONE provenance contract (PR #17 consolidation). Every loader reports its
 * input's provenance through these two enums; every tool/writer consumes ONLY
 * the two derived predicates and the tri-state campaign accessor below — never
 * a raw `source === 'live'` comparison or a bare `Map.has()` that silently turns
 * "unknown" into "false". This is the single place degradation is represented,
 * so the whole "stale/unknown treated as a fact" bug class is unrepresentable
 * elsewhere.
 */

/** Planet-list provenance (governs topology + the freshness gate). A live fetch
 * can still be STALE — an expired raw cache served after an upstream failure —
 * so freshness is `=== 'live_fresh'`, never `source === 'live'`. */
export type PlanetProvenance =
  | "live_fresh"
  | "live_expired_cache"
  | "snapshot_fallback";

/** Campaign/assignment provenance (governs the campaign overlay + the gate).
 * `ok` = fresh live; `stale` = last-known cache (resolvable, but flagged);
 * `unavailable` = resilient-empty / fetch failed (state UNKNOWN, never quiet). */
export type CampaignProvenance = "ok" | "stale" | "unavailable";

/** Derive the planet provenance from the low-level fetch result. `source` and
 * `stale` are kept internal to the fetch layer; downstream reads this enum. */
export function planetProvenanceOf(
  source: "live" | "snapshot",
  stale: boolean,
): PlanetProvenance {
  if (source === "snapshot") return "snapshot_fallback";
  return stale ? "live_expired_cache" : "live_fresh";
}

/** Top-level `stale` rollup for EVERY tool: any input not perfectly fresh. */
export function anyDegraded(
  planet: PlanetProvenance,
  campaigns: CampaignProvenance,
): boolean {
  return planet !== "live_fresh" || campaigns !== "ok";
}

/** The ONLY condition under which KV/D1 may be written: all inputs fresh-live. */
export function allFresh(
  planet: PlanetProvenance,
  campaigns: CampaignProvenance,
): boolean {
  return planet === "live_fresh" && campaigns === "ok";
}

/** Machine-readable reasons derived MECHANICALLY from the two enums — no
 * separately-maintained booleans to drift out of sync. */
export function provenanceReasons(
  planet: PlanetProvenance,
  campaigns: CampaignProvenance,
): string[] {
  const reasons: string[] = [];
  if (planet === "snapshot_fallback")
    reasons.push("planet_list_served_from_snapshot_fallback");
  else if (planet === "live_expired_cache")
    reasons.push("planet_list_served_from_expired_cache");
  if (campaigns === "stale")
    reasons.push("campaign_overlay_served_from_stale_cache");
  else if (campaigns === "unavailable")
    reasons.push("campaign_overlay_unavailable_active_selection_unknown");
  return reasons;
}

/** Tri-state campaign status for one planet — `'unknown'` is DISTINCT from
 * `'inactive'`. Annotation builders consume this, never a raw map lookup. */
export type CampaignStatus = "active" | "inactive" | "unknown";

/**
 * The tri-state campaign accessor. Built once per request from the normalized
 * campaign set + the MO planet set + the campaign provenance. Under an outage
 * (`provenance === 'unavailable'`) every query is `'unknown'` / `null`, so a
 * builder can NEVER assert `false` from an absent map entry. `'stale'` resolves
 * from the last-known set (still flagged via the provenance rollup).
 */
export interface CampaignView {
  readonly provenance: CampaignProvenance;
  /** True unless campaign state is UNKNOWN (provenance === 'unavailable'). */
  readonly known: boolean;
  status(planetIndex: number): CampaignStatus;
  /** Active campaign kind, or null when inactive OR unknown. */
  kind(planetIndex: number): "liberation" | "defense" | null;
  /** has_active_campaign emission: boolean when known, null when unknown. */
  hasActiveCampaign(planetIndex: number): boolean | null;
  /** MO-target membership: boolean when known, 'unknown' under an outage. */
  moMembership(planetIndex: number): boolean | "unknown";
}

export function campaignView(
  campaignKindByPlanetIndex: ReadonlyMap<number, "liberation" | "defense">,
  moPlanetIndices: ReadonlySet<number>,
  provenance: CampaignProvenance,
): CampaignView {
  const known = provenance !== "unavailable";
  return {
    provenance,
    known,
    status(idx) {
      if (!known) return "unknown";
      return campaignKindByPlanetIndex.has(idx) ? "active" : "inactive";
    },
    kind(idx) {
      if (!known) return null;
      return campaignKindByPlanetIndex.get(idx) ?? null;
    },
    hasActiveCampaign(idx) {
      if (!known) return null;
      return campaignKindByPlanetIndex.has(idx);
    },
    moMembership(idx) {
      if (!known) return "unknown";
      return moPlanetIndices.has(idx);
    },
  };
}
