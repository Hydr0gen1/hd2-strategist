/**
 * Stage 9 tests: dual ETAs (instantaneous + historical) with divergence.
 *
 * The one class of derived number this project permits is a projection under
 * strict transparency rules: BOTH projections presented with their
 * assumptions, a deterministic divergence between the two rates, machine-
 * readable reasons on every null ETA, and — on defenses — competing clocks,
 * NEVER a success prediction. These tests pin the arithmetic, the
 * thin-history honesty, and the absence of any verdict key.
 *
 * Pure throughout, except the sanctioned KV-stub handler tests (stage6
 * pattern): raw cache pre-seeded fresh + a throwing fetch stub.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDefenseEtaBlock,
  buildEtaBlock,
  buildMoHistorySeries,
  historyRateAggregates,
  moIntervalRates,
  perIntervalRates,
  RATE_DIVERGENCE_THRESHOLD_PCT,
  rateDivergence,
  seriesSpanHours,
} from "../src/enrichment";
import { getCampaigns, getMajorOrder, getMajorOrderHistory } from "../src/tools";
import type {
  HealthSample,
  MoObjectiveSeries,
  MoProgressSample,
} from "../src/sampling";
import type { Env, RawAssignment, RawEvent, RawPlanet } from "../src/types";

const HOUR_MS = 3_600_000;
const NOW = 1_780_000_000_000;

/* ====================================================================== *
 * Interval-rate derivations — one source, shared with the history tools
 * ====================================================================== */

describe("perIntervalRates / moIntervalRates", () => {
  it("perIntervalRates uses the hp_per_hour sign convention and IS the historyRateAggregates derivation", () => {
    const samples: HealthSample[] = [
      { h: 1_000_000, t: NOW },
      { h: 990_000, t: NOW + HOUR_MS }, // +10k/h (depleting = progressing)
      { h: 1_010_000, t: NOW + 2 * HOUR_MS }, // −20k/h (rising = losing)
    ];
    const rates = perIntervalRates(samples);
    expect(rates).toEqual([10_000, -20_000]);
    // Parity with the Stage 5 aggregates — never a parallel path.
    const agg = historyRateAggregates(samples);
    expect(agg.rate_mean).toBe((10_000 - 20_000) / 2);
    expect(agg.latest_rate).toBe(rates[rates.length - 1]);
  });

  it("perIntervalRates skips non-positive time deltas, never divides", () => {
    expect(
      perIntervalRates([
        { h: 10, t: NOW },
        { h: 5, t: NOW }, // Δt = 0 — skipped
        { h: 1, t: NOW + HOUR_MS },
      ]),
    ).toEqual([(5 - 1) / 1]);
  });

  it("moIntervalRates: progress counts UP, positive = progressing; null-progress pairs skipped (missing is never 0)", () => {
    const samples: MoProgressSample[] = [
      { t: NOW, progress: 100_000, target: 1_750_000 },
      { t: NOW + HOUR_MS, progress: 110_000, target: 1_750_000 }, // +10k/h
      { t: NOW + 2 * HOUR_MS, progress: null, target: 1_750_000 }, // both adjacent pairs skipped
      { t: NOW + 3 * HOUR_MS, progress: 120_000, target: 1_750_000 },
      { t: NOW + 4 * HOUR_MS, progress: 140_000, target: 1_750_000 }, // +20k/h
    ];
    expect(moIntervalRates(samples)).toEqual([10_000, 20_000]);
  });

  it("seriesSpanHours: <2 points → null (the existing insufficient_history threshold)", () => {
    expect(seriesSpanHours([])).toBeNull();
    expect(seriesSpanHours([{ t: NOW }])).toBeNull();
    expect(seriesSpanHours([{ t: NOW }, { t: NOW + 3 * HOUR_MS }])).toBe(3);
  });
});

/* ====================================================================== *
 * rateDivergence — arithmetic, never a judgment
 * ====================================================================== */

describe("rateDivergence", () => {
  it("abs/pct are exact; pct is symmetric over max(|a|,|b|)", () => {
    const d = rateDivergence(10_000, 15_000)!;
    expect(d.abs_diff).toBe(5_000);
    expect(d.pct_diff).toBeCloseTo((5_000 / 15_000) * 100, 10);
    expect(d.diverging).toBe(false);
    // Symmetric: swapping the arguments changes nothing but who is "a".
    expect(rateDivergence(15_000, 10_000)).toEqual(d);
  });

  it("null when EITHER rate is null — one number cannot be compared to nothing", () => {
    expect(rateDivergence(null, 10_000)).toBeNull();
    expect(rateDivergence(10_000, null)).toBeNull();
    expect(rateDivergence(null, null)).toBeNull();
  });

  it("both rates 0 → abs 0, pct 0 — never a divide-by-zero", () => {
    expect(rateDivergence(0, 0)).toEqual({
      abs_diff: 0,
      pct_diff: 0,
      diverging: false,
    });
  });

  it("diverging flips exactly at the documented threshold", () => {
    // pct = 50 exactly: rates 100 and 50.
    expect(rateDivergence(100, 50)!.diverging).toBe(true);
    expect(rateDivergence(100, 51)!.diverging).toBe(false);
    expect(RATE_DIVERGENCE_THRESHOLD_PCT).toBe(50);
  });

  it("a rate of 0 against a non-zero rate is comparable: pct 100", () => {
    const d = rateDivergence(0, 10_000)!;
    expect(d.abs_diff).toBe(10_000);
    expect(d.pct_diff).toBe(100);
    expect(d.diverging).toBe(true);
  });
});

/* ====================================================================== *
 * buildEtaBlock — the dual model on a known fixture
 * ====================================================================== */

describe("buildEtaBlock", () => {
  const KNOWN = {
    distance: 600_000,
    instantaneousRate: 10_000,
    intervalRates: [10_000, 20_000],
    sampleCount: 3,
    samplesSpanHours: 2,
  };

  it("liberation fixture: eta_instantaneous = distance ÷ current rate, eta_historical = distance ÷ mean trend rate", () => {
    const eta = buildEtaBlock(KNOWN);
    expect(eta.eta_instantaneous_hours).toBe(600_000 / 10_000); // 60
    expect(eta.instantaneous_rate).toBe(10_000);
    expect(eta.eta_instantaneous_reason).toBeNull();
    expect(eta.historical_rate).toBe(15_000); // unweighted mean
    expect(eta.eta_historical_hours).toBe(600_000 / 15_000); // 40
    expect(eta.eta_historical_reason).toBeNull();
    expect(eta.sample_count).toBe(3);
    expect(eta.samples_span_hours).toBe(2);
  });

  it("rate_stability is the observed spread (max − min) of the interval rates; null below two rates", () => {
    expect(buildEtaBlock(KNOWN).rate_stability).toBe(10_000);
    expect(
      buildEtaBlock({ ...KNOWN, intervalRates: [10_000, 25_000, 7_000] })
        .rate_stability,
    ).toBe(18_000);
    expect(
      buildEtaBlock({ ...KNOWN, intervalRates: [10_000] }).rate_stability,
    ).toBeNull();
  });

  it("rate_divergence rides the block and is null when either rate is null", () => {
    const eta = buildEtaBlock(KNOWN);
    expect(eta.rate_divergence).toEqual(rateDivergence(10_000, 15_000));
    expect(
      buildEtaBlock({ ...KNOWN, instantaneousRate: null }).rate_divergence,
    ).toBeNull();
    expect(
      buildEtaBlock({ ...KNOWN, intervalRates: [] }).rate_divergence,
    ).toBeNull();
  });

  it("a negative rate projects by MAGNITUDE (the invariant-3 convention); the signed rate rides alongside", () => {
    const eta = buildEtaBlock({
      ...KNOWN,
      instantaneousRate: -10_000,
      intervalRates: [-10_000, -20_000],
    });
    expect(eta.eta_instantaneous_hours).toBe(60);
    expect(eta.instantaneous_rate).toBe(-10_000); // sign preserved as a fact
    expect(eta.eta_historical_hours).toBe(40);
    expect(eta.historical_rate).toBe(-15_000);
  });

  it("no current rate → instantaneous null + reason no_current_rate; historical still computed", () => {
    const eta = buildEtaBlock({ ...KNOWN, instantaneousRate: null });
    expect(eta.eta_instantaneous_hours).toBeNull();
    expect(eta.eta_instantaneous_reason).toBe("no_current_rate");
    expect(eta.eta_historical_hours).toBe(40);
  });

  it("too few history points → historical null + reason insufficient_history; instantaneous still computed", () => {
    const eta = buildEtaBlock({
      ...KNOWN,
      intervalRates: [],
      sampleCount: 1,
      samplesSpanHours: null,
    });
    expect(eta.eta_historical_hours).toBeNull();
    expect(eta.historical_rate).toBeNull();
    expect(eta.eta_historical_reason).toBe("insufficient_history");
    expect(eta.eta_instantaneous_hours).toBe(60);
    expect(eta.sample_count).toBe(1);
  });

  it("rate 0 in either path → null + stalemate — never a divide-by-zero, never Infinity", () => {
    const instStale = buildEtaBlock({ ...KNOWN, instantaneousRate: 0 });
    expect(instStale.eta_instantaneous_hours).toBeNull();
    expect(instStale.eta_instantaneous_reason).toBe("stalemate");
    const histStale = buildEtaBlock({
      ...KNOWN,
      intervalRates: [10_000, -10_000], // mean exactly 0
    });
    expect(histStale.eta_historical_hours).toBeNull();
    expect(histStale.eta_historical_reason).toBe("stalemate");
    expect(histStale.historical_rate).toBe(0);
    for (const block of [instStale, histStale]) {
      for (const value of Object.values(block)) {
        if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("unknown distance → both ETAs null + reason unknown_distance — never substituted with 0", () => {
    const eta = buildEtaBlock({ ...KNOWN, distance: null });
    expect(eta.eta_instantaneous_hours).toBeNull();
    expect(eta.eta_instantaneous_reason).toBe("unknown_distance");
    expect(eta.eta_historical_hours).toBeNull();
    expect(eta.eta_historical_reason).toBe("unknown_distance");
    // The observed rates remain reported as facts.
    expect(eta.instantaneous_rate).toBe(10_000);
    expect(eta.historical_rate).toBe(15_000);
  });

  it("every null ETA carries a reason; every computed ETA carries none", () => {
    const computed = buildEtaBlock(KNOWN);
    expect(computed.eta_instantaneous_reason).toBeNull();
    expect(computed.eta_historical_reason).toBeNull();
    const bare = buildEtaBlock({
      distance: 100,
      instantaneousRate: null,
      intervalRates: [],
      sampleCount: 0,
      samplesSpanHours: null,
    });
    expect(bare.eta_instantaneous_reason).not.toBeNull();
    expect(bare.eta_historical_reason).not.toBeNull();
  });
});

/* ====================================================================== *
 * buildDefenseEtaBlock — competing clocks, never a prediction
 * ====================================================================== */

const walkKeys = (value: unknown, keys: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((v) => walkKeys(v, keys));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      walkKeys(v, keys);
    }
  }
  return keys;
};

describe("buildDefenseEtaBlock", () => {
  const DEFENSE = {
    distance: 728_250, // the Bore Rock orientation: high event HP = far from winning
    instantaneousRate: 15_000,
    intervalRates: [15_000, 45_000],
    sampleCount: 3,
    samplesSpanHours: 2,
    defenseHoursRemaining: 14,
  };

  it("both depletion ETAs are computed under the dual model", () => {
    const eta = buildDefenseEtaBlock(DEFENSE);
    expect(eta.depletion_eta_instantaneous_hours).toBeCloseTo(728_250 / 15_000, 10);
    expect(eta.depletion_eta_historical_hours).toBeCloseTo(728_250 / 30_000, 10);
    expect(eta.instantaneous_rate).toBe(15_000);
    expect(eta.historical_rate).toBe(30_000);
    expect(eta.defense_hours_remaining).toBe(14);
  });

  it("the window comparison is evaluated against EACH rate, labeled which one it used", () => {
    // Instantaneous misses the window (~48.6h > 14h), historical too (~24.3h).
    const losing = buildDefenseEtaBlock(DEFENSE);
    expect(losing.resolution_within_defense_window_instantaneous).toBe(false);
    expect(losing.resolution_within_defense_window_historical).toBe(false);
    // A fast current rate makes ONLY the instantaneous comparison true —
    // the two columns are independent, the server names no winner.
    const regimeChange = buildDefenseEtaBlock({
      ...DEFENSE,
      instantaneousRate: 100_000, // ~7.3h — inside the window
    });
    expect(regimeChange.resolution_within_defense_window_instantaneous).toBe(true);
    expect(regimeChange.resolution_within_defense_window_historical).toBe(false);
  });

  it("comparisons are null when the ETA or the window is null — never guessed", () => {
    const noRate = buildDefenseEtaBlock({
      ...DEFENSE,
      instantaneousRate: null,
    });
    expect(noRate.resolution_within_defense_window_instantaneous).toBeNull();
    expect(noRate.depletion_eta_instantaneous_reason).toBe("no_current_rate");
    const noWindow = buildDefenseEtaBlock({
      ...DEFENSE,
      defenseHoursRemaining: null,
    });
    expect(noWindow.resolution_within_defense_window_instantaneous).toBeNull();
    expect(noWindow.resolution_within_defense_window_historical).toBeNull();
    expect(noWindow.defense_hours_remaining).toBeNull();
  });

  it("Stage 7 orientation preserved: a defense near max event HP yields a LARGE depletion ETA, never nearly-done", () => {
    const eta = buildDefenseEtaBlock(DEFENSE);
    expect(eta.depletion_eta_instantaneous_hours!).toBeGreaterThan(48);
  });

  it("emits NO success/failure/verdict key — competing clocks only (key-name pin)", () => {
    for (const key of walkKeys(buildDefenseEtaBlock(DEFENSE))) {
      expect(key).not.toMatch(
        /success|fail|won|lost|outcome|predict|on_track|behind|verdict|recommend|winner/i,
      );
    }
  });
});

/* ====================================================================== *
 * End-to-end (KV stub, stage6 pattern): the eta blocks on the live tools
 * ====================================================================== */

interface FakeKv {
  store: Map<string, string>;
  puts: { key: string; ttl?: number }[];
  get(key: string, type: "json"): Promise<unknown>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
}

function fakeKv(): FakeKv {
  return {
    store: new Map<string, string>(),
    puts: [],
    async get(key: string) {
      const raw = this.store.get(key);
      return raw == null ? null : JSON.parse(raw);
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      this.store.set(key, value);
      this.puts.push({ key, ttl: opts?.expirationTtl });
    },
  };
}

function envWith(kv: FakeKv): Env {
  return { WAR_CACHE: kv as unknown as KVNamespace };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidNetwork(): void {
  globalThis.fetch = (() => {
    throw new Error("network touched — the shared cache should have served this");
  }) as unknown as typeof fetch;
}

function makePlanet(over: Partial<RawPlanet> = {}): RawPlanet {
  return {
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
    ...over,
  };
}

function makeAssignment(over: Partial<RawAssignment> = {}): RawAssignment {
  return {
    id: 9001,
    progress: [130_000],
    title: "LIBERATE",
    briefing: "Brief",
    description: "Desc",
    tasks: [{ type: 9, values: [1, 1_750_000, 175], valueTypes: [1, 3, 12] }],
    reward: { type: 1, amount: 45 },
    rewards: [],
    expiration: new Date(Date.now() + 86_400_000).toISOString(),
    flags: 0,
    ...over,
  };
}

function seedRaw(kv: FakeKv, path: string, body: unknown): void {
  kv.store.set(
    `raw:${path}`,
    JSON.stringify({ fetchedAt: Date.now() - 1_000, body }),
  );
}

function seedCampaignEnv(kv: FakeKv): Env {
  const now = Date.now();
  const libPlanet = makePlanet();
  const defEvent: RawEvent = {
    id: 1,
    eventType: 1,
    faction: "Terminids",
    health: 728_250,
    maxHealth: 750_000,
    startTime: new Date(now - 9.5 * HOUR_MS).toISOString(),
    endTime: new Date(now + 14 * HOUR_MS).toISOString(),
    campaignId: 43,
  };
  const defPlanet = makePlanet({
    index: 124,
    name: "BORE ROCK",
    event: defEvent,
  });
  seedRaw(kv, "/api/v1/planets", [libPlanet, defPlanet]);
  seedRaw(kv, "/api/v1/campaigns", [
    { id: 42, planet: libPlanet, type: 0, count: 1, faction: "Terminids" },
    { id: 43, planet: defPlanet, type: 4, count: 1, faction: "Terminids" },
  ]);
  seedRaw(kv, "/api/v1/assignments", []);
  // Hour-old samples so a signed rate exists on this poll: liberation
  // 610,000 → 600,000 (~+10k/h) and defense event 743,250 → 728,250 (~+15k/h).
  kv.store.set(
    "samples:planets",
    JSON.stringify({
      planets: {
        "175": { samples: [{ h: 610_000, t: now - HOUR_MS }], lastRate: null },
        "124": { samples: [{ h: 743_250, t: now - HOUR_MS }], lastRate: null },
      },
      campaignsFirstSeen: { "42": now - 2 * HOUR_MS, "43": now - 2 * HOUR_MS },
    }),
  );
  return envWith(kv);
}

describe("get_campaigns: eta blocks ride every campaign", () => {
  it("liberation eta reuses the ONE projection: eta_instantaneous_hours === hours_to_resolution; budget unchanged", async () => {
    const kv = fakeKv();
    const env = seedCampaignEnv(kv);
    forbidNetwork();

    const out = (await getCampaigns(env)) as {
      campaigns: Array<Record<string, any>>;
      notes: Record<string, string>;
    };
    const lib = out.campaigns.find((c) => c.campaign_kind === "liberation")!;
    expect(lib.eta).toBeDefined();
    // One source of truth: same distance ÷ |rate| arithmetic as invariant 3.
    expect(lib.eta.eta_instantaneous_hours).toBe(lib.hours_to_resolution);
    expect(lib.eta.instantaneous_rate).toBe(lib.hp_per_hour);
    // Two samples now retained → one interval rate → historical computable.
    expect(lib.eta.sample_count).toBe(2);
    expect(lib.eta.eta_historical_hours).not.toBeNull();
    expect(lib.eta.rate_divergence).not.toBeNull();
    // The dual-ETA assumptions ride the payload as notes.
    expect(out.notes.eta).toContain("eta_instantaneous_hours");
    expect(out.notes.defense_eta).toContain("depletion_eta");
    // Write budget unchanged: exactly one samples:planets put for the poll.
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(1);
  });

  it("defense carries competing depletion ETAs vs the deadline, consistent with Stage 7, with NO verdict key", async () => {
    const kv = fakeKv();
    const env = seedCampaignEnv(kv);
    forbidNetwork();

    const out = (await getCampaigns(env)) as {
      campaigns: Array<Record<string, any>>;
    };
    const def = out.campaigns.find((c) => c.campaign_kind === "defense")!;
    expect(def.eta.depletion_eta_instantaneous_hours).toBe(
      def.hours_to_resolution,
    );
    expect(def.eta.depletion_eta_historical_hours).not.toBeNull();
    expect(def.eta.defense_hours_remaining).toBe(def.defense_hours_remaining);
    // ~48.6h to deplete vs a 14h window — both comparisons false, labeled.
    expect(def.eta.resolution_within_defense_window_instantaneous).toBe(
      def.resolution_within_defense_window, // agrees with the Stage 7 field
    );
    expect(def.eta.resolution_within_defense_window_instantaneous).toBe(false);
    expect(def.eta.resolution_within_defense_window_historical).toBe(false);
    for (const key of walkKeys(def.eta)) {
      expect(key).not.toMatch(
        /success|fail|won|lost|outcome|predict|on_track|behind|verdict|winner/i,
      );
    }
    // No single-ETA field: the liberation key names do not appear on a defense.
    expect("eta_instantaneous_hours" in def.eta).toBe(false);
  });

  it("cold start: no rate and a one-point series → both ETAs null with machine-readable reasons", async () => {
    const kv = fakeKv();
    const env = seedCampaignEnv(kv);
    kv.store.delete("samples:planets"); // cold start
    forbidNetwork();

    const out = (await getCampaigns(env)) as {
      campaigns: Array<Record<string, any>>;
    };
    const lib = out.campaigns.find((c) => c.campaign_kind === "liberation")!;
    expect(lib.eta.eta_instantaneous_hours).toBeNull();
    expect(lib.eta.eta_instantaneous_reason).toBe("no_current_rate");
    expect(lib.eta.eta_historical_hours).toBeNull();
    expect(lib.eta.eta_historical_reason).toBe("insufficient_history");
    expect(lib.eta.rate_divergence).toBeNull();
  });
});

/* ---------------------- Major Order objective ETAs --------------------- */

function moSeries(
  samples: MoProgressSample[],
  over: Partial<MoObjectiveSeries> = {},
): MoObjectiveSeries {
  return {
    major_order_id: 9001,
    objective_index: 0,
    task_type: 9,
    samples,
    ...over,
  };
}

function seedMoStore(kv: FakeKv, mo: MoObjectiveSeries[]): void {
  kv.store.set(
    "samples:planets",
    JSON.stringify({ planets: {}, campaignsFirstSeen: {}, mo }),
  );
}

describe("get_major_order: objective eta from the Stage 8 series", () => {
  it("instantaneous from the LATEST observed delta, historical from the series mean; (target − progress) numerator", async () => {
    const kv = fakeKv();
    const t0 = Date.now() - 3 * HOUR_MS;
    seedRaw(kv, "/api/v1/assignments", [makeAssignment()]);
    seedMoStore(kv, [
      moSeries([
        { t: t0, progress: 100_000, target: 1_750_000 },
        { t: t0 + HOUR_MS, progress: 110_000, target: 1_750_000 }, // +10k/h
        { t: t0 + 2 * HOUR_MS, progress: 130_000, target: 1_750_000 }, // +20k/h (latest)
      ]),
    ]);
    forbidNetwork();

    const out = (await getMajorOrder(envWith(kv))) as {
      major_orders: Array<{ objectives: Array<Record<string, any>> }>;
      notes: Record<string, string>;
    };
    const eta = out.major_orders[0]!.objectives[0]!.eta;
    // distance = target − progress = 1,750,000 − 130,000 = 1,620,000.
    expect(eta.instantaneous_rate).toBe(20_000); // the latest delta
    expect(eta.eta_instantaneous_hours).toBe(1_620_000 / 20_000); // 81
    expect(eta.historical_rate).toBe(15_000); // mean of the deltas
    expect(eta.eta_historical_hours).toBe(1_620_000 / 15_000); // 108
    expect(eta.sample_count).toBe(3);
    expect(eta.samples_span_hours).toBe(2);
    expect(eta.rate_stability).toBe(10_000);
    expect(eta.rate_divergence!.abs_diff).toBe(5_000);
    expect(out.notes.eta).toContain("eta_historical_hours");
    // Read-only on the sample store: zero KV writes.
    expect(kv.puts).toEqual([]);
  });

  it("no retained series (cold start) → null ETAs with reasons, never an error", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/assignments", [makeAssignment()]);
    forbidNetwork();

    const out = (await getMajorOrder(envWith(kv))) as {
      major_orders: Array<{ objectives: Array<Record<string, any>> }>;
    };
    const eta = out.major_orders[0]!.objectives[0]!.eta;
    expect(eta.eta_instantaneous_hours).toBeNull();
    expect(eta.eta_instantaneous_reason).toBe("no_current_rate");
    expect(eta.eta_historical_hours).toBeNull();
    expect(eta.eta_historical_reason).toBe("insufficient_history");
    expect(eta.sample_count).toBe(0);
  });
});

describe("get_major_order_history: eta rides BESIDE the untouched observed series", () => {
  it("each series gains an eta computed from its own latest progress/target; samples/deltas unchanged", async () => {
    const kv = fakeKv();
    const t0 = Date.now() - 3 * HOUR_MS;
    seedRaw(kv, "/api/v1/assignments", [makeAssignment()]);
    seedMoStore(kv, [
      moSeries([
        { t: t0, progress: 100_000, target: 1_750_000 },
        { t: t0 + HOUR_MS, progress: 110_000, target: 1_750_000 },
        { t: t0 + 2 * HOUR_MS, progress: 130_000, target: 1_750_000 },
      ]),
    ]);
    forbidNetwork();

    const out = (await getMajorOrderHistory(envWith(kv), {})) as {
      series: Array<Record<string, any>>;
    };
    const series = out.series[0]!;
    expect(series.eta.eta_instantaneous_hours).toBe(81);
    expect(series.eta.eta_historical_hours).toBe(108);
    // The Stage 8 shape is untouched beside it (additive only).
    const shaped = buildMoHistorySeries(
      moSeries([
        { t: t0, progress: 100_000, target: 1_750_000 },
        { t: t0 + HOUR_MS, progress: 110_000, target: 1_750_000 },
        { t: t0 + 2 * HOUR_MS, progress: 130_000, target: 1_750_000 },
      ]),
    );
    const { eta: _eta, ...withoutEta } = series;
    expect(withoutEta).toEqual(shaped);
    expect(kv.puts).toEqual([]); // still read-only
  });
});
