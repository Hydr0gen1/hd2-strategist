/**
 * Stage 7 tests: defense facts made un-misreadable.
 *
 * Part A — objective-relative framing: win_condition + hp_remaining_to_objective
 * on every campaign, the kind-aware direction label ("repelling" on a defense,
 * liberation labels unchanged — regression-pinned), and the rate sign
 * convention echoed inline wherever a rate appears.
 * Part B — the defense timing gap as co-located numbers
 * (projected_hp_at_defense_end / resolution_within_defense_window —
 * deterministic comparisons, never predictions).
 * Part C — the liberation-% formula stated inline; value untouched.
 * Part D — Major Order objectives decoded into named fields beside the raw
 * arrays, with the never-fabricate-a-label fail-safe.
 *
 * The win-state orientation these tests pin was VERIFIED against live
 * defenses on 2026-06-11 (Crimsica index 78, Bore Rock index 124): event
 * health falls toward zero while a defense is being won — same direction as
 * liberation. Bore Rock at that moment was the exact misread this stage
 * retires: raw_hp 728,250 of 750,000 (97% remaining), positive rate, 285h to
 * resolution vs a 14.5h window — almost LOST, yet labeled "liberating".
 *
 * Pure throughout, except the sanctioned KV-stub handler test (stage6
 * pattern): raw cache pre-seeded fresh + a throwing fetch stub.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFENSE_WINDOW_NOTE,
  defenseWindowProjection,
  DIRECTION_NOTE,
  hpRemainingToObjective,
  LIBERATION_PCT_NOTE,
  MO_OBJECTIVE_DECODE_NOTE,
  RATE_SIGN_NOTE,
  shapeMajorOrders,
  TASK_TYPE_NAMES,
  TASK_VALUE_TYPE_NAMES,
  WIN_CONDITION_NOTE,
  winCondition,
} from "../src/enrichment";
import {
  directionFromRate,
  HPC_CAMPAIGN_TYPES,
  isolateLiberationPct,
  normalizeCampaign,
} from "../src/invariants";
import { getCampaigns, getPlanet } from "../src/tools";
import type {
  Env,
  NormalizeContext,
  RawAssignment,
  RawCampaign,
  RawEvent,
  RawPlanet,
} from "../src/types";

const HOUR_MS = 3_600_000;

/* ------------------------------ fixtures ------------------------------ */

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 1,
    eventType: 1,
    faction: "Terminids",
    health: 728_250,
    maxHealth: 750_000,
    startTime: "2026-06-10T20:14:48Z",
    endTime: "2026-06-11T20:14:48Z",
    campaignId: 43,
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
    faction: "Terminids",
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
    campaignAgeMs: 2 * HOUR_MS,
    hpcTypes: HPC_CAMPAIGN_TYPES,
    moPlanetIndices: new Set<number>(),
    ...overrides,
  };
}

/* --------------- Part A: kind-aware direction (regression) ------------ */

describe("directionFromRate is objective-relative per campaign kind", () => {
  it.each([
    [10_000, "liberation", "liberating"],
    [10_000, "defense", "repelling"],
    [-10_000, "liberation", "losing"],
    [-10_000, "defense", "losing"],
    [0, "liberation", "stalemate"],
    [0, "defense", "stalemate"],
    [null, "liberation", "unknown"],
    [null, "defense", "unknown"],
  ] as const)("rate %s on %s → %s", (rate, kind, direction) => {
    expect(directionFromRate(rate, kind)).toBe(direction);
  });

  it("defaults to liberation labels — bare calls behave exactly as before", () => {
    expect(directionFromRate(10_000)).toBe("liberating");
    expect(directionFromRate(-10_000)).toBe("losing");
  });
});

describe("normalizeCampaign direction regression across kinds", () => {
  it("defense being successfully held → 'repelling', never 'liberating'", () => {
    const normalized = normalizeCampaign(
      makeCampaign({ type: 4, planet: { event: makeEvent() } }),
      ctx({ hpPerHour: 15_000 }),
    );
    expect(normalized.campaign_kind).toBe("defense");
    expect(normalized.direction).toBe("repelling");
    expect(normalized.alert).toBeNull();
  });

  it("liberation behavior is unchanged: positive → 'liberating'", () => {
    const normalized = normalizeCampaign(makeCampaign({}), ctx());
    expect(normalized.campaign_kind).toBe("liberation");
    expect(normalized.direction).toBe("liberating");
  });

  it("losing defense is unchanged: negative → 'losing' with collapse alert", () => {
    const normalized = normalizeCampaign(
      makeCampaign({ type: 4, planet: { event: makeEvent() } }),
      ctx({ hpPerHour: -15_000 }),
    );
    expect(normalized.direction).toBe("losing");
    expect(normalized.alert).toBe("collapse");
  });
});

/* ------------- Part A: win_condition + hp_remaining_to_objective ------ */

describe("winCondition (live-verified orientation, 2026-06-11)", () => {
  it("both kinds deplete the tracked health to zero", () => {
    expect(winCondition("liberation")).toBe("raw_hp_to_zero");
    expect(winCondition("defense")).toBe("raw_hp_to_zero");
  });
});

describe("hpRemainingToObjective: smaller = closer, for both kinds", () => {
  it("a defense at 97% event HP reads as a LARGE distance — not nearly complete", () => {
    // The retired live failure case (Bore Rock): raw 728,250 of 750,000 max
    // with a positive rate. Distance to the win state is the full 728,250.
    const remaining = hpRemainingToObjective(728_250);
    expect(remaining).toBe(728_250);
    expect(remaining!).toBeGreaterThan(0.9 * 750_000);
  });

  it("a nearly-won campaign reads as a small distance", () => {
    expect(hpRemainingToObjective(12_000)).toBe(12_000);
  });

  it("unknown HP → null, never substituted; negative clamps to 0", () => {
    expect(hpRemainingToObjective(null)).toBeNull();
    expect(hpRemainingToObjective(Number.NaN)).toBeNull();
    expect(hpRemainingToObjective(-5)).toBe(0);
  });
});

/* ------------------ Part B: defense window projection ------------------ */

describe("defenseWindowProjection", () => {
  it("projects HP at the deadline from the signed rate — exact arithmetic", () => {
    const p = defenseWindowProjection({
      rawHp: 728_250,
      hpPerHour: 15_000,
      defenseHoursRemaining: 14,
      hoursToResolution: 728_250 / 15_000, // 48.55
    });
    expect(p.projected_hp_at_defense_end).toBe(728_250 - 15_000 * 14);
    // 48.55h needed vs 14h available: the comparison is false — a number
    // comparison, not a verdict.
    expect(p.resolution_within_defense_window).toBe(false);
  });

  it("resolution inside the window → true; projection may cross zero (unclamped)", () => {
    const p = defenseWindowProjection({
      rawHp: 60_000,
      hpPerHour: 15_000,
      defenseHoursRemaining: 14,
      hoursToResolution: 4,
    });
    expect(p.resolution_within_defense_window).toBe(true);
    expect(p.projected_hp_at_defense_end).toBe(60_000 - 15_000 * 14); // ≤ 0
  });

  it("losing defense (negative rate): projected HP rises, sign-consistent", () => {
    const p = defenseWindowProjection({
      rawHp: 500_000,
      hpPerHour: -10_000,
      defenseHoursRemaining: 10,
      hoursToResolution: 50,
    });
    expect(p.projected_hp_at_defense_end).toBe(600_000);
    expect(p.resolution_within_defense_window).toBe(false);
  });

  it("null rate (cold start / stabilizing reseed) → both null", () => {
    const p = defenseWindowProjection({
      rawHp: 728_250,
      hpPerHour: null,
      defenseHoursRemaining: 14,
      hoursToResolution: null,
    });
    expect(p.projected_hp_at_defense_end).toBeNull();
    expect(p.resolution_within_defense_window).toBeNull();
  });

  it("stalemate (rate 0): projected HP = current, boolean null (no resolution to compare)", () => {
    const p = defenseWindowProjection({
      rawHp: 728_250,
      hpPerHour: 0,
      defenseHoursRemaining: 14,
      hoursToResolution: null, // invariant 3: stalemate has no projection
    });
    expect(p.projected_hp_at_defense_end).toBe(728_250);
    expect(p.resolution_within_defense_window).toBeNull();
  });

  it("unknown window or HP → null, never computed from a missing bound", () => {
    expect(
      defenseWindowProjection({
        rawHp: 728_250,
        hpPerHour: 15_000,
        defenseHoursRemaining: null,
        hoursToResolution: 48,
      }),
    ).toEqual({
      projected_hp_at_defense_end: null,
      resolution_within_defense_window: null,
    });
    expect(
      defenseWindowProjection({
        rawHp: null,
        hpPerHour: 15_000,
        defenseHoursRemaining: 14,
        hoursToResolution: null,
      }).projected_hp_at_defense_end,
    ).toBeNull();
  });
});

/* ----------------- Part C: liberation-% formula inline ----------------- */

describe("liberation % formula documentation (value untouched)", () => {
  it("the inline note states the exact formula and raw_hp authority", () => {
    expect(LIBERATION_PCT_NOTE).toContain(
      "(max_hp − raw_hp) / max_hp × 100",
    );
    expect(LIBERATION_PCT_NOTE).toContain("raw_hp is authoritative");
  });

  it("the value itself is unchanged by Stage 7", () => {
    // Bore Rock live values: (750,000 − 728,250) / 750,000 × 100 = 2.9.
    expect(isolateLiberationPct(728_250, 750_000)).toBe(2.9);
    expect(isolateLiberationPct(600_000, 1_000_000)).toBe(40);
  });
});

/* --------------- Part D: Major Order objective decode ------------------ */

function makeAssignment(over: Partial<RawAssignment> = {}): RawAssignment {
  return {
    id: 2616794736,
    progress: [281_226],
    title: "MAJOR ORDER",
    briefing: "Complete the required number of Operations on Omicron.",
    description: null,
    // The live Omicron objective shape (2026-06-11), verbatim.
    tasks: [
      {
        type: 9,
        values: [2, 1_750_000, 0, 0, 1, 259],
        valueTypes: [1, 3, 8, 9, 11, 12],
      },
    ],
    reward: { type: 1, amount: 50 },
    rewards: [],
    expiration: "2026-06-15T14:41:52.000Z",
    flags: 0,
    ...over,
  };
}

describe("shapeMajorOrders objective decode", () => {
  const NOW = Date.parse("2026-06-11T06:00:00Z");

  it("decodes the live Omicron shape: target/progress/progress_pct/objective_kind", () => {
    const [order] = shapeMajorOrders([makeAssignment()], NOW);
    const obj = order!.objectives[0]!;
    expect(obj.target).toBe(1_750_000);
    expect(obj.progress).toBe(281_226);
    expect(obj.progress_pct).toBeCloseTo(16.07, 2);
    expect(obj.objective_kind).toBe("complete_operations");
    // Labels are positional beside value_types; unknowns stay null.
    expect(obj.value_labels).toEqual([
      null,
      "goal",
      null,
      null,
      null,
      "planet_index",
    ]);
    // The raw arrays are retained verbatim — the decode is verifiable.
    expect(obj.values).toEqual([2, 1_750_000, 0, 0, 1, 259]);
    expect(obj.value_types).toEqual([1, 3, 8, 9, 11, 12]);
    expect(obj.planet_indices).toEqual([259]);
  });

  it("hold-planet task (live Crimsica shape) → hold_planet, complete at 100%", () => {
    const [order] = shapeMajorOrders(
      [
        makeAssignment({
          id: 3257352995,
          progress: [1],
          tasks: [{ type: 13, values: [1, 1, 78], valueTypes: [3, 11, 12] }],
        }),
      ],
      NOW,
    );
    const obj = order!.objectives[0]!;
    expect(obj.objective_kind).toBe("hold_planet");
    expect(obj.target).toBe(1);
    expect(obj.progress_pct).toBe(100);
    expect(obj.planet_indices).toEqual([78]);
  });

  it("unknown task_type → raw number kept, objective_kind null (never fabricated)", () => {
    const [order] = shapeMajorOrders(
      [
        makeAssignment({
          tasks: [{ type: 99, values: [5, 7], valueTypes: [3, 42] }],
        }),
      ],
      NOW,
    );
    const obj = order!.objectives[0]!;
    expect(obj.task_type).toBe(99);
    expect(obj.objective_kind).toBeNull();
    expect(obj.value_labels).toEqual(["goal", null]);
    expect(obj.values).toEqual([5, 7]);
  });

  it("zero/absent target → progress_pct null, never a divide-by-zero", () => {
    const [order] = shapeMajorOrders(
      [
        makeAssignment({
          progress: [5, 5],
          tasks: [
            { type: 9, values: [0], valueTypes: [3] }, // goal of 0
            { type: 9, values: [259], valueTypes: [12] }, // no goal slot
          ],
        }),
      ],
      NOW,
    );
    expect(order!.objectives[0]!.target).toBe(0);
    expect(order!.objectives[0]!.progress_pct).toBeNull();
    expect(order!.objectives[1]!.target).toBeNull();
    expect(order!.objectives[1]!.progress_pct).toBeNull();
  });

  it("missing values/valueTypes arrays → empty labels, nulls — no throw", () => {
    const [order] = shapeMajorOrders(
      [
        makeAssignment({
          progress: [],
          tasks: [
            {
              type: 9,
              values: undefined as unknown as number[],
              valueTypes: undefined as unknown as number[],
            },
          ],
        }),
      ],
      NOW,
    );
    const obj = order!.objectives[0]!;
    expect(obj.target).toBeNull();
    expect(obj.progress).toBeNull();
    expect(obj.progress_pct).toBeNull();
    expect(obj.value_labels).toEqual([]);
  });

  it("label maps contain ONLY live-confirmed entries", () => {
    expect([...TASK_TYPE_NAMES.entries()].sort()).toEqual([
      [13, "hold_planet"],
      [9, "complete_operations"],
    ].sort());
    expect([...TASK_VALUE_TYPE_NAMES.entries()].sort()).toEqual([
      [12, "planet_index"],
      [3, "goal"],
    ].sort());
  });
});

/* -------- End-to-end: the retired live failure case (KV stub) ---------- *
 * Sanctioned exception (test/CLAUDE.md): raw cache pre-seeded FRESH, fetch
 * stub throws — the handlers serve entirely from cache. The fixture mirrors
 * the live Bore Rock defense (2026-06-11) that motivated this stage.
 * ---------------------------------------------------------------------- */

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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidNetwork(): void {
  globalThis.fetch = (() => {
    throw new Error("network touched — the shared cache should have served this");
  }) as unknown as typeof fetch;
}

function seedFailingDefenseEnv(kv: FakeKv): Env {
  const now = Date.now();
  const libPlanet: RawPlanet = makeCampaign({}).planet;
  const defEvent = makeEvent({
    health: 728_250,
    maxHealth: 750_000,
    startTime: new Date(now - 9.5 * HOUR_MS).toISOString(),
    endTime: new Date(now + 14 * HOUR_MS).toISOString(),
  });
  const defPlanet: RawPlanet = {
    ...makeCampaign({ planet: { index: 124, name: "BORE ROCK" } }).planet,
    event: defEvent,
  };
  const seed = (path: string, body: unknown) =>
    kv.store.set(
      `raw:${path}`,
      JSON.stringify({ fetchedAt: now - 1_000, body }),
    );
  seed("/api/v1/planets", [libPlanet, defPlanet]);
  seed("/api/v1/campaigns", [
    { id: 42, planet: libPlanet, type: 0, count: 1, faction: "Terminids" },
    { id: 43, planet: defPlanet, type: 4, count: 1, faction: "Terminids" },
  ]);
  seed("/api/v1/assignments", []);
  // Pre-seed hour-old health samples so a signed rate exists: liberation
  // 610,000 → 600,000 (+10k/h) and defense event 743,250 → 728,250 (+15k/h).
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
  return { WAR_CACHE: kv as unknown as KVNamespace };
}

describe("the near-lost defense at high HP no longer reads as almost-won", () => {
  it("get_campaigns: distance, direction, and the window gap are explicit", async () => {
    const kv = fakeKv();
    const env = seedFailingDefenseEnv(kv);
    forbidNetwork();

    const out = (await getCampaigns(env)) as {
      campaigns: Array<Record<string, unknown>>;
      notes: Record<string, string>;
    };
    const defense = out.campaigns.find((c) => c.campaign_kind === "defense")!;
    const liberation = out.campaigns.find(
      (c) => c.campaign_kind === "liberation",
    )!;

    // Part A: the win state and the distance to it are explicit. 97% of the
    // event health REMAINS — a large distance, nothing like nearly-won.
    expect(defense.win_condition).toBe("raw_hp_to_zero");
    expect(defense.hp_remaining_to_objective).toBe(728_250);
    expect(defense.hp_remaining_to_objective as number).toBeGreaterThan(
      0.9 * (defense.max_hp as number),
    );
    // The kind-aware label: held-and-progressing reads as repelling.
    expect(defense.direction).toBe("repelling");
    // Cosmetic % is untouched by Stage 7 (Part C is documentation only).
    expect(defense.liberation_pct_display_only).toBe(2.9);

    // Part B: the timing gap is co-located. Rate ≈ +15k/h over the seeded
    // hour (tiny wall-clock drift between seeding and sampling is expected).
    const rate = defense.hp_per_hour as number;
    expect(Math.abs(rate - 15_000)).toBeLessThan(100);
    const hoursToResolution = defense.hours_to_resolution as number;
    const windowHours = defense.defense_hours_remaining as number;
    expect(hoursToResolution).toBeGreaterThan(45); // ~48.5h needed
    expect(windowHours).toBeLessThan(14.01); // ~14h available
    expect(defense.resolution_within_defense_window).toBe(false);
    const projected = defense.projected_hp_at_defense_end as number;
    expect(
      Math.abs(projected - (728_250 - rate * windowHours)),
    ).toBeLessThan(1e-6);
    expect(projected).toBeGreaterThan(500_000); // nowhere near the win state

    // Liberation campaigns: same new Part A fields, behavior unchanged.
    expect(liberation.direction).toBe("liberating");
    expect(liberation.win_condition).toBe("raw_hp_to_zero");
    expect(liberation.hp_remaining_to_objective).toBe(600_000);
    expect("projected_hp_at_defense_end" in liberation).toBe(false);
    expect("resolution_within_defense_window" in liberation).toBe(false);

    // Part A: the rate convention and label semantics ride the payload.
    expect(out.notes.hp_per_hour).toBe(RATE_SIGN_NOTE);
    expect(out.notes.direction).toBe(DIRECTION_NOTE);
    expect(out.notes.win_condition).toBe(WIN_CONDITION_NOTE);
    expect(out.notes.defense_window).toBe(DEFENSE_WINDOW_NOTE);
    expect(out.notes.liberation_pct_display_only).toBe(LIBERATION_PCT_NOTE);
  });

  it("get_planet carries the same framing for the defense planet", async () => {
    const kv = fakeKv();
    const env = seedFailingDefenseEnv(kv);
    forbidNetwork();

    const out = (await getPlanet(env, { index: 124 })) as Record<
      string,
      unknown
    >;
    expect(out.campaign_kind).toBe("defense");
    expect(out.win_condition).toBe("raw_hp_to_zero");
    expect(out.hp_remaining_to_objective).toBe(728_250);
    expect(out.direction).toBe("repelling");
    expect(out.resolution_within_defense_window).toBe(false);
    expect(typeof out.projected_hp_at_defense_end).toBe("number");
    const notes = out.notes as Record<string, string>;
    expect(notes.hp_per_hour).toBe(RATE_SIGN_NOTE);
    expect(notes.direction).toBe(DIRECTION_NOTE);
    expect(notes.win_condition).toBe(WIN_CONDITION_NOTE);
  });
});

describe("note constants document, never conclude", () => {
  it("the rate note states the shared orientation incl. defenses", () => {
    expect(RATE_SIGN_NOTE).toContain("liberation AND defense");
    expect(RATE_SIGN_NOTE).toContain("previous − current");
  });

  it("the window note frames the boolean as a comparison, not a prediction", () => {
    expect(DEFENSE_WINDOW_NOTE).toContain("does NOT predict success or failure");
  });

  it("the MO decode note states the never-fabricate fail-safe", () => {
    expect(MO_OBJECTIVE_DECODE_NOTE).toContain("never fabricated");
  });
});
