/**
 * Stage 8 tests: the Major Order objective-progress accumulation layer
 * (advanceMoSeries folded into the single per-poll KV write) and the
 * get_major_order_history tool shape. Pure throughout, except the two
 * sanctioned in-memory-KV patterns: samplePlanetRates (proving the
 * one-write budget) and the getMajorOrderHistory handler against a
 * pre-seeded fresh raw cache with a throwing fetch stub (proving zero
 * extra upstream volume and zero sample-store writes).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  SAMPLES_KEY_TTL_SECONDS,
  samplePlanetRates,
} from "../src/client";
import {
  buildMoHistorySeries,
  decodeObjectiveTarget,
  moProgressObservations,
  objectiveProgressPct,
  shapeMajorOrders,
} from "../src/enrichment";
import { getMajorOrderHistory } from "../src/tools";
import {
  MAX_GLOBAL_SAMPLES,
  MAX_MO_SAMPLES,
  MAX_MO_SERIES,
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLES_PER_PLANET,
  MAX_SIGNATURES,
  MIN_SAMPLE_INTERVAL_MS,
  advanceMoSeries,
  coerceStore,
  type HealthSample,
  type MoObjectiveSeries,
  type MoProgressObservation,
  type SampleStore,
} from "../src/sampling";
import type { Env, RawAssignment } from "../src/types";

const HOUR_MS = 3_600_000;
const NOW = 1_780_000_000_000;

function moObs(
  overrides: Partial<MoProgressObservation> = {},
): MoProgressObservation {
  return {
    majorOrderId: 9001,
    objectiveIndex: 0,
    taskType: 9,
    progress: 100_000,
    target: 1_750_000,
    ...overrides,
  };
}

/* ====================================================================== *
 * advanceMoSeries — the bounded per-objective ring buffer
 * ====================================================================== */

describe("advanceMoSeries: MO progress sampling", () => {
  it("seeds a new series with {t, progress, target} and the raw task_type", () => {
    const out = advanceMoSeries(undefined, [moObs()], NOW);
    expect(out).toEqual([
      {
        major_order_id: 9001,
        objective_index: 0,
        task_type: 9,
        samples: [{ t: NOW, progress: 100_000, target: 1_750_000 }],
      },
    ]);
  });

  it("appends past the 60s guard; the series stays oldest → newest", () => {
    const seeded = advanceMoSeries(undefined, [moObs()], NOW);
    const later = NOW + MIN_SAMPLE_INTERVAL_MS;
    const out = advanceMoSeries(seeded, [moObs({ progress: 110_000 })], later);
    expect(out[0]!.samples).toEqual([
      { t: NOW, progress: 100_000, target: 1_750_000 },
      { t: later, progress: 110_000, target: 1_750_000 },
    ]);
  });

  it("does NOT append within the 60s guard — cache replays never double-sample", () => {
    const seeded = advanceMoSeries(undefined, [moObs()], NOW);
    const out = advanceMoSeries(
      seeded,
      [moObs({ progress: 999_999 })],
      NOW + 5_000,
    );
    expect(out[0]!.samples).toHaveLength(1);
    expect(out[0]!.samples[0]!.progress).toBe(100_000);
  });

  it("tracks multiple objectives of one MO as independent series", () => {
    const out = advanceMoSeries(
      undefined,
      [
        moObs({ objectiveIndex: 0, progress: 1 }),
        moObs({ objectiveIndex: 1, taskType: 13, progress: 2, target: 1 }),
      ],
      NOW,
    );
    expect(out).toHaveLength(2);
    const idx0 = out.find((s) => s.objective_index === 0)!;
    const idx1 = out.find((s) => s.objective_index === 1)!;
    expect(idx0.samples[0]!.progress).toBe(1);
    expect(idx1.samples[0]!.progress).toBe(2);
    expect(idx1.task_type).toBe(13);
  });

  it("MO turnover: a new id starts fresh; the old series is retained with no point cross-contamination", () => {
    const oldSeries = advanceMoSeries(undefined, [moObs()], NOW);
    const afterTurnover = advanceMoSeries(
      oldSeries,
      [moObs({ majorOrderId: 9002, progress: 5 })],
      NOW + MIN_SAMPLE_INTERVAL_MS,
    );
    expect(afterTurnover).toHaveLength(2);
    const old = afterTurnover.find((s) => s.major_order_id === 9001)!;
    const fresh = afterTurnover.find((s) => s.major_order_id === 9002)!;
    expect(old.samples).toEqual([
      { t: NOW, progress: 100_000, target: 1_750_000 },
    ]);
    expect(fresh.samples).toEqual([
      { t: NOW + MIN_SAMPLE_INTERVAL_MS, progress: 5, target: 1_750_000 },
    ]);
  });

  it("a prior MO's series ages out: stale samples drop, an emptied series disappears", () => {
    const old: MoObjectiveSeries[] = [
      {
        major_order_id: 9001,
        objective_index: 0,
        task_type: 9,
        samples: [
          { t: NOW - MAX_SAMPLE_AGE_MS - HOUR_MS, progress: 1, target: 10 },
          { t: NOW - HOUR_MS, progress: 2, target: 10 },
        ],
      },
      {
        major_order_id: 8000,
        objective_index: 0,
        task_type: null,
        samples: [
          { t: NOW - MAX_SAMPLE_AGE_MS - HOUR_MS, progress: 1, target: 10 },
        ],
      },
    ];
    const out = advanceMoSeries(old, [moObs({ majorOrderId: 9002 })], NOW);
    // 9001: stale sample evicted, recent one retained. 8000: fully aged → gone.
    const retained = out.find((s) => s.major_order_id === 9001)!;
    expect(retained.samples).toEqual([
      { t: NOW - HOUR_MS, progress: 2, target: 10 },
    ]);
    expect(out.find((s) => s.major_order_id === 8000)).toBeUndefined();
    expect(out.find((s) => s.major_order_id === 9002)).toBeDefined();
  });

  it("no active MO: existing series carry forward (until age-out), nothing is wiped", () => {
    const seeded = advanceMoSeries(undefined, [moObs()], NOW);
    const out = advanceMoSeries(seeded, [], NOW + HOUR_MS);
    expect(out).toEqual(seeded);
    expect(advanceMoSeries(undefined, [], NOW)).toEqual([]);
  });

  it("missing progress/target are null in the sample — never 0", () => {
    const out = advanceMoSeries(
      undefined,
      [moObs({ progress: null, target: null })],
      NOW,
    );
    expect(out[0]!.samples[0]).toEqual({ t: NOW, progress: null, target: null });
  });

  it("a target of 0 is recorded as observed (0 is a real upstream value, not missing)", () => {
    const out = advanceMoSeries(undefined, [moObs({ target: 0 })], NOW);
    expect(out[0]!.samples[0]!.target).toBe(0);
  });

  it("an observation without a finite MO id or objective index is skipped — identity is never guessed", () => {
    const out = advanceMoSeries(
      undefined,
      [
        moObs({ majorOrderId: Number.NaN }),
        moObs({ objectiveIndex: Number.POSITIVE_INFINITY }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("dedupes duplicate observations of one objective within a cycle (first wins)", () => {
    const out = advanceMoSeries(
      undefined,
      [moObs({ progress: 1 }), moObs({ progress: 2 })],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.samples).toEqual([{ t: NOW, progress: 1, target: 1_750_000 }]);
  });

  it("each series is bounded: never more than MAX_MO_SAMPLES points, newest survives", () => {
    let series: MoObjectiveSeries[] | undefined;
    for (let i = 0; i < MAX_MO_SAMPLES + 20; i++) {
      series = advanceMoSeries(
        series,
        [moObs({ progress: i })],
        NOW + i * MIN_SAMPLE_INTERVAL_MS,
      );
    }
    expect(series![0]!.samples.length).toBeLessThanOrEqual(MAX_MO_SAMPLES);
    expect(series![0]!.samples[series![0]!.samples.length - 1]!.progress).toBe(
      MAX_MO_SAMPLES + 19,
    );
  });

  it("series count is capped at MAX_MO_SERIES, evicting the oldest newest-sample first", () => {
    let series: MoObjectiveSeries[] | undefined;
    for (let i = 0; i < MAX_MO_SERIES + 5; i++) {
      series = advanceMoSeries(
        series,
        [moObs({ majorOrderId: 100 + i })],
        NOW + i * MIN_SAMPLE_INTERVAL_MS,
      );
    }
    expect(series).toHaveLength(MAX_MO_SERIES);
    const ids = new Set(series!.map((s) => s.major_order_id));
    expect(ids.has(100)).toBe(false); // oldest evicted
    expect(ids.has(100 + MAX_MO_SERIES + 4)).toBe(true); // newest kept
  });
});

/* ====================================================================== *
 * Store coercion round-trip (back-compat with pre-Stage-8 stores)
 * ====================================================================== */

describe("coerceStore: Stage 8 mo section", () => {
  it("a pre-Stage-8 store coerces WITHOUT an mo key", () => {
    const out = coerceStore({ planets: {}, campaignsFirstSeen: {} });
    expect("mo" in out).toBe(false);
  });

  it("round-trips stored MO series", () => {
    const mo = advanceMoSeries(undefined, [moObs()], NOW);
    const out = coerceStore(
      JSON.parse(
        JSON.stringify({ planets: {}, campaignsFirstSeen: {}, mo }),
      ),
    );
    expect(out.mo).toEqual(mo);
  });

  it("drops garbage entries (no finite identity / no valid samples) instead of throwing", () => {
    const out = coerceStore({
      planets: {},
      campaignsFirstSeen: {},
      mo: [
        { major_order_id: 1 }, // no objective_index / samples
        { major_order_id: 1, objective_index: 0, samples: [{ progress: 5 }] }, // no finite t
        "junk",
        null,
        {
          major_order_id: 2,
          objective_index: 0,
          task_type: "nope",
          samples: [{ t: NOW, progress: "x", target: 7 }],
        },
      ],
    });
    expect(out.mo).toEqual([
      {
        major_order_id: 2,
        objective_index: 0,
        task_type: null,
        samples: [{ t: NOW, progress: null, target: 7 }],
      },
    ]);
  });
});

/* ====================================================================== *
 * Folded write: the MO layer rides the single existing KV put
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

describe("samplePlanetRates: MO series ride the single existing write", () => {
  const INPUTS = [{ planetIndex: 175, health: 600_000, campaignId: 42 }];

  it("exactly ONE put per call, on samples:planets, containing the folded MO series", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW, {
      moProgress: [moObs()],
    });
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]!.key).toBe("samples:planets");
    expect(kv.puts[0]!.ttl).toBe(SAMPLES_KEY_TTL_SECONDS);
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(stored.mo).toHaveLength(1);
    expect(stored.mo![0]!.samples[0]!.progress).toBe(100_000);
    expect(stored.planets["175"]).toBeDefined();
  });

  it("the batch poll (no carryForward, no moProgress) PRESERVES the MO series", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW, {
      moProgress: [moObs()],
    });
    await samplePlanetRates(
      envWith(kv),
      [{ planetIndex: 9, health: 1_000, campaignId: 7 }],
      NOW + 2 * MIN_SAMPLE_INTERVAL_MS,
    );
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(stored.planets["175"]).toBeUndefined(); // planet semantics unchanged
    expect(stored.mo).toHaveLength(1); // MO layer carried forward
  });

  it("a single-planet probe (carryForward, no opts) preserves the MO series", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW, {
      moProgress: [moObs()],
    });
    const before = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    await samplePlanetRates(
      envWith(kv),
      [{ planetIndex: 64, health: 500, campaignId: null }],
      NOW + 2 * MIN_SAMPLE_INTERVAL_MS,
      { carryForward: true },
    );
    const after = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect(after.mo).toEqual(before.mo);
  });

  it("a store without MO data stays free of an empty mo section", async () => {
    const kv = fakeKv();
    await samplePlanetRates(envWith(kv), INPUTS, NOW);
    const stored = JSON.parse(kv.store.get("samples:planets")!) as SampleStore;
    expect("mo" in stored).toBe(false);
  });
});

/* ====================================================================== *
 * moProgressObservations — one decode, shared with shapeMajorOrders
 * ====================================================================== */

function makeAssignment(over: Partial<RawAssignment> = {}): RawAssignment {
  return {
    id: 9001,
    progress: [281_226, 1],
    title: "LIBERATE",
    briefing: "Brief",
    description: "Desc",
    tasks: [
      { type: 9, values: [1, 1_750_000, 175], valueTypes: [1, 3, 12] },
      { type: 13, values: [1, 78], valueTypes: [3, 12] },
    ],
    reward: { type: 1, amount: 45 },
    rewards: [],
    expiration: new Date(NOW + 86_400_000).toISOString(),
    flags: 0,
    ...over,
  };
}

describe("moProgressObservations: Stage 7 decode reused, never re-derived", () => {
  it("emits one observation per objective with the decoded goal-slot target", () => {
    const out = moProgressObservations([makeAssignment()]);
    expect(out).toEqual([
      {
        majorOrderId: 9001,
        objectiveIndex: 0,
        taskType: 9,
        progress: 281_226,
        target: 1_750_000,
      },
      {
        majorOrderId: 9001,
        objectiveIndex: 1,
        taskType: 13,
        progress: 1,
        target: 1,
      },
    ]);
  });

  it("PARITY: progress/target match shapeMajorOrders' objectives exactly", () => {
    const assignments = [makeAssignment()];
    const objectives = shapeMajorOrders(assignments, NOW)[0]!.objectives;
    const observations = moProgressObservations(assignments);
    expect(observations.map((o) => [o.progress, o.target])).toEqual(
      objectives.map((o) => [o.progress, o.target]),
    );
  });

  it("missing progress entry or goal slot → null, never fabricated", () => {
    const out = moProgressObservations([
      makeAssignment({
        progress: [],
        tasks: [{ type: 11, values: [175], valueTypes: [12] }],
      }),
    ]);
    expect(out).toEqual([
      {
        majorOrderId: 9001,
        objectiveIndex: 0,
        taskType: 11,
        progress: null,
        target: null,
      },
    ]);
  });

  it("an assignment without a finite id is skipped (no series identity)", () => {
    const broken = makeAssignment();
    (broken as { id: unknown }).id = "not-a-number";
    expect(moProgressObservations([broken])).toEqual([]);
  });

  it("decodeObjectiveTarget reads the FIRST valueType-3 slot, like Stage 7", () => {
    expect(
      decodeObjectiveTarget({ type: 9, values: [5, 7], valueTypes: [3, 3] }),
    ).toBe(5);
    expect(
      decodeObjectiveTarget({ type: 9, values: [175], valueTypes: [12] }),
    ).toBeNull();
  });
});

/* ====================================================================== *
 * buildMoHistorySeries — the tool-payload shape
 * ====================================================================== */

function moSeries(
  samples: MoObjectiveSeries["samples"],
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

describe("buildMoHistorySeries: observed deltas, never a forecast", () => {
  it("per-point deltas are exact consecutive differences, first point null", () => {
    const out = buildMoHistorySeries(
      moSeries([
        { t: NOW, progress: 100_000, target: 1_750_000 },
        { t: NOW + HOUR_MS, progress: 112_500, target: 1_750_000 },
        { t: NOW + 3 * HOUR_MS, progress: 110_000, target: 1_750_000 },
      ]),
    );
    expect(out.points).toBe(3);
    expect(out.samples[0]!.delta_progress).toBeNull();
    expect(out.samples[0]!.delta_hours).toBeNull();
    expect(out.samples[1]!.delta_progress).toBe(12_500);
    expect(out.samples[1]!.delta_hours).toBe(1);
    // Negative delta (upstream progress reset) passes through as observed.
    expect(out.samples[2]!.delta_progress).toBe(-2_500);
    expect(out.samples[2]!.delta_hours).toBe(2);
    expect(out.samples_span_hours).toBe(3);
    expect(out.insufficient_history).toBe(false);
    expect(out.latest_progress).toBe(110_000);
    expect(out.target).toBe(1_750_000);
    expect(out.progress_pct).toBeCloseTo((110_000 / 1_750_000) * 100, 2);
    expect(out.samples[1]!.observed_at).toBe(
      new Date(NOW + HOUR_MS).toISOString(),
    );
  });

  it("a null progress at either end makes delta_progress null — missing is never 0", () => {
    const out = buildMoHistorySeries(
      moSeries([
        { t: NOW, progress: null, target: 10 },
        { t: NOW + HOUR_MS, progress: 5, target: 10 },
        { t: NOW + 2 * HOUR_MS, progress: null, target: 10 },
      ]),
    );
    expect(out.samples[1]!.delta_progress).toBeNull(); // prev null
    expect(out.samples[2]!.delta_progress).toBeNull(); // cur null
    expect(out.samples[1]!.delta_hours).toBe(1); // time delta still observed
  });

  it("progress_pct: target 0 or missing → null, never a divide-by-zero or fabricated denominator", () => {
    const zero = buildMoHistorySeries(
      moSeries([
        { t: NOW, progress: 5, target: 0 },
        { t: NOW + HOUR_MS, progress: 6, target: 0 },
      ]),
    );
    expect(zero.progress_pct).toBeNull();
    expect(zero.target).toBe(0);

    const missing = buildMoHistorySeries(
      moSeries([
        { t: NOW, progress: 5, target: null },
        { t: NOW + HOUR_MS, progress: 6, target: null },
      ]),
    );
    expect(missing.progress_pct).toBeNull();

    expect(objectiveProgressPct(null, 100)).toBeNull();
    expect(objectiveProgressPct(50, 100)).toBe(50);
  });

  it("fewer than 2 points → insufficient_history, span null, deltas null", () => {
    const one = buildMoHistorySeries(
      moSeries([{ t: NOW, progress: 1, target: 1 }]),
    );
    expect(one.insufficient_history).toBe(true);
    expect(one.samples_span_hours).toBeNull();
    expect(one.samples[0]!.delta_progress).toBeNull();
    // Latest observed facts are still reported from the single point.
    expect(one.latest_progress).toBe(1);
    expect(one.progress_pct).toBe(100);

    const none = buildMoHistorySeries(moSeries([]));
    expect(none.insufficient_history).toBe(true);
    expect(none.points).toBe(0);
    expect(none.latest_progress).toBeNull();
    expect(none.target).toBeNull();
    expect(none.progress_pct).toBeNull();
  });

  it("objective_kind decodes the stored task_type from the map; unknown type → null label", () => {
    const known = buildMoHistorySeries(
      moSeries([{ t: NOW, progress: 1, target: 1 }]),
    );
    expect(known.objective_kind).toBe("complete_operations"); // task_type 9
    const unknown = buildMoHistorySeries(
      moSeries([{ t: NOW, progress: 1, target: 1 }], { task_type: 77 }),
    );
    expect(unknown.task_type).toBe(77);
    expect(unknown.objective_kind).toBeNull(); // never fabricated
    const injected = buildMoHistorySeries(
      moSeries([{ t: NOW, progress: 1, target: 1 }], { task_type: 77 }),
      new Map([[77, "injected_kind"]]),
    );
    expect(injected.objective_kind).toBe("injected_kind");
  });

  it("emits no forecast/pace/verdict field — observed data only (key-name pin)", () => {
    const out = buildMoHistorySeries(
      moSeries([
        { t: NOW, progress: 1, target: 10 },
        { t: NOW + HOUR_MS, progress: 2, target: 10 },
      ]),
    );
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(out);
    for (const key of keys) {
      expect(key).not.toMatch(
        /forecast|projected|required|pace|track|behind|eta|estimate|recommend|priority|rank|score|verdict/i,
      );
    }
  });
});

/* ====================================================================== *
 * getMajorOrderHistory handler (cache-served, read-only — stage6 pattern)
 * ====================================================================== */

function seedRaw(kv: FakeKv, path: string, body: unknown): void {
  kv.store.set(
    `raw:${path}`,
    JSON.stringify({ fetchedAt: Date.now() - 1_000, body }),
  );
}

function seedMoStore(kv: FakeKv, mo: MoObjectiveSeries[]): void {
  kv.store.set(
    "samples:planets",
    JSON.stringify({ planets: {}, campaignsFirstSeen: {}, mo }),
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidNetwork(): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = (() => {
    counter.calls += 1;
    throw new Error("network touched — the shared cache should have served this");
  }) as unknown as typeof fetch;
  return counter;
}

describe("getMajorOrderHistory (cache-served, read-only)", () => {
  it("cold start with an active MO → empty flagged series, zero KV writes, zero fetches", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/assignments", [makeAssignment()]);
    const fetches = forbidNetwork();

    const out = (await getMajorOrderHistory(envWith(kv), {})) as Record<
      string,
      unknown
    >;

    expect(fetches.calls).toBe(0);
    expect(kv.puts).toEqual([]); // read-only: never touches the write budget
    expect(out.active_major_order).toBe(true);
    expect(out.active_major_order_ids).toEqual([9001]);
    expect(out.series_count).toBe(0);
    expect(out.series).toEqual([]);
    expect(typeof out.note).toBe("string"); // flagged, not an error
  });

  it("no active MO → flagged (not an error); a prior MO stays queryable by id", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/assignments", []);
    seedMoStore(kv, [
      moSeries([
        { t: NOW, progress: 1, target: 10 },
        { t: NOW + HOUR_MS, progress: 3, target: 10 },
      ]),
    ]);
    forbidNetwork();

    const noArgs = (await getMajorOrderHistory(envWith(kv), {})) as Record<
      string,
      unknown
    >;
    expect(noArgs.active_major_order).toBe(false);
    expect(noArgs.series_count).toBe(0);
    expect(noArgs.retained_major_order_ids).toEqual([9001]);

    const byId = (await getMajorOrderHistory(envWith(kv), {
      major_order_id: 9001,
    })) as Record<string, unknown>;
    expect(byId.series_count).toBe(1);
    const series = byId.series as Array<Record<string, unknown>>;
    expect(series[0]!.major_order_id).toBe(9001);
    expect(series[0]!.latest_progress).toBe(3);
    expect(kv.puts).toEqual([]);
  });

  it("default returns ONLY the active MO's series; objective_index narrows; no cross-MO mixing", async () => {
    const kv = fakeKv();
    seedRaw(kv, "/api/v1/assignments", [makeAssignment()]); // active id 9001
    seedMoStore(kv, [
      moSeries([{ t: NOW, progress: 1, target: 10 }]),
      moSeries([{ t: NOW, progress: 2, target: 20 }], { objective_index: 1 }),
      moSeries([{ t: NOW, progress: 99, target: 100 }], {
        major_order_id: 8000, // a prior MO, retained
      }),
    ]);
    forbidNetwork();

    const out = (await getMajorOrderHistory(envWith(kv), {})) as Record<
      string,
      unknown
    >;
    const series = out.series as Array<Record<string, unknown>>;
    expect(series.map((s) => [s.major_order_id, s.objective_index])).toEqual([
      [9001, 0],
      [9001, 1],
    ]);
    expect(out.retained_major_order_ids).toEqual([9001, 8000]);

    const narrowed = (await getMajorOrderHistory(envWith(kv), {
      objective_index: 1,
    })) as Record<string, unknown>;
    expect(narrowed.series_count).toBe(1);
    expect(
      (narrowed.series as Array<Record<string, unknown>>)[0]!.objective_index,
    ).toBe(1);
  });
});

/* ====================================================================== *
 * KV budget: combined worst-case store (planets + Stage 5 + Stage 8) < 5MB
 * ====================================================================== */

describe("combined KV value-size budget incl. MO series", () => {
  it("full galaxy + max signatures + max global + max MO series < 5MB", () => {
    const PLANET_COUNT = 261;
    const store: SampleStore = { planets: {}, campaignsFirstSeen: {} };
    for (let p = 0; p < PLANET_COUNT; p++) {
      const samples: HealthSample[] = [];
      for (let i = 0; i < MAX_SAMPLES_PER_PLANET; i++) {
        samples.push({
          h: 1_000_000 - i * 1_234,
          t: NOW + i * MIN_SAMPLE_INTERVAL_MS,
        });
      }
      store.planets[String(p)] = { samples, lastRate: -12_345.678 };
      store.campaignsFirstSeen[String(50_000 + p)] = NOW;
    }
    store.signatures = [];
    for (let i = 0; i < MAX_SIGNATURES; i++) {
      store.signatures.push({
        campaign_type: i,
        event_type: i % 7,
        has_event: i % 2 === 0,
        faction: "Illuminate",
        first_seen: NOW,
        last_seen: NOW + i * MIN_SAMPLE_INTERVAL_MS,
        sample_count: 1_000 + i,
      });
    }
    store.global = [];
    for (let i = 0; i < MAX_GLOBAL_SAMPLES; i++) {
      store.global.push({
        t: NOW + i * MIN_SAMPLE_INTERVAL_MS,
        player_count: 123_456,
        missions_won: 1_234_567_890,
        missions_lost: 1_234_567_890,
        deaths: 1_234_567_890,
        terminid_kills: 123_456_789_012,
        automaton_kills: 123_456_789_012,
        illuminate_kills: 123_456_789_012,
      });
    }
    store.mo = [];
    for (let s = 0; s < MAX_MO_SERIES; s++) {
      const samples: MoObjectiveSeries["samples"] = [];
      for (let i = 0; i < MAX_MO_SAMPLES; i++) {
        samples.push({
          t: NOW + i * MIN_SAMPLE_INTERVAL_MS,
          progress: 1_234_567_890,
          target: 1_234_567_890,
        });
      }
      store.mo.push({
        major_order_id: 4_000_000_000 + s,
        objective_index: s % 5,
        task_type: 13,
        samples,
      });
    }
    const bytes = JSON.stringify(store).length;
    // Stage 5 observed ~1.0 MB; the MO worst case adds ~0.35 MB on top —
    // still far under the 5 MB KV value limit.
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
  });
});
