/**
 * Stage 3 deterministic-derivation tests: per-front aggregated hp_per_hour
 * and the decay_per_hour unit conversion. Both functions under test are pure
 * (src/enrichment.ts); the pipeline tests run them over normalizeCampaign
 * output exactly as the handler layer does, proving invariant 1 survives the
 * conversion and that the front sum consumes the one signed rate source.
 */
import { describe, expect, it } from "vitest";
import { aggregateFrontRate, decayPerHour } from "../src/enrichment";
import { HPC_CAMPAIGN_TYPES, normalizeCampaign } from "../src/invariants";
import type { NormalizeContext, RawCampaign, RawEvent } from "../src/types";

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

describe("aggregateFrontRate: per-front sum of signed rates", () => {
  it("sums signed rates across a fully rated front", () => {
    expect(aggregateFrontRate([10_000, -3_000, 500])).toEqual({
      net_hp_per_hour: 7_500,
      planets_with_rate: 3,
      planets_total: 3,
    });
  });

  it("mixed front: sums only the rated planets; counts reflect the split", () => {
    expect(aggregateFrontRate([null, -5_000, null, 2_000])).toEqual({
      net_hp_per_hour: -3_000,
      planets_with_rate: 2,
      planets_total: 4,
    });
  });

  it("never coerces null to 0 — [null] and [0] are different fronts", () => {
    // A stabilizing planet is an UNKNOWN: no contribution, not counted.
    expect(aggregateFrontRate([null])).toEqual({
      net_hp_per_hour: null,
      planets_with_rate: 0,
      planets_total: 1,
    });
    // A genuine stalemate rate of 0 IS a known rate and counts as coverage.
    expect(aggregateFrontRate([0])).toEqual({
      net_hp_per_hour: 0,
      planets_with_rate: 1,
      planets_total: 1,
    });
  });

  it("all-stabilizing front → null sum (honest unknown), never a fake 0", () => {
    expect(aggregateFrontRate([null, null, null])).toEqual({
      net_hp_per_hour: null,
      planets_with_rate: 0,
      planets_total: 3,
    });
  });

  it("a negative aggregate is returned as the bare number — no label, no alert", () => {
    const out = aggregateFrontRate([-50_000, 10_000]);
    expect(out.net_hp_per_hour).toBe(-40_000);
    expect(Object.keys(out).sort()).toEqual([
      "net_hp_per_hour",
      "planets_total",
      "planets_with_rate",
    ]);
  });

  it("a zero aggregate (rated stalemate) is 0, not null", () => {
    expect(aggregateFrontRate([7_000, -7_000]).net_hp_per_hour).toBe(0);
  });

  it("excludes garbled (non-finite) rates from sum and coverage alike", () => {
    expect(aggregateFrontRate([Number.NaN, 1_000])).toEqual({
      net_hp_per_hour: 1_000,
      planets_with_rate: 1,
      planets_total: 2,
    });
  });

  it("empty front → null sum with zero counts", () => {
    expect(aggregateFrontRate([])).toEqual({
      net_hp_per_hour: null,
      planets_with_rate: 0,
      planets_total: 0,
    });
  });
});

describe("one signed source of truth: the front sum consumes the per-campaign rates", () => {
  it("aggregates the exact hp_per_hour values normalizeCampaign emitted — no recompute", () => {
    const rates = [12_345.678, -9_876.5, null];
    const normalized = rates.map((hpPerHour, i) =>
      normalizeCampaign(
        makeCampaign({ id: i, planet: { index: 100 + i } }),
        ctx({ hpPerHour }),
      ),
    );
    // The per-campaign signed values pass through normalization untouched…
    expect(normalized.map((n) => n.hp_per_hour)).toEqual(rates);
    // …and the front aggregate is float-exactly their sum (toBe, not close).
    const out = aggregateFrontRate(normalized.map((n) => n.hp_per_hour));
    expect(out.net_hp_per_hour).toBe(12_345.678 + -9_876.5);
    expect(out.planets_with_rate).toBe(2);
    expect(out.planets_total).toBe(3);
  });
});

describe("decay_per_hour: pure unit conversion of normalized regen", () => {
  it("liberation: regen × 3600, positive", () => {
    expect(decayPerHour(1.5)).toBe(5_400);
    expect(decayPerHour(2.7777777)).toBeCloseTo(9_999.99972, 4);
  });

  it("missing or garbled regen → null, never fabricated", () => {
    expect(decayPerHour(null)).toBeNull();
    expect(decayPerHour(Number.NaN)).toBeNull();
    expect(decayPerHour(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("liberation pipeline: derived from the normalized regen field", () => {
    const normalized = normalizeCampaign(
      makeCampaign({ planet: { regenPerSecond: 1.39 } }),
      ctx(),
    );
    expect(normalized.regen_per_second).toBeCloseTo(1.39);
    expect(decayPerHour(normalized.regen_per_second)).toBeCloseTo(5_004);
  });

  it("REGRESSION — defense campaign: invariant 1 survives the conversion", () => {
    // Upstream sends a real-looking regen on a defense; invariant 1 nulls it,
    // and the unit conversion must derive from that nulled value — a defense
    // can never re-expose its cosmetic decay as decay_per_hour.
    const defense = makeCampaign({
      planet: { event: makeEvent(), regenPerSecond: 2.78 },
    });
    const normalized = normalizeCampaign(defense, ctx());
    expect(normalized.campaign_kind).toBe("defense");
    expect(normalized.regen_per_second).toBeNull();
    expect(decayPerHour(normalized.regen_per_second)).toBeNull();

    // The trap this guards against: converting the RAW upstream regen would
    // resurrect the suppressed decay. Prove the wrong path is non-null, so
    // this test fails if anyone ever rewires the derivation to raw data.
    expect(decayPerHour(defense.planet.regenPerSecond)).not.toBeNull();
  });
});
