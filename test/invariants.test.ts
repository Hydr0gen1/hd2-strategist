import { describe, expect, it } from "vitest";
import {
  HPC_CAMPAIGN_TYPES,
  RAMP_UP_THRESHOLD_MS,
  applyRampUpStabilization,
  directionFromRate,
  isolateLiberationPct,
  normalizeCampaign,
  nullifyDefenseDecay,
  projectResolution,
  suppressHpcFalseFailure,
} from "../src/invariants";
import type {
  NormalizeContext,
  RawCampaign,
  RawEvent,
  TrajectorySignal,
} from "../src/types";

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

function makeCampaign(overrides: {
  planet?: Partial<RawCampaign["planet"]>;
  type?: number;
  id?: number;
}): RawCampaign {
  return {
    id: overrides.id ?? 42,
    type: overrides.type ?? 0,
    count: 1,
    faction: "Humans",
    planet: {
      index: 175,
      name: "GRAND ERRANT",
      sector: "Farsight",
      maxHealth: 1_000_000,
      health: 600_000,
      disabled: false,
      initialOwner: "Humans",
      currentOwner: "Terminids",
      regenPerSecond: 2.7777777,
      event: null,
      attacking: [],
      waypoints: [],
      ...overrides.planet,
    },
  };
}

function ctx(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    hpPerHour: 10_000,
    campaignAgeMs: 2 * HOUR_MS, // past ramp-up by default
    hpcTypes: HPC_CAMPAIGN_TYPES,
    moPlanetIndices: new Set<number>(),
    ...overrides,
  };
}

const baseSignal: TrajectorySignal = {
  direction: "losing",
  alert: "collapse",
  stabilizing: false,
  hpc: false,
};

describe("invariant 1: defense decay is cosmetic — force-null", () => {
  it("nulls regen for a defense campaign even when upstream sends a value (edge case 7)", () => {
    const campaign = makeCampaign({
      planet: { event: makeEvent(), regenPerSecond: 2.78 },
    });
    expect(nullifyDefenseDecay(campaign)).toBeNull();

    const normalized = normalizeCampaign(campaign, ctx());
    expect(normalized.regen_per_second).toBeNull();
    expect(normalized.campaign_kind).toBe("defense");
  });

  it("passes regen through for liberation campaigns", () => {
    const campaign = makeCampaign({ planet: { regenPerSecond: 1.39 } });
    expect(nullifyDefenseDecay(campaign)).toBeCloseTo(1.39);
  });
});

describe("invariant 2: liberation % is isolated and display-only", () => {
  it("computes a labeled display value from raw HP", () => {
    expect(isolateLiberationPct(600_000, 1_000_000)).toBe(40);
  });

  it("returns null rather than fake math on bad inputs", () => {
    expect(isolateLiberationPct(null, 1_000_000)).toBeNull();
    expect(isolateLiberationPct(600_000, 0)).toBeNull();
  });

  it("only surfaces the % under liberation_pct_display_only — no HP-implying field", () => {
    const normalized = normalizeCampaign(makeCampaign({}), ctx());
    expect(normalized.liberation_pct_display_only).toBe(40);
    expect(normalized.raw_hp).toBe(600_000);
    // The projection must come from raw HP, not from the display %.
    expect(normalized.hours_to_resolution).toBe(600_000 / 10_000);
  });
});

describe("invariant 3: projections from raw HP ÷ |hp_per_hour|", () => {
  it("projects hours_to_resolution from raw HP", () => {
    expect(projectResolution(600_000, 10_000)).toEqual({
      hours_to_resolution: 60,
      status: "projected",
    });
  });

  it("uses magnitude: a losing (negative) rate still yields a positive abs projection", () => {
    expect(projectResolution(600_000, -10_000)).toEqual({
      hours_to_resolution: 60,
      status: "projected",
    });
  });

  it("guards hp_per_hour === 0 — no division, stalemate (edge case 3)", () => {
    expect(projectResolution(600_000, 0)).toEqual({
      hours_to_resolution: null,
      status: "stalemate",
    });
  });

  it("returns insufficient_data for a null rate", () => {
    expect(projectResolution(600_000, null)).toEqual({
      hours_to_resolution: null,
      status: "insufficient_data",
    });
  });

  it("returns data_error for missing raw HP — never substitutes 0", () => {
    expect(projectResolution(null, 10_000)).toEqual({
      hours_to_resolution: null,
      status: "data_error",
    });
  });
});

describe("invariant 4: ramp-up stabilization", () => {
  it("suppresses collapse for campaigns younger than the threshold", () => {
    const result = applyRampUpStabilization(baseSignal, HOUR_MS / 2);
    expect(result.alert).toBeNull();
    expect(result.stabilizing).toBe(true);
  });

  it("leaves mature campaigns untouched", () => {
    const result = applyRampUpStabilization(baseSignal, 2 * HOUR_MS);
    expect(result.alert).toBe("collapse");
    expect(result.stabilizing).toBe(false);
  });

  it("treats unknown age as young (fail-safe)", () => {
    const result = applyRampUpStabilization(baseSignal, null);
    expect(result.alert).toBeNull();
    expect(result.stabilizing).toBe(true);
  });

  it("respects a custom threshold and exposes the default constant", () => {
    expect(RAMP_UP_THRESHOLD_MS).toBe(HOUR_MS);
    const result = applyRampUpStabilization(baseSignal, HOUR_MS, 2 * HOUR_MS);
    expect(result.stabilizing).toBe(true);
  });
});

describe("invariant 5: HPC decay never flags as failure", () => {
  const hpcCtx = {
    campaignType: 0,
    planetIndex: 259,
    hpcTypes: HPC_CAMPAIGN_TYPES,
    moPlanetIndices: new Set([259]),
  };

  it("suppresses collapse alerts for Major-Order-linked planets", () => {
    const result = suppressHpcFalseFailure(baseSignal, hpcCtx);
    expect(result.alert).toBeNull();
    expect(result.hpc).toBe(true);
    expect(result.hpc_note).toMatch(/intentionally deceptive/);
  });

  it("suppresses collapse alerts for HPC campaign types", () => {
    const result = suppressHpcFalseFailure(baseSignal, {
      ...hpcCtx,
      planetIndex: 1,
      moPlanetIndices: new Set<number>(),
      campaignType: 2,
    });
    expect(result.alert).toBeNull();
    expect(result.hpc).toBe(true);
  });

  it("leaves non-HPC campaigns untouched", () => {
    const result = suppressHpcFalseFailure(baseSignal, {
      ...hpcCtx,
      planetIndex: 1,
      moPlanetIndices: new Set<number>(),
      campaignType: 0,
    });
    expect(result).toEqual(baseSignal);
  });
});

describe("edge case 4: negative rate on a liberation campaign", () => {
  it("flags direction losing; mature non-HPC gets a collapse alert", () => {
    const normalized = normalizeCampaign(
      makeCampaign({}),
      ctx({ hpPerHour: -5_000 }),
    );
    expect(normalized.direction).toBe("losing");
    expect(normalized.alert).toBe("collapse");
  });

  it("young campaign: stabilizing suppresses the collapse alert", () => {
    const normalized = normalizeCampaign(
      makeCampaign({}),
      ctx({ hpPerHour: -5_000, campaignAgeMs: 10 * 60_000 }),
    );
    expect(normalized.direction).toBe("losing");
    expect(normalized.alert).toBeNull();
    expect(normalized.stabilizing).toBe(true);
  });
});

describe("edge case 8: newly opened HPC with steep decay (invariants 4+5 stack)", () => {
  it("must not surface as failing", () => {
    const normalized = normalizeCampaign(
      makeCampaign({ type: 2, id: 99 }),
      ctx({ hpPerHour: -250_000, campaignAgeMs: 5 * 60_000 }),
    );
    expect(normalized.alert).toBeNull();
    expect(normalized.stabilizing).toBe(true);
    expect(normalized.hpc).toBe(true);
    // Magnitude projection still works; sign lives only in `direction`.
    expect(normalized.direction).toBe("losing");
    expect(normalized.hours_to_resolution).toBeGreaterThan(0);
  });
});

describe("losing defense campaign with RISING health (sign-convention mirror of edge case 4)", () => {
  // Defenders losing ground: event.health rose between samples, so
  // hp_per_hour = (prev - current) / hours is NEGATIVE per the documented
  // convention in client.ts.
  const prevHealth = 400_000;
  const currentHealth = 450_000;
  const hpPerHour = (prevHealth - currentHealth) / 1; // one hour elapsed

  function losingDefense(extra: { type?: number } = {}) {
    return makeCampaign({
      type: extra.type ?? 0,
      planet: {
        event: makeEvent({ health: currentHealth }),
        regenPerSecond: 2.78,
      },
    });
  }

  it("carries the correct sign, direction losing, positive abs projection", () => {
    expect(hpPerHour).toBe(-50_000);
    const normalized = normalizeCampaign(losingDefense(), ctx({ hpPerHour }));
    expect(normalized.hp_per_hour).toBe(-50_000);
    expect(normalized.direction).toBe("losing");
    expect(normalized.hours_to_resolution).toBe(currentHealth / 50_000);
    expect(normalized.hours_to_resolution).toBeGreaterThan(0);
    expect(normalized.status).toBe("projected");
    // Sign does not flip across campaign kinds: same convention as liberation.
    expect(directionFromRate(hpPerHour)).toBe("losing");
  });

  it("young losing defense: invariant 4 still suppresses the collapse alert", () => {
    const normalized = normalizeCampaign(
      losingDefense(),
      ctx({ hpPerHour, campaignAgeMs: 10 * 60_000 }),
    );
    expect(normalized.direction).toBe("losing");
    expect(normalized.alert).toBeNull();
    expect(normalized.stabilizing).toBe(true);
  });

  it("HPC losing defense: invariant 5 still suppresses the collapse alert", () => {
    const normalized = normalizeCampaign(
      losingDefense({ type: 2 }),
      ctx({ hpPerHour }),
    );
    expect(normalized.direction).toBe("losing");
    expect(normalized.alert).toBeNull();
    expect(normalized.hpc).toBe(true);
  });
});

describe("data-quality gate: missing/garbled upstream fields", () => {
  it("excludes records with missing raw_hp from projections and flags them", () => {
    const normalized = normalizeCampaign(
      makeCampaign({
        planet: { health: Number.NaN },
      }),
      ctx(),
    );
    expect(normalized.raw_hp).toBeNull();
    expect(normalized.data_quality).toBe("degraded");
    expect(normalized.hp_per_hour).toBeNull();
    expect(normalized.hours_to_resolution).toBeNull();
    expect(normalized.status).toBe("data_error");
    expect(normalized.direction).toBe("unknown");
  });
});

describe("direction and projection share one signed source", () => {
  it.each([
    [10_000, "liberating"],
    [-10_000, "losing"],
    [0, "stalemate"],
    [null, "unknown"],
  ] as const)("rate %s → direction %s", (rate, direction) => {
    expect(directionFromRate(rate)).toBe(direction);
  });
});
