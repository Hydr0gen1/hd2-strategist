/**
 * Stage 2 tests: dispatch/patch-note shaping, the planet-history ring buffer
 * (sampling.ts), and — critically — the rate-preservation regression proving
 * the ring-buffer refactor leaves hp_per_hour bit-identical to the legacy
 * single-sample store. All pure; no KV, no fetch, no mocks.
 */
import { describe, expect, it } from "vitest";

import {
  buildHistoryPoints,
  shapeDispatches,
  shapePatchNotes,
} from "../src/enrichment";
import {
  MAX_SAMPLE_AGE_MS,
  MAX_SAMPLES_PER_PLANET,
  MIN_SAMPLE_INTERVAL_MS,
  advancePlanetSeries,
  coercePlanetEntry,
  coerceStore,
  evictSamples,
  type HealthSample,
  type PlanetSampleSeries,
  type SampleStore,
} from "../src/sampling";
import type { RawDispatch, RawSteamNews } from "../src/types";

const HOUR_MS = 3_600_000;

/**
 * Verbatim reimplementation of the PRE-ring-buffer rate computation
 * (client.ts before Stage 2): hoursElapsed first, then (prev.h − h) ÷ hours.
 * The regression below asserts exact float equality against this.
 */
function legacyRate(
  prev: { h: number; t: number },
  health: number,
  nowMs: number,
): number {
  const hoursElapsed = (nowMs - prev.t) / 3_600_000;
  return (prev.h - health) / hoursElapsed;
}

function seriesOf(
  samples: HealthSample[],
  lastRate: number | null = null,
): PlanetSampleSeries {
  return { samples, lastRate };
}

describe("rate-preservation regression: advancePlanetSeries vs legacy store", () => {
  // Deliberately awkward values so any reordering of the float arithmetic
  // would show up as inexact equality.
  const prev = { h: 1_000_003, t: 12_345 };

  it("liberation-style falling health → exact same positive signed rate", () => {
    const nowMs = prev.t + 3_727_001; // ~62 min, well past MIN_SAMPLE_INTERVAL_MS
    const health = 899_991;
    const out = advancePlanetSeries(seriesOf([prev]), health, nowMs);
    expect(out.hpPerHour).toBe(legacyRate(prev, health, nowMs));
    expect(out.hpPerHour!).toBeGreaterThan(0);
  });

  it("defense-style rising health → exact same negative signed rate", () => {
    const nowMs = prev.t + 2 * HOUR_MS;
    const health = 1_234_567;
    const out = advancePlanetSeries(seriesOf([prev]), health, nowMs);
    expect(out.hpPerHour).toBe(legacyRate(prev, health, nowMs));
    expect(out.hpPerHour!).toBeLessThan(0);
  });

  it("unchanged health → exactly 0, same as legacy", () => {
    const nowMs = prev.t + HOUR_MS;
    const out = advancePlanetSeries(seriesOf([prev]), prev.h, nowMs);
    expect(out.hpPerHour).toBe(legacyRate(prev, prev.h, nowMs));
    expect(out.hpPerHour).toBe(0);
  });

  it("the tail of a longer series is the rate basis — older points never leak in", () => {
    const older = { h: 5_000_000, t: prev.t - 10 * HOUR_MS };
    const nowMs = prev.t + HOUR_MS;
    const health = 900_000;
    const out = advancePlanetSeries(
      seriesOf([older, prev]),
      health,
      nowMs,
    );
    expect(out.hpPerHour).toBe(legacyRate(prev, health, nowMs));
  });

  it("migrated legacy entry {h, t, lastRate} produces the identical next-poll rate", () => {
    const migrated = coercePlanetEntry({ h: prev.h, t: prev.t, lastRate: 42 });
    const nowMs = prev.t + 90_000;
    const health = 999_000;
    const out = advancePlanetSeries(migrated, health, nowMs);
    expect(out.hpPerHour).toBe(legacyRate(prev, health, nowMs));
  });
});

describe("advancePlanetSeries: legacy semantics carried over exactly", () => {
  it("samples closer than MIN_SAMPLE_INTERVAL_MS reuse lastRate and do NOT append", () => {
    const series = seriesOf([{ h: 1_000_000, t: 100_000 }], 7_500);
    const out = advancePlanetSeries(
      series,
      950_000,
      100_000 + MIN_SAMPLE_INTERVAL_MS - 1,
    );
    expect(out.hpPerHour).toBe(7_500);
    expect(out.series).toBe(series); // byte-identical: same object, untouched
    expect(out.series!.samples).toHaveLength(1);
  });

  it("first sample seeds a one-point series with a null rate", () => {
    const out = advancePlanetSeries(undefined, 800_000, 50_000);
    expect(out.hpPerHour).toBeNull();
    expect(out.series).toEqual({
      samples: [{ h: 800_000, t: 50_000 }],
      lastRate: null,
    });
  });

  it("null health drops the series (legacy drop — next sample reseeds null)", () => {
    const series = seriesOf([{ h: 1_000_000, t: 0 }], 10_000);
    expect(advancePlanetSeries(series, null, HOUR_MS).series).toBeUndefined();
    expect(advancePlanetSeries(series, NaN, HOUR_MS).series).toBeUndefined();
    expect(advancePlanetSeries(series, null, HOUR_MS).hpPerHour).toBeNull();
  });

  it("a qualifying sample appends: history grows while the rate updates", () => {
    const series = seriesOf([{ h: 1_000_000, t: 0 }], null);
    const out = advancePlanetSeries(series, 990_000, HOUR_MS);
    expect(out.series!.samples).toEqual([
      { h: 1_000_000, t: 0 },
      { h: 990_000, t: HOUR_MS },
    ]);
    expect(out.series!.lastRate).toBe(10_000);
  });
});

describe("ring buffer eviction bounds", () => {
  it("never exceeds MAX_SAMPLES_PER_PLANET — the oldest point drops on overflow", () => {
    let series: PlanetSampleSeries | undefined;
    const total = MAX_SAMPLES_PER_PLANET + 5;
    for (let i = 0; i < total; i++) {
      series = advancePlanetSeries(series, 1_000_000 - i, i * MIN_SAMPLE_INTERVAL_MS)
        .series;
    }
    expect(series!.samples).toHaveLength(MAX_SAMPLES_PER_PLANET);
    // Oldest retained point is the (total - MAX)th sample; the first ones dropped.
    expect(series!.samples[0]!.t).toBe(
      (total - MAX_SAMPLES_PER_PLANET) * MIN_SAMPLE_INTERVAL_MS,
    );
    expect(series!.samples[series!.samples.length - 1]!.t).toBe(
      (total - 1) * MIN_SAMPLE_INTERVAL_MS,
    );
  });

  it("points older than MAX_SAMPLE_AGE_MS are evicted on append", () => {
    const ancient = { h: 1_000_000, t: 0 };
    const recent = { h: 900_000, t: MAX_SAMPLE_AGE_MS + HOUR_MS };
    const nowMs = MAX_SAMPLE_AGE_MS + 2 * HOUR_MS;
    const out = advancePlanetSeries(
      seriesOf([ancient, recent]),
      890_000,
      nowMs,
    );
    expect(out.series!.samples.map((s) => s.t)).toEqual([recent.t, nowMs]);
  });

  it("evictSamples keeps at least the newest sample even if all are over-age", () => {
    const samples = [{ h: 1, t: 0 }, { h: 2, t: 1 }];
    const kept = evictSamples(samples, MAX_SAMPLE_AGE_MS * 10);
    expect(kept).toEqual([{ h: 2, t: 1 }]);
  });

  it("no eviction on the no-append path — series untouched below the interval", () => {
    const overAge = seriesOf(
      [
        { h: 1, t: 0 },
        { h: 2, t: 10 },
      ],
      null,
    );
    const out = advancePlanetSeries(overAge, 3, 10 + MIN_SAMPLE_INTERVAL_MS - 1);
    expect(out.series).toBe(overAge);
  });
});

describe("store coercion / legacy migration", () => {
  it("migrates a full legacy store and keeps campaignsFirstSeen", () => {
    const legacy = {
      planets: {
        "175": { h: 600_000, t: 1_000, lastRate: 12_345 },
        "42": { h: 1_000_000, t: 2_000, lastRate: null },
      },
      campaignsFirstSeen: { "9001": 500 },
    };
    const store = coerceStore(legacy);
    expect(store.planets["175"]).toEqual({
      samples: [{ h: 600_000, t: 1_000 }],
      lastRate: 12_345,
    });
    expect(store.planets["42"]!.lastRate).toBeNull();
    expect(store.campaignsFirstSeen).toEqual({ "9001": 500 });
  });

  it("hybrid entry (deploy overlap) — samples array wins over stray h/t", () => {
    const entry = coercePlanetEntry({
      samples: [{ h: 10, t: 1 }, { h: 9, t: 2 }],
      lastRate: -5,
      h: 99,
      t: 99,
    });
    expect(entry).toEqual({
      samples: [
        { h: 10, t: 1 },
        { h: 9, t: 2 },
      ],
      lastRate: -5,
    });
  });

  it("garbage entries and garbage stores coerce to empty — rates rebuild", () => {
    expect(coercePlanetEntry(null)).toBeUndefined();
    expect(coercePlanetEntry("nope")).toBeUndefined();
    expect(coercePlanetEntry({ h: "x", t: NaN })).toBeUndefined();
    expect(coerceStore(null)).toEqual({ planets: {}, campaignsFirstSeen: {} });
    expect(coerceStore([1, 2])).toEqual({
      planets: {},
      campaignsFirstSeen: {},
    });
  });

  it("invalid samples inside a series are filtered, valid ones kept", () => {
    const entry = coercePlanetEntry({
      samples: [{ h: 10, t: 1 }, { h: NaN, t: 2 }, "junk", { h: 8, t: 3 }],
      lastRate: "bad",
    });
    expect(entry).toEqual({
      samples: [
        { h: 10, t: 1 },
        { h: 8, t: 3 },
      ],
      lastRate: null,
    });
  });
});

describe("KV value-size budget: worst-case serialized store", () => {
  it("full galaxy at max retention stays far under the 5MB KV limit", () => {
    const PLANET_COUNT = 261;
    const store: SampleStore = { planets: {}, campaignsFirstSeen: {} };
    for (let p = 0; p < PLANET_COUNT; p++) {
      const samples: HealthSample[] = [];
      for (let i = 0; i < MAX_SAMPLES_PER_PLANET; i++) {
        samples.push({
          // Realistic magnitudes: 7-digit health, 13-digit ms timestamps.
          h: 1_000_000 - i * 1_234,
          t: 1_780_000_000_000 + i * MIN_SAMPLE_INTERVAL_MS,
        });
      }
      store.planets[String(p)] = { samples, lastRate: -12_345.678 };
      store.campaignsFirstSeen[String(50_000 + p)] = 1_780_000_000_000;
    }
    const bytes = JSON.stringify(store).length;
    // Documented expectation ≈ 0.9 MB; assert with generous margin.
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(5 * 1024 * 1024); // the actual KV bound
  });
});

describe("buildHistoryPoints: observed deltas only", () => {
  it("consecutive delta_health/delta_hours are exact differences; first point null", () => {
    const points = buildHistoryPoints([
      { h: 1_000_000, t: 0 },
      { h: 940_000, t: 2 * HOUR_MS },
      { h: 955_000, t: 3 * HOUR_MS },
    ]);
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({
      health: 1_000_000,
      t: 0,
      delta_health: null,
      delta_hours: null,
    });
    expect(points[0]!.observed_at).toBe(new Date(0).toISOString());
    // Falling health → negative delta_health (raw observed change).
    expect(points[1]).toMatchObject({ delta_health: -60_000, delta_hours: 2 });
    // Rising health → positive delta_health.
    expect(points[2]).toMatchObject({ delta_health: 15_000, delta_hours: 1 });
  });

  it("empty and single-sample series produce 0/1 points — the <2 honesty path", () => {
    expect(buildHistoryPoints([])).toEqual([]);
    const single = buildHistoryPoints([{ h: 5, t: 1_000 }]);
    expect(single).toHaveLength(1);
    expect(single[0]!.delta_health).toBeNull();
  });
});

describe("shapeDispatches", () => {
  const dispatches: RawDispatch[] = [
    { id: 2, published: "2026-06-08T00:00:00Z", type: 0, message: "older" },
    { id: 3, published: "2026-06-09T00:00:00Z", type: 0, message: "newest" },
    { id: 1, published: "2026-06-07T00:00:00Z", type: 1, message: "<i=3>m</i>" },
  ];

  it("sorts newest-first regardless of upstream order, passing fields through", () => {
    const out = shapeDispatches(dispatches);
    expect(out.map((d) => d.id)).toEqual([3, 2, 1]);
    expect(out[2]).toEqual({
      id: 1,
      published: "2026-06-07T00:00:00Z",
      type: 1,
      message: "<i=3>m</i>", // markup untouched
    });
  });

  it("respects and clamps limit: junk/<1 → default 10, huge → cap 25, floored", () => {
    const many: RawDispatch[] = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      published: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      type: 0,
      message: `d${i}`,
    }));
    expect(shapeDispatches(many)).toHaveLength(10);
    expect(shapeDispatches(many, 2)).toHaveLength(2);
    expect(shapeDispatches(many, 2.9)).toHaveLength(2);
    expect(shapeDispatches(many, 100)).toHaveLength(25);
    expect(shapeDispatches(many, 0)).toHaveLength(10);
    expect(shapeDispatches(many, -5)).toHaveLength(10);
    expect(shapeDispatches(many, NaN)).toHaveLength(10);
  });

  it("empty/missing upstream → [] — a friendly empty payload, not an error", () => {
    expect(shapeDispatches([])).toEqual([]);
    expect(shapeDispatches(null)).toEqual([]);
    expect(shapeDispatches(undefined)).toEqual([]);
  });

  it("unparseable published sinks to the end; ties break by id desc", () => {
    const out = shapeDispatches([
      { id: 9, published: "garbage", type: 0, message: "x" },
      { id: 4, published: "2026-06-09T00:00:00Z", type: 0, message: "a" },
      { id: 5, published: "2026-06-09T00:00:00Z", type: 0, message: "b" },
    ]);
    expect(out.map((d) => d.id)).toEqual([5, 4, 9]);
  });
});

describe("shapePatchNotes", () => {
  const news: RawSteamNews[] = [
    {
      id: "111",
      title: "Hotfix 6.2.6",
      url: "https://example.test/111",
      author: "Elemdil",
      content: "[p]BBCode body[/p]",
      publishedAt: "2026-06-09T12:01:09Z",
    },
    {
      id: "110",
      title: "Director letter",
      url: "https://example.test/110",
      author: "Baskinator",
      content: "[h3]older[/h3]",
      publishedAt: "2026-06-01T00:00:00Z",
    },
  ];

  it("maps publishedAt → published, newest first, content verbatim", () => {
    const out = shapePatchNotes([news[1]!, news[0]!]);
    expect(out[0]).toEqual({
      id: "111",
      title: "Hotfix 6.2.6",
      author: "Elemdil",
      published: "2026-06-09T12:01:09Z",
      url: "https://example.test/111",
      content: "[p]BBCode body[/p]",
    });
    expect(out.map((n) => n.id)).toEqual(["111", "110"]);
  });

  it("defaults to 5, caps at 10, empty → []", () => {
    const many: RawSteamNews[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      title: `t${i}`,
      url: "u",
      author: "a",
      content: "c",
      publishedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    expect(shapePatchNotes(many)).toHaveLength(5);
    expect(shapePatchNotes(many, 99)).toHaveLength(10);
    expect(shapePatchNotes([])).toEqual([]);
    expect(shapePatchNotes(undefined)).toEqual([]);
  });
});
