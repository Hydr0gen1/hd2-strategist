/**
 * Stage 1 enrichment tests: per-planet statistics, defense deadline timing,
 * and biome/hazard pass-through. All functions under test are pure
 * (src/enrichment.ts); the handler layer supplies raw objects and the clock.
 */
import { describe, expect, it } from "vitest";
import {
  defenseTiming,
  missionSuccessRate,
  selectBiome,
  selectHazards,
  selectPlanetStatistics,
} from "../src/enrichment";
import type { RawEvent, RawStatistics } from "../src/types";

const HOUR_MS = 3_600_000;

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 1,
    eventType: 1,
    faction: "Automaton",
    health: 500_000,
    maxHealth: 1_000_000,
    startTime: "2026-06-09T00:00:00Z",
    endTime: "2026-06-10T00:00:00Z",
    campaignId: 42,
    ...overrides,
  };
}

function makeStatistics(overrides: Partial<RawStatistics> = {}): RawStatistics {
  return {
    missionsWon: 800,
    missionsLost: 200,
    missionSuccessRate: 80,
    terminidKills: 1_000_000,
    automatonKills: 2_000_000,
    illuminateKills: 3_000_000,
    deaths: 50_000,
    playerCount: 12_345,
    accuracy: 60,
    ...overrides,
  };
}

describe("mission_success_rate", () => {
  it("derives wins / (wins + losses) as a percentage", () => {
    expect(missionSuccessRate(800, 200)).toBe(80);
  });

  it("returns null for zero missions — never 0, no divide-by-zero", () => {
    expect(missionSuccessRate(0, 0)).toBeNull();
  });

  it("returns 100 for wins-only", () => {
    expect(missionSuccessRate(10, 0)).toBe(100);
  });

  it("returns a genuine 0 for losses-only (missions exist)", () => {
    expect(missionSuccessRate(0, 10)).toBe(0);
  });

  it("returns null when either count is missing", () => {
    expect(missionSuccessRate(null, 10)).toBeNull();
    expect(missionSuccessRate(10, null)).toBeNull();
  });
});

describe("selectPlanetStatistics", () => {
  it("selects the lean named subset, not the whole raw block", () => {
    const out = selectPlanetStatistics(makeStatistics());
    expect(out).toEqual({
      player_count: 12_345,
      mission_wins: 800,
      mission_losses: 200,
      mission_success_rate: 80,
      kills: {
        terminid: 1_000_000,
        automaton: 2_000_000,
        illuminate: 3_000_000,
      },
    });
    // Raw-only fields (deaths, accuracy, …) must not leak through.
    expect(out).not.toHaveProperty("deaths");
    expect(out).not.toHaveProperty("accuracy");
  });

  it("returns null for a missing statistics block — never fabricated counts", () => {
    expect(selectPlanetStatistics(undefined)).toBeNull();
    expect(selectPlanetStatistics(null)).toBeNull();
  });

  it("nulls non-finite counts instead of fabricating them", () => {
    const out = selectPlanetStatistics(
      makeStatistics({ playerCount: Number.NaN }),
    );
    expect(out?.player_count).toBeNull();
  });
});

describe("defenseTiming", () => {
  // All math uses the supplied clock, never the test machine's wall clock.
  const nowMs = Date.parse("2026-06-09T18:00:00Z");

  it("computes hours remaining from the supplied now, not the real clock", () => {
    const out = defenseTiming(makeEvent(), nowMs); // ends 2026-06-10T00:00Z
    expect(out.defense_hours_remaining).toBe(6);
    expect(out.defense_expired).toBe(false);
    expect(out.defense_started_at).toBe("2026-06-09T00:00:00Z");
    expect(out.defense_ends_at).toBe("2026-06-10T00:00:00Z");
  });

  it("clamps a past endTime to 0 and flags defense_expired", () => {
    const out = defenseTiming(makeEvent(), nowMs + 12 * HOUR_MS);
    expect(out.defense_hours_remaining).toBe(0);
    expect(out.defense_expired).toBe(true);
  });

  it("treats exactly-at-endTime as expired with 0 remaining", () => {
    const out = defenseTiming(
      makeEvent(),
      Date.parse("2026-06-10T00:00:00Z"),
    );
    expect(out.defense_hours_remaining).toBe(0);
    expect(out.defense_expired).toBe(true);
  });

  it("never computes from a missing endTime — timing fields go null", () => {
    const out = defenseTiming(
      makeEvent({ endTime: undefined as unknown as string }),
      nowMs,
    );
    expect(out.defense_ends_at).toBeNull();
    expect(out.defense_hours_remaining).toBeNull();
    expect(out.defense_expired).toBeNull();
    // startTime still passes through on its own.
    expect(out.defense_started_at).toBe("2026-06-09T00:00:00Z");
  });

  it("emits the fields that exist when startTime is missing", () => {
    const out = defenseTiming(
      makeEvent({ startTime: undefined as unknown as string }),
      nowMs,
    );
    expect(out.defense_started_at).toBeNull();
    expect(out.defense_hours_remaining).toBe(6);
  });

  it("nulls timing on an unparseable endTime", () => {
    const out = defenseTiming(makeEvent({ endTime: "not-a-date" }), nowMs);
    expect(out.defense_hours_remaining).toBeNull();
    expect(out.defense_expired).toBeNull();
  });
});

describe("selectBiome / selectHazards", () => {
  it("passes biome name + description through as upstream sends them", () => {
    expect(
      selectBiome({ name: "Scorched Moor", description: "Scorching…" }),
    ).toEqual({ name: "Scorched Moor", description: "Scorching…" });
  });

  it("returns null for a missing biome", () => {
    expect(selectBiome(undefined)).toBeNull();
    expect(selectBiome(null)).toBeNull();
  });

  it("nulls a missing biome description without dropping the name", () => {
    expect(selectBiome({ name: "Crimson Thicket" })).toEqual({
      name: "Crimson Thicket",
      description: null,
    });
  });

  it("passes hazards through as {name, description} pairs", () => {
    expect(
      selectHazards([
        { name: "Fire Tornadoes", description: "Planet is ravaged…" },
      ]),
    ).toEqual([
      { name: "Fire Tornadoes", description: "Planet is ravaged…" },
    ]);
  });

  it("returns [] — never null — for missing or empty hazards", () => {
    expect(selectHazards(undefined)).toEqual([]);
    expect(selectHazards(null)).toEqual([]);
    expect(selectHazards([])).toEqual([]);
  });
});
