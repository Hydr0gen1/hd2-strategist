/**
 * Cron-driven background sampling: the Worker's `scheduled` handler must
 * drive the SAME sampling path — and therefore the same single merged
 * sample-store write — as a request-driven poll, never a fork. Sanctioned
 * I/O exception (see test/CLAUDE.md): the same in-memory KV stub + throwing
 * fetch stub as stage6.test.ts — the raw cache is pre-seeded FRESH so the
 * network is never touched (the stub forbids it, it never simulates it),
 * and the puts log proves the write budget.
 */
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { SAMPLES_KEY_TTL_SECONDS } from "../src/client";
import { coerceStore, type SampleStore } from "../src/sampling";
import { getWarStatus } from "../src/tools";
import type { Env, RawCampaign, RawPlanet, RawWar } from "../src/types";

/* ------------------------------ fixtures ------------------------------ */

function makeRawPlanet(over: Partial<RawPlanet> = {}): RawPlanet {
  return {
    index: 175,
    name: "GRAND ERRANT",
    sector: "SECTOR",
    maxHealth: 1_000_000,
    health: 600_000,
    disabled: false,
    initialOwner: "Humans",
    currentOwner: "Terminids",
    regenPerSecond: 1.5,
    event: null,
    attacking: [],
    waypoints: [],
    statistics: null,
    biome: null,
    hazards: null,
    ...over,
  };
}

function makeRawCampaign(over: Partial<RawCampaign> = {}): RawCampaign {
  return {
    id: 42,
    planet: makeRawPlanet(),
    type: 0,
    count: 1,
    faction: "Terminids",
    ...over,
  };
}

const WAR: RawWar = {
  started: "2024-01-23T20:05:13Z",
  ended: "2028-02-08T20:04:55Z",
  now: "1972-04-26T00:00:00Z",
  clientVersion: "0.3.0",
  factions: ["Humans", "Terminids", "Automaton", "Illuminate"],
  impactMultiplier: 0.024,
  statistics: {
    missionsWon: 1,
    missionsLost: 1,
    missionSuccessRate: 50,
    terminidKills: 1,
    automatonKills: 1,
    illuminateKills: 1,
    deaths: 1,
    playerCount: 55_000,
    accuracy: 60,
  },
};

/* ------------------------------ KV stub ------------------------------- */

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

function seedRaw(kv: FakeKv, path: string, body: unknown): void {
  kv.store.set(
    `raw:${path}`,
    JSON.stringify({ fetchedAt: Date.now() - 1_000, body }),
  );
}

function seededEnv(kv: FakeKv): Env {
  seedRaw(kv, "/api/v1/planets", [makeRawPlanet()]);
  seedRaw(kv, "/api/v1/campaigns", [makeRawCampaign()]);
  seedRaw(kv, "/api/v1/assignments", []);
  seedRaw(kv, "/api/v1/war", WAR);
  return { WAR_CACHE: kv as unknown as KVNamespace };
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

/* ----------------------------- helpers -------------------------------- */

/** Fire one cron tick through the real exported `scheduled` handler. */
async function cronTick(env: Env): Promise<void> {
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "*/2 * * * *", noRetry() {} },
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
}

/** Parse the written store with every Worker-clock timestamp zeroed, so two
 * stores written milliseconds apart compare for structural identity. */
function normalizedStore(kv: FakeKv): SampleStore {
  const raw = kv.store.get("samples:planets");
  expect(raw).toBeTruthy();
  const store = coerceStore(JSON.parse(raw!));
  for (const series of Object.values(store.planets)) {
    for (const s of series.samples) s.t = 0;
  }
  for (const key of Object.keys(store.campaignsFirstSeen)) {
    store.campaignsFirstSeen[key] = 0;
  }
  for (const sig of store.signatures ?? []) {
    sig.first_seen = 0;
    sig.last_seen = 0;
  }
  for (const g of store.global ?? []) g.t = 0;
  return store;
}

/** Pre-seed a store whose every timestamp is `at`, for interval-guard tests. */
function seedStoreAt(kv: FakeKv, at: number): void {
  kv.store.set(
    "samples:planets",
    JSON.stringify({
      planets: { "175": { samples: [{ h: 700_000, t: at }], lastRate: null } },
      campaignsFirstSeen: { "42": at },
      signatures: [
        {
          campaign_type: 0,
          event_type: null,
          has_event: false,
          faction: "Terminids",
          first_seen: at,
          last_seen: at,
          sample_count: 1,
        },
      ],
      global: [
        {
          t: at,
          player_count: 50_000,
          missions_won: null,
          missions_lost: null,
          deaths: null,
          terminid_kills: null,
          automaton_kills: null,
          illuminate_kills: null,
        },
      ],
    } satisfies SampleStore),
  );
}

/* ------------------------------- tests -------------------------------- */

describe("scheduled handler — shared sampling path (never a fork)", () => {
  it("writes the IDENTICAL merged store a request-driven poll writes, with the identical write set", async () => {
    const kvCron = fakeKv();
    const kvRequest = fakeKv();
    const envCron = seededEnv(kvCron);
    const envRequest = seededEnv(kvRequest);
    const fetches = forbidNetwork();

    await cronTick(envCron);
    await getWarStatus(envRequest);

    expect(fetches.calls).toBe(0);
    // Same single per-cycle write (key + TTL) on both paths — the cron run
    // adds no KV write beyond the existing merged store write.
    expect(kvCron.puts).toEqual([
      { key: "samples:planets", ttl: SAMPLES_KEY_TTL_SECONDS },
    ]);
    expect(kvRequest.puts).toEqual(kvCron.puts);
    // Identical store content (planet series, campaign first-seen,
    // signature tuple, global point) modulo the Worker-clock timestamps:
    // both paths write through the same samplePlanetRates call.
    expect(normalizedStore(kvCron)).toEqual(normalizedStore(kvRequest));
  });

  it("a scheduled run on a cold store seeds planet series, signature tuple, and global point", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    forbidNetwork();

    await cronTick(env);

    const store = coerceStore(JSON.parse(kv.store.get("samples:planets")!));
    expect(store.planets["175"]?.samples.map((s) => s.h)).toEqual([600_000]);
    expect(store.campaignsFirstSeen["42"]).toBeTypeOf("number");
    expect(store.signatures).toHaveLength(1);
    expect(store.signatures?.[0]).toMatchObject({
      campaign_type: 0,
      event_type: null,
      has_event: false,
      faction: "Terminids",
      sample_count: 1,
    });
    expect(store.global).toHaveLength(1);
    expect(store.global?.[0]?.player_count).toBe(55_000);
  });

  it("past the 60s interval a tick appends history points and bumps the signature count", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    seedStoreAt(kv, Date.now() - 120_000); // one 2-min cron period ago
    forbidNetwork();

    await cronTick(env);

    const store = coerceStore(JSON.parse(kv.store.get("samples:planets")!));
    const series = store.planets["175"]!;
    expect(series.samples).toHaveLength(2);
    // 700k → 600k over ~2 minutes: positive rate, sign convention intact.
    expect(series.lastRate).toBeGreaterThan(0);
    expect(store.signatures?.[0]?.sample_count).toBe(2);
    expect(store.global).toHaveLength(2);
  });

  it("within the 60s interval nothing is double-sampled — the guard is not bypassed", async () => {
    const kv = fakeKv();
    const env = seededEnv(kv);
    seedStoreAt(kv, Date.now() - 30_000); // too recent to sample again
    forbidNetwork();

    await cronTick(env);

    const store = coerceStore(JSON.parse(kv.store.get("samples:planets")!));
    expect(store.planets["175"]?.samples).toHaveLength(1);
    expect(store.signatures?.[0]?.sample_count).toBe(1);
    expect(store.global).toHaveLength(1);
    // Still exactly one (idempotent) merged-store write, nothing extra.
    expect(kv.puts.map((p) => p.key)).toEqual(["samples:planets"]);
  });

  it("upstream failure during a scheduled run is swallowed — resolves, zero writes", async () => {
    const kv = fakeKv(); // nothing seeded: every fetch fails, no fallback
    const env: Env = { WAR_CACHE: kv as unknown as KVNamespace };
    forbidNetwork();

    await expect(cronTick(env)).resolves.toBeUndefined();
    expect(kv.puts).toEqual([]);
  });
});
