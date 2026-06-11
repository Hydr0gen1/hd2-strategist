/**
 * Stage 10 — raw-source cross-check layer.
 *
 * Pure tests over src/crosscheck.ts plus handler tests on the stage6 KV-stub
 * pattern (every raw: cache entry pre-seeded fresh, globalThis.fetch replaced
 * by a stub that THROWS — the network is forbidden, never simulated).
 *
 * The non-negotiables pinned here:
 *  - agreeing fields → agrees: true; genuine divergence → agrees: false WITH
 *    the abs/pct diff and both values;
 *  - invariant transforms (defense decay force-nulled, liberation %
 *    recomputed) → expected_transform: true, NEVER a mismatch;
 *  - float rounding inside the documented tolerance never reads as a real
 *    divergence;
 *  - a missing /raw side degrades to a reasoned null — the primary response
 *    is unaffected and the missing side is never guessed;
 *  - a field absent on one side → agrees: null + reason, not a false
 *    mismatch;
 *  - NO source-resolution key exists anywhere (authoritative / chosen /
 *    trusted / preferred / winner…) — disagreements are surfaced, never
 *    resolved;
 *  - the raw fetch adds ZERO sample-store writes (the single-write-per-poll
 *    ceiling stands).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCrossCheckBlock,
  CROSS_CHECK_FLOAT_TOLERANCE,
  crossCheckAssignments,
  crossCheckSubject,
  floatsAgree,
  RAW_ASSIGNMENT_PATH,
  RAW_FACTION_NAMES,
  RAW_STATUS_PATH,
  summarizeChecks,
  unavailableCrossCheck,
  unmatchedCampaigns,
} from "../src/crosscheck";
import { getPlanet, getSourceCrossCheck } from "../src/tools";
import type {
  CrossCheckField,
  CrossCheckSubject,
  Env,
  RawAssignment,
  RawEvent,
  RawPlanet,
  RawWarStatus,
  RawWarStatusAssignment,
} from "../src/types";

const HOUR_MS = 3_600_000;

/* ------------------------------ fixtures ------------------------------- */

function makeSubject(over: Partial<CrossCheckSubject> = {}): CrossCheckSubject {
  return {
    planet_index: 175,
    campaign_id: 42,
    campaign_kind: "liberation",
    campaign_type: 0,
    current_owner: "Terminids",
    raw_hp: 600_000,
    max_hp: 1_000_000,
    regen_per_second: 2.7777777,
    liberation_pct_display_only: 40,
    event_type: null,
    player_count: 1234,
    ...over,
  };
}

function makeRawStatus(over: Partial<RawWarStatus> = {}): RawWarStatus {
  return {
    warId: 801,
    planetStatus: [
      {
        index: 175,
        owner: 2,
        health: 600_000,
        regenPerSecond: 2.7777777,
        players: 1234,
      },
    ],
    campaigns: [{ id: 42, planetIndex: 175, type: 0, race: 2 }],
    planetEvents: [],
    ...over,
  };
}

function field(checks: CrossCheckField[], name: string): CrossCheckField {
  const found = checks.find((c) => c.field === name);
  expect(found, `field ${name} should be checked`).toBeDefined();
  return found!;
}

/* --------------------------- pure: agreement --------------------------- */

describe("crossCheckSubject: agreement and divergence", () => {
  it("matching liberation fields all agree, with both values present", () => {
    const checks = crossCheckSubject(makeSubject(), makeRawStatus());
    for (const name of [
      "current_owner",
      "raw_hp",
      "regen_per_second",
      "campaign_type",
      "has_event",
      "player_count",
    ]) {
      const c = field(checks, name);
      expect(c.agrees).toBe(true);
      expect(c.normalized_value).not.toBeUndefined();
      expect(c.raw_value).not.toBeUndefined();
      expect(c.abs_diff).toBeUndefined();
    }
  });

  it("a genuinely divergent value → agrees: false with both values AND abs/pct diff — never resolved", () => {
    const raw = makeRawStatus();
    raw.planetStatus![0]!.health = 580_000;
    const c = field(crossCheckSubject(makeSubject(), raw), "raw_hp");
    expect(c.agrees).toBe(false);
    expect(c.normalized_value).toBe(600_000);
    expect(c.raw_value).toBe(580_000);
    expect(c.abs_diff).toBe(20_000);
    expect(c.pct_diff).toBeCloseTo((20_000 / 600_000) * 100, 10);
  });

  it("discrete divergence (campaign_type) → agrees: false, both values surfaced", () => {
    const raw = makeRawStatus();
    raw.campaigns![0]!.type = 4;
    const c = field(crossCheckSubject(makeSubject(), raw), "campaign_type");
    expect(c.agrees).toBe(false);
    expect(c.normalized_value).toBe(0);
    expect(c.raw_value).toBe(4);
  });

  it("owner decodes via the live-verified enum map; an unmapped enum value → agrees: null, never a guessed name", () => {
    expect(RAW_FACTION_NAMES.get(2)).toBe("Terminids");
    const raw = makeRawStatus();
    raw.planetStatus![0]!.owner = 7;
    const c = field(crossCheckSubject(makeSubject(), raw), "current_owner");
    expect(c.agrees).toBeNull();
    expect(c.reason).toBe("unconfirmed_raw_enum_value");
    expect(c.raw_value).toBe(7); // visible, never named
  });
});

/* ----------------------- pure: float tolerance ------------------------- */

describe("float tolerance (documented: relative 1e-6)", () => {
  it("within-tolerance rounding noise → agrees: true", () => {
    const raw = makeRawStatus();
    raw.planetStatus![0]!.regenPerSecond = 2.7777777 + 1e-9;
    const c = field(
      crossCheckSubject(makeSubject(), raw),
      "regen_per_second",
    );
    expect(c.agrees).toBe(true);
  });

  it("outside tolerance → agrees: false with the diff", () => {
    const raw = makeRawStatus();
    raw.planetStatus![0]!.regenPerSecond = 2.8;
    const c = field(
      crossCheckSubject(makeSubject(), raw),
      "regen_per_second",
    );
    expect(c.agrees).toBe(false);
    expect(c.abs_diff).toBeCloseTo(2.8 - 2.7777777, 10);
  });

  it("floatsAgree flips exactly around the relative threshold", () => {
    expect(floatsAgree(1_000_000, 1_000_000.5)).toBe(true); // 5e-7 rel
    expect(floatsAgree(1_000_000, 1_000_002)).toBe(false); // 2e-6 rel
    expect(floatsAgree(0, 0)).toBe(true);
    expect(CROSS_CHECK_FLOAT_TOLERANCE).toBe(1e-6);
  });
});

/* ------------------- pure: expected transforms ------------------------- */

describe("expected transforms are NOT mismatches", () => {
  const defenseSubject = makeSubject({
    planet_index: 124,
    campaign_id: 43,
    campaign_kind: "defense",
    campaign_type: 4,
    current_owner: "Humans",
    raw_hp: 728_250,
    max_hp: 750_000,
    regen_per_second: null, // invariant 1: force-nulled
    event_type: 1,
    player_count: 50_000,
  });
  const defenseRaw = makeRawStatus({
    planetStatus: [
      {
        index: 124,
        owner: 1,
        health: 999_999, // planet health — NOT what a defense tracks
        regenPerSecond: 4.1666665, // real-looking cosmetic decay
        players: 50_000,
      },
    ],
    campaigns: [{ id: 43, planetIndex: 124, type: 4, race: 2 }],
    planetEvents: [
      {
        id: 5600,
        planetIndex: 124,
        eventType: 1,
        race: 2,
        health: 728_250,
        maxHealth: 750_000,
        campaignId: 43,
      },
    ],
  });

  it("defense decay (invariant-1 force-null) → expected_transform: true with the raw value shown, NEVER agrees: false", () => {
    const c = field(
      crossCheckSubject(defenseSubject, defenseRaw),
      "regen_per_second",
    );
    expect(c.expected_transform).toBe(true);
    expect(c.agrees).not.toBe(false);
    expect(c.normalized_value).toBeNull(); // the deliberate null
    expect(c.raw_value).toBe(4.1666665); // the raw value, untouched
    expect(c.reason).toContain("invariant_1");
  });

  it("liberation % (invariant-2 recompute) → expected_transform: true; no raw counterpart claimed", () => {
    const c = field(
      crossCheckSubject(makeSubject(), makeRawStatus()),
      "liberation_pct_display_only",
    );
    expect(c.expected_transform).toBe(true);
    expect(c.agrees).not.toBe(false);
    expect(c.raw_value).toBeNull();
    expect(c.reason).toContain("invariant_2");
  });

  it("a defense compares EVENT health/maxHealth (the tracked health), and event identity agrees", () => {
    const checks = crossCheckSubject(defenseSubject, defenseRaw);
    expect(field(checks, "raw_hp").agrees).toBe(true); // 728,250 = event health
    expect(field(checks, "max_hp").agrees).toBe(true); // event maxHealth
    expect(field(checks, "has_event").agrees).toBe(true);
    expect(field(checks, "event_type").agrees).toBe(true);
  });
});

/* ----------------------- pure: absent sides ---------------------------- */

describe("a field absent on one side is agrees: null + reason — never a false mismatch", () => {
  it("liberation max_hp has no raw counterpart in the status payload", () => {
    const c = field(crossCheckSubject(makeSubject(), makeRawStatus()), "max_hp");
    expect(c.agrees).toBeNull();
    expect(c.reason).toBe("field_absent_in_raw");
  });

  it("planet missing from raw planetStatus → planet_absent_in_raw", () => {
    const c = field(
      crossCheckSubject(makeSubject(), makeRawStatus({ planetStatus: [] })),
      "current_owner",
    );
    expect(c.agrees).toBeNull();
    expect(c.reason).toBe("planet_absent_in_raw");
  });

  it("campaign id missing from raw campaigns → campaign_absent_in_raw", () => {
    const c = field(
      crossCheckSubject(makeSubject(), makeRawStatus({ campaigns: [] })),
      "campaign_type",
    );
    expect(c.agrees).toBeNull();
    expect(c.reason).toBe("campaign_absent_in_raw");
  });

  it("no real campaign (quiet-planet probe) → no campaign_type claim is checked at all", () => {
    const checks = crossCheckSubject(
      makeSubject({ campaign_id: null, campaign_type: null }),
      makeRawStatus(),
    );
    expect(checks.find((c) => c.field === "campaign_type")).toBeUndefined();
  });

  it("normalized side missing a value → field_absent_in_normalized", () => {
    const c = field(
      crossCheckSubject(makeSubject({ player_count: null }), makeRawStatus()),
      "player_count",
    );
    expect(c.agrees).toBeNull();
    expect(c.reason).toBe("field_absent_in_normalized");
  });
});

/* -------------------------- pure: summary ------------------------------ */

describe("summarizeChecks", () => {
  it("tallies agreements / unexpected disagreements / expected transforms / uncheckable — transforms never count as disagreements", () => {
    const checks: CrossCheckField[] = [
      { field: "a", normalized_value: 1, raw_value: 1, agrees: true },
      { field: "b", normalized_value: 1, raw_value: 2, agrees: false },
      {
        field: "c",
        normalized_value: null,
        raw_value: 4,
        agrees: null,
        expected_transform: true,
        reason: "invariant_1",
      },
      { field: "d", normalized_value: null, raw_value: 1, agrees: null, reason: "x" },
    ];
    expect(summarizeChecks(checks)).toEqual({
      fields_checked: 4,
      agreements: 1,
      unexpected_disagreements: 1,
      expected_transforms: 1,
      uncheckable: 1,
    });
  });
});

/* ----------------------- pure: MO cross-check -------------------------- */

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

function makeRawAssignment(
  over: Partial<RawWarStatusAssignment> = {},
): RawWarStatusAssignment {
  return {
    id32: 9001,
    progress: [130_000],
    setting: {
      type: 4,
      tasks: [{ type: 9, values: [1, 1_750_000, 175], valueTypes: [1, 3, 12] }],
    },
    ...over,
  };
}

describe("crossCheckAssignments", () => {
  it("identical assignment → progress, task_type, target and objective_count all agree (one shared goal decode)", () => {
    const [result] = crossCheckAssignments(
      [makeAssignment()],
      [makeRawAssignment()],
    );
    expect(result!.matched_in_raw).toBe(true);
    expect(field(result!.checked, "objective_count").agrees).toBe(true);
    expect(field(result!.checked, "objectives[0].progress").agrees).toBe(true);
    expect(field(result!.checked, "objectives[0].task_type").agrees).toBe(true);
    const target = field(result!.checked, "objectives[0].target");
    expect(target.agrees).toBe(true);
    expect(target.normalized_value).toBe(1_750_000);
  });

  it("divergent progress → agrees: false with both values; absent raw assignment reported, never dropped", () => {
    const [diverged] = crossCheckAssignments(
      [makeAssignment()],
      [makeRawAssignment({ progress: [129_000] })],
    );
    const p = field(diverged!.checked, "objectives[0].progress");
    expect(p.agrees).toBe(false);
    expect(p.normalized_value).toBe(130_000);
    expect(p.raw_value).toBe(129_000);

    const [missing] = crossCheckAssignments([makeAssignment()], []);
    expect(missing!.matched_in_raw).toBe(false);
    expect(missing!.checked[0]!.agrees).toBeNull();
    expect(missing!.checked[0]!.reason).toBe("assignment_absent_in_raw");
  });
});

describe("unmatchedCampaigns", () => {
  it("reports membership on one side only, both directions, sorted", () => {
    const raw = makeRawStatus({
      campaigns: [
        { id: 1, planetIndex: 10 },
        { id: 2, planetIndex: 30 },
      ],
    });
    expect(unmatchedCampaigns([30, 20], raw)).toEqual({
      in_normalized_only: [20],
      in_raw_only: [10],
    });
  });
});

/* ----------------- prime-directive key-name pin ------------------------ */

function allKeysDeep(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) allKeysDeep(v, keys);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      allKeysDeep(v, keys);
    }
  }
  return keys;
}

const RESOLUTION_KEY_PATTERN =
  /authoritative|chosen|trusted|preferred|winner|correct|resolved|believe|verdict/i;

describe("no source-resolution key exists anywhere (disagreements are surfaced, never resolved)", () => {
  it("a built cross_check block (agreeing AND diverging) carries no resolution key", () => {
    const raw = makeRawStatus();
    raw.planetStatus![0]!.health = 1; // force a divergence
    const block = buildCrossCheckBlock(makeSubject(), raw, {
      normalizedFetchedAtMs: Date.now() - 5_000,
      rawFetchedAtMs: Date.now() - 1_000,
      rawStale: false,
    });
    for (const key of allKeysDeep(block)) {
      expect(key).not.toMatch(RESOLUTION_KEY_PATTERN);
    }
    // and the unavailable block too
    for (const key of allKeysDeep(unavailableCrossCheck("raw_unavailable"))) {
      expect(key).not.toMatch(RESOLUTION_KEY_PATTERN);
    }
  });
});

/* -------------------- handlers (KV stub, stage6 pattern) ---------------- */

interface FakeKv {
  store: Map<string, string>;
  puts: { key: string; ttl?: number }[];
  get(key: string, type?: string): Promise<unknown>;
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
    statistics: {
      missionsWon: 10,
      missionsLost: 2,
      missionSuccessRate: 83,
      terminidKills: 100,
      automatonKills: 0,
      illuminateKills: 0,
      deaths: 5,
      playerCount: 1234,
      accuracy: 60,
    },
    ...over,
  };
}

/** Seeds the normalized endpoints AND the matching /raw payloads fresh. */
function seedCrossCheckEnv(
  kv: FakeKv,
  opts: { seedRawStatus?: boolean; rawHealthOverride?: number } = {},
): Env {
  const now = Date.now();
  const libPlanet = makePlanet();
  const defEvent: RawEvent = {
    id: 5600,
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
    currentOwner: "Humans",
    regenPerSecond: 4.1666665,
    event: defEvent,
    statistics: { ...makePlanet().statistics!, playerCount: 50_000 },
  });
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
  seed("/api/v1/assignments", [makeAssignment()]);
  if (opts.seedRawStatus !== false) {
    seed(RAW_STATUS_PATH, {
      warId: 801,
      planetStatus: [
        {
          index: 175,
          owner: 2,
          health: opts.rawHealthOverride ?? 600_000,
          regenPerSecond: 2.7777777,
          players: 1234,
        },
        {
          index: 124,
          owner: 1,
          health: 1_000_000,
          regenPerSecond: 4.1666665,
          players: 50_000,
        },
      ],
      campaigns: [
        { id: 42, planetIndex: 175, type: 0, race: 2 },
        { id: 43, planetIndex: 124, type: 4, race: 2 },
      ],
      planetEvents: [
        {
          id: 5600,
          planetIndex: 124,
          eventType: 1,
          race: 2,
          health: 728_250,
          maxHealth: 750_000,
          campaignId: 43,
        },
      ],
    } satisfies RawWarStatus);
    seed(RAW_ASSIGNMENT_PATH, [makeRawAssignment()]);
  }
  return envWith(kv);
}

describe("get_planet cross_check (handler, network forbidden)", () => {
  it("agreeing planet → available block, agreements, invariant transforms marked; budget unchanged (one samples:planets put)", async () => {
    const kv = fakeKv();
    const env = seedCrossCheckEnv(kv);
    forbidNetwork();

    const out = (await getPlanet(env, { index: 175 })) as Record<string, any>;
    const cc = out.cross_check;
    expect(cc.available).toBe(true);
    expect(cc.raw_source).toBe(RAW_STATUS_PATH);
    const rawHp = cc.checked.find((c: CrossCheckField) => c.field === "raw_hp");
    expect(rawHp.agrees).toBe(true);
    expect(cc.unexpected_disagreements).toBe(0);
    // liberation_pct is always an expected transform on a liberation planet
    expect(cc.expected_transforms).toBeGreaterThanOrEqual(1);
    expect(cc.normalized_as_of).toBeTruthy();
    expect(cc.raw_as_of).toBeTruthy();
    // The raw fetch rides the read-through cache — the poll still performs
    // exactly ONE samples:planets put, nothing more.
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(1);
    for (const key of allKeysDeep(cc)) {
      expect(key).not.toMatch(RESOLUTION_KEY_PATTERN);
    }
  });

  it("defense planet → invariant-1 regen transform expected, event health compared, no false mismatch", async () => {
    const kv = fakeKv();
    const env = seedCrossCheckEnv(kv);
    forbidNetwork();

    const out = (await getPlanet(env, { index: 124 })) as Record<string, any>;
    const cc = out.cross_check;
    expect(cc.available).toBe(true);
    const regen = cc.checked.find(
      (c: CrossCheckField) => c.field === "regen_per_second",
    );
    expect(regen.expected_transform).toBe(true);
    expect(regen.raw_value).toBe(4.1666665);
    expect(cc.unexpected_disagreements).toBe(0);
  });

  it("/raw unavailable → cross_check degrades to a reasoned null; the primary response is unaffected", async () => {
    const kv = fakeKv();
    const env = seedCrossCheckEnv(kv, { seedRawStatus: false });
    forbidNetwork(); // the /raw fetch now fails with no cached copy

    const out = (await getPlanet(env, { index: 175 })) as Record<string, any>;
    expect(out.cross_check.available).toBe(false);
    expect(out.cross_check.reason).toBe("raw_unavailable");
    // primary payload intact
    expect(out.planet_name).toBe("GRAND ERRANT");
    expect(out.raw_hp).toBe(600_000);
  });
});

describe("get_source_crosscheck (handler, network forbidden)", () => {
  it("summarizes faithfulness: agreements counted, expected transforms excluded from disagreements, MO objectives checked; one samples:planets put; no resolution key", async () => {
    const kv = fakeKv();
    const env = seedCrossCheckEnv(kv);
    forbidNetwork();

    const out = (await getSourceCrossCheck(env)) as Record<string, any>;
    expect(out.campaigns.available).toBe(true);
    expect(out.campaigns.campaigns_checked).toBe(2);
    expect(out.campaigns.unexpected_disagreements).toBe(0);
    // 2× liberation_pct + 1× defense regen = at least 3 expected transforms
    expect(out.campaigns.expected_transforms).toBeGreaterThanOrEqual(3);
    expect(out.campaigns.agreements).toBeGreaterThan(0);
    expect(out.campaigns.divergent_fields).toEqual([]);
    expect(out.campaigns.unmatched).toEqual({
      in_normalized_only: [],
      in_raw_only: [],
    });
    expect(out.major_orders.available).toBe(true);
    expect(out.major_orders.assignments_checked).toBe(1);
    expect(out.major_orders.unexpected_disagreements).toBe(0);
    expect(kv.puts.filter((p) => p.key === "samples:planets")).toHaveLength(1);
    for (const key of allKeysDeep(out)) {
      expect(key).not.toMatch(RESOLUTION_KEY_PATTERN);
    }
  });

  it("a genuine divergence is listed with planet context, both values, and the diff — counted as unexpected", async () => {
    const kv = fakeKv();
    const env = seedCrossCheckEnv(kv, { rawHealthOverride: 580_000 });
    forbidNetwork();

    const out = (await getSourceCrossCheck(env)) as Record<string, any>;
    expect(out.campaigns.unexpected_disagreements).toBe(1);
    const d = out.campaigns.divergent_fields[0];
    expect(d.planet_index).toBe(175);
    expect(d.field).toBe("raw_hp");
    expect(d.normalized_value).toBe(600_000);
    expect(d.raw_value).toBe(580_000);
    expect(d.abs_diff).toBe(20_000);
  });

  it("/raw outage → both sections degrade to reasoned unavailability, never an error", async () => {
    const kv = fakeKv();
    const env = seedCrossCheckEnv(kv, { seedRawStatus: false });
    forbidNetwork();

    const out = (await getSourceCrossCheck(env)) as Record<string, any>;
    expect(out.campaigns.available).toBe(false);
    expect(out.campaigns.reason).toBe("raw_unavailable");
    expect(out.major_orders.available).toBe(false);
    expect(out.major_orders.reason).toBe("raw_unavailable");
  });
});
