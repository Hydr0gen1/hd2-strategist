/**
 * Planet connectivity enrichment, as pure functions. The server ENRICHES
 * facts here — degree counts and a deterministic neighbor join — and never
 * CONCLUDES: no routing, reachability, or targeting logic belongs in this
 * module (or anywhere server-side). Zero I/O; the planets list and active
 * campaign set are passed in by the handler layer.
 */
import type {
  ConnectivityFields,
  RawCampaign,
  RawPlanet,
  WaypointLink,
} from "./types";
import { campaignKind } from "./invariants";

export type CampaignKindByPlanet = ReadonlyMap<
  number,
  "liberation" | "defense"
>;

export function planetsByIndex(
  planets: RawPlanet[],
): ReadonlyMap<number, RawPlanet> {
  const map = new Map<number, RawPlanet>();
  for (const planet of planets) map.set(planet.index, planet);
  return map;
}

/** Active-campaign join input: planet index → campaign kind. */
export function campaignKindsByPlanet(
  campaigns: RawCampaign[],
): CampaignKindByPlanet {
  const map = new Map<number, "liberation" | "defense">();
  for (const campaign of campaigns) {
    map.set(campaign.planet.index, campaignKind(campaign));
  }
  return map;
}

function positionOf(planet: RawPlanet): { x: number; y: number } | null {
  const pos = planet.position;
  // Missing position stays null — substituting {0,0} would place the planet
  // at the real map origin.
  if (
    pos == null ||
    typeof pos.x !== "number" ||
    typeof pos.y !== "number" ||
    !Number.isFinite(pos.x) ||
    !Number.isFinite(pos.y)
  ) {
    return null;
  }
  return { x: pos.x, y: pos.y };
}

function linkFor(
  index: number,
  planetByIndex: ReadonlyMap<number, RawPlanet>,
  kindByPlanet: CampaignKindByPlanet,
): WaypointLink {
  const neighbor = planetByIndex.get(index);
  // A dangling index is still real topology: emit it with name null rather
  // than dropping the link or guessing.
  if (!neighbor) {
    return {
      index,
      name: null,
      owner: null,
      has_active_campaign: false,
      campaign_kind: null,
    };
  }
  const kind = kindByPlanet.get(index) ?? null;
  return {
    index,
    name: neighbor.name,
    owner: neighbor.currentOwner ?? null,
    has_active_campaign: kind != null,
    campaign_kind: kind,
  };
}

export function connectivityFor(
  planet: RawPlanet,
  planetByIndex: ReadonlyMap<number, RawPlanet>,
  kindByPlanet: CampaignKindByPlanet,
): ConnectivityFields {
  const indices = planet.waypoints ?? [];
  return {
    position: positionOf(planet),
    connection_count: indices.length,
    waypoints: indices.map((i) => linkFor(i, planetByIndex, kindByPlanet)),
  };
}
