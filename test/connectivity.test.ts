/**
 * Connectivity enrichment: pure join logic (connectivity.ts, no mocks) plus
 * tool-level output shape checks with the client module — the I/O boundary —
 * mocked. Enrichment must never conclude: only degree counts and the
 * deterministic neighbor join appear in output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  campaignKindsByPlanet,
  connectivityFor,
  planetsByIndex,
} from "../src/connectivity";
import { getCampaigns, getPlanet, getSupplyLines } from "../src/tools";
import type { Env, RawCampaign, RawPlanet } from "../src/types";

const routes = vi.hoisted(() => ({ byPath: {} as Record<string, unknown> }));

vi.mock("../src/client", () => ({
  fetchUpstream: async (_env: unknown, path: string) => {
    if (!(path in routes.byPath)) throw new Error(`Unmocked path: ${path}`);
    return { data: routes.byPath[path], stale: false };
  },
  samplePlanetRates: async () => new Map(),
  UpstreamError: class UpstreamError extends Error {},
}));

function makePlanet(overrides: Partial<RawPlanet> = {}): RawPlanet {
  return {
    index: 1,
    name: "ALPHA CENTAURI",
    sector: "Orion",
    maxHealth: 1_000_000,
    health: 600_000,
    disabled: false,
    initialOwner: "Humans",
    currentOwner: "Humans",
    regenPerSecond: 2.78,
    event: null,
    attacking: [],
    waypoints: [],
    position: { x: 0.25, y: -0.5 },
    ...overrides,
  };
}

// Galaxy fixture: planet 1 links to enemy-held planet 2 (active liberation)
// and to dangling index 999; planet 3 is dormant with NO waypoints/position
// fields at all (upstream omission).
const alpha = makePlanet({
  index: 1,
  name: "ALPHA CENTAURI",
  waypoints: [2, 999],
});
const bravo = makePlanet({
  index: 2,
  name: "BRAVO PRIME",
  currentOwner: "Automaton",
  waypoints: [1],
  position: { x: 0.7, y: 0.1 },
});
const charlie = (() => {
  const p = makePlanet({ index: 3, name: "CHARLIE", sector: "Hydra" });
  delete p.waypoints;
  delete p.position;
  return p;
})();
const planets = [alpha, bravo, charlie];

const liberationOnBravo: RawCampaign = {
  id: 7,
  planet: bravo,
  type: 0,
  count: 1,
  faction: "Automaton",
};

const env = {} as Env;

beforeEach(() => {
  routes.byPath = {
    "/api/v1/planets": planets,
    "/api/v1/campaigns": [liberationOnBravo],
    "/api/v1/assignments": [],
  };
});

describe("connectivityFor (pure join)", () => {
  const byIndex = planetsByIndex(planets);
  const kinds = campaignKindsByPlanet([liberationOnBravo]);

  it("missing waypoints → [], never null, never fabricated", () => {
    const c = connectivityFor(charlie, byIndex, kinds);
    expect(c.waypoints).toEqual([]);
    expect(c.connection_count).toBe(0);
  });

  it("missing position → null, NOT {x:0,y:0}", () => {
    const c = connectivityFor(charlie, byIndex, kinds);
    expect(c.position).toBeNull();
    expect(c.position).not.toEqual({ x: 0, y: 0 });
  });

  it("dangling waypoint index is preserved with name null, not dropped", () => {
    const c = connectivityFor(alpha, byIndex, kinds);
    const dangling = c.waypoints.find((w) => w.index === 999);
    expect(dangling).toEqual({
      index: 999,
      name: null,
      owner: null,
      has_active_campaign: false,
      campaign_kind: null,
    });
  });

  it("connection_count equals waypoints.length including dangling links", () => {
    const c = connectivityFor(alpha, byIndex, kinds);
    expect(c.connection_count).toBe(2);
    expect(c.connection_count).toBe(c.waypoints.length);
  });

  it("joins neighbor owner and active campaign: enemy-owned neighbor with a campaign", () => {
    const c = connectivityFor(alpha, byIndex, kinds);
    const neighbor = c.waypoints.find((w) => w.index === 2);
    expect(neighbor).toEqual({
      index: 2,
      name: "BRAVO PRIME",
      owner: "Automaton",
      has_active_campaign: true,
      campaign_kind: "liberation",
    });
  });

  it("joins campaign_kind defense when the neighbor planet has an event", () => {
    const defended = makePlanet({
      index: 2,
      name: "BRAVO PRIME",
      event: {
        id: 1,
        eventType: 1,
        faction: "Automaton",
        health: 500_000,
        maxHealth: 1_000_000,
        startTime: "2026-06-09T00:00:00Z",
        endTime: "2026-06-10T00:00:00Z",
        campaignId: 7,
      },
    });
    const c = connectivityFor(
      alpha,
      planetsByIndex([alpha, defended]),
      campaignKindsByPlanet([{ ...liberationOnBravo, planet: defended }]),
    );
    expect(c.waypoints[0]).toMatchObject({
      index: 2,
      has_active_campaign: true,
      campaign_kind: "defense",
    });
  });

  it("position passes through untouched when present", () => {
    const c = connectivityFor(alpha, byIndex, kinds);
    expect(c.position).toEqual({ x: 0.25, y: -0.5 });
  });
});

describe("get_planet connectivity output", () => {
  it("includes position, connection_count, and enriched waypoints with all five sub-fields", async () => {
    const result = (await getPlanet(env, { index: 1 })) as Record<
      string,
      unknown
    >;
    expect(result.position).toEqual({ x: 0.25, y: -0.5 });
    expect(result.connection_count).toBe(2);
    expect(result.waypoints).toEqual([
      {
        index: 2,
        name: "BRAVO PRIME",
        owner: "Automaton",
        has_active_campaign: true,
        campaign_kind: "liberation",
      },
      {
        index: 999,
        name: null,
        owner: null,
        has_active_campaign: false,
        campaign_kind: null,
      },
    ]);
    // Prior fields still present.
    expect(result.planet_name).toBe("ALPHA CENTAURI");
    expect(result.sector).toBe("Orion");
    expect(result.has_active_campaign).toBe(false);
  });

  it("missing waypoints/position on the queried planet → [] and null", async () => {
    const result = (await getPlanet(env, { index: 3 })) as Record<
      string,
      unknown
    >;
    expect(result.waypoints).toEqual([]);
    expect(result.connection_count).toBe(0);
    expect(result.position).toBeNull();
  });
});

describe("get_campaigns connectivity output", () => {
  it("each campaign gains position, connection_count, enriched waypoints; prior fields unchanged", async () => {
    const result = (await getCampaigns(env)) as {
      count: number;
      campaigns: Array<Record<string, unknown>>;
    };
    expect(result.count).toBe(1);
    const c = result.campaigns[0]!;
    // Prior fields unchanged.
    expect(c.campaign_id).toBe(7);
    expect(c.planet_name).toBe("BRAVO PRIME");
    expect(c.planet_index).toBe(2);
    expect(c.campaign_kind).toBe("liberation");
    expect(c).toHaveProperty("raw_hp");
    expect(c).toHaveProperty("liberation_pct_display_only");
    expect(c).toHaveProperty("direction");
    // Additive connectivity fields.
    expect(c.position).toEqual({ x: 0.7, y: 0.1 });
    expect(c.connection_count).toBe(1);
    expect(c.waypoints).toEqual([
      {
        index: 1,
        name: "ALPHA CENTAURI",
        owner: "Humans",
        has_active_campaign: false,
        campaign_kind: null,
      },
    ]);
  });
});

describe("get_supply_lines", () => {
  it("returns sector-grouped planets, one entry per planet, lean fields only", async () => {
    const result = (await getSupplyLines(env)) as {
      planet_count: number;
      sectors: Record<string, Array<Record<string, unknown>>>;
      notes: Record<string, string>;
    };
    expect(result.planet_count).toBe(3);
    expect(Object.keys(result.sectors).sort()).toEqual(["Hydra", "Orion"]);
    expect(result.sectors["Orion"]).toHaveLength(2);
    expect(result.sectors["Hydra"]).toHaveLength(1);

    for (const entries of Object.values(result.sectors)) {
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual([
          "connection_count",
          "index",
          "name",
          "owner",
          "position",
          "sector",
          "waypoints",
        ]);
      }
    }
    expect(result.notes.waypoints).toContain("link");
    expect(result.notes.scope).toContain("consumer");
  });

  it("joins neighbor owner/has_active_campaign correctly across the graph", async () => {
    const result = (await getSupplyLines(env)) as {
      sectors: Record<string, Array<Record<string, unknown>>>;
    };
    const entryAlpha = result.sectors["Orion"]!.find((e) => e.index === 1)!;
    expect(entryAlpha.waypoints).toEqual([
      {
        index: 2,
        name: "BRAVO PRIME",
        owner: "Automaton",
        has_active_campaign: true,
        campaign_kind: "liberation",
      },
      {
        index: 999,
        name: null,
        owner: null,
        has_active_campaign: false,
        campaign_kind: null,
      },
    ]);
    const entryCharlie = result.sectors["Hydra"]![0]!;
    expect(entryCharlie.waypoints).toEqual([]);
    expect(entryCharlie.position).toBeNull();
    expect(entryCharlie.connection_count).toBe(0);
  });
});
