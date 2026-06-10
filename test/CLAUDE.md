# test/ — unit tests

Plain vitest, no Workers runtime: everything under test is pure
(`src/invariants.ts`, `src/enrichment.ts`, `src/sampling.ts`, `src/wiki.ts`).
If a test needs I/O or KV, the code under test is in the wrong module — move
the logic, don't mock the world. Two sanctioned exceptions:
`src/wikiClient.ts` (stage4.test.ts), whose fetch is INJECTED per call, and
`samplePlanetRates` in `src/client.ts` (stage5.test.ts), which does no
network I/O — both use the same ~10-line in-memory KV stub; no network, no
global mocking. The stub's `puts` log is what proves the one-write-per-cycle
budget.

## Coverage that must never regress

Each of these maps to a spec requirement; removing or weakening one breaks
the project's definition of done:

- Each of the five invariants in isolation.
- Edge case 3: `hp_per_hour === 0` → `hours_to_resolution: null`,
  `status: "stalemate"`, no division.
- Edge case 4: negative rate on a liberation campaign → `direction: "losing"`,
  but a young campaign gets `stabilizing: true` and a suppressed alert.
- Edge case 7: defense campaign WITH an upstream `regenPerSecond` value →
  output decay is null (invariant 1, tested specifically).
- Edge case 8: newly opened HPC with steep decay → not failing
  (invariants 4 + 5 stacked, tested specifically).
- Sign-convention mirror: losing DEFENSE campaign with RISING `event.health`
  → negative `hp_per_hour`, `direction: "losing"`, positive abs
  `hours_to_resolution`, alerts still suppressed when young or HPC. This
  proves the sign doesn't flip across campaign kinds.
- Data-quality gate: missing/NaN `raw_hp` → `data_quality: "degraded"`,
  excluded from projections, never substituted with 0.
- Stage 1 (`stage1.test.ts`): `mission_success_rate` zero-missions → `null`
  (never 0, no divide-by-zero); defense timing from the SUPPLIED clock with
  past-end → `0` + `defense_expired: true` and missing `endTime` → `null`;
  missing statistics → `null`, never fabricated; missing biome → `null`;
  missing hazards → `[]`, never null.
- Stage 2 (`stage2.test.ts`):
  - **Rate-preservation regression**: `advancePlanetSeries` yields the EXACT
    signed `hp_per_hour` (float-equal, `toBe`) that the pre-ring-buffer
    single-sample store computed for the same two data points — both signs
    plus the zero case. This is the proof the history refactor didn't touch
    rate semantics.
  - Legacy-store migration (`{h, t, lastRate}` → one-sample series) produces
    the identical next-poll rate; hybrid/garbage entries coerce safely.
  - Ring-buffer bounds: never more than `MAX_SAMPLES_PER_PLANET` points,
    over-age points evicted on append, the newest sample never evicted,
    the no-append path leaves the series untouched.
  - Worst-case serialized store (full galaxy × max points) stays far under
    the 5MB KV value limit.
  - `buildHistoryPoints`: per-point `delta_health`/`delta_hours` are exact
    consecutive differences, first point null — observed deltas, never a
    projection.
  - `shapeDispatches`/`shapePatchNotes`: newest-first (unparseable dates
    sink), limit clamping at every edge, empty upstream → `[]`,
    message/content passed through verbatim.
- Stage 4 (`stage4.test.ts`):
  - `decodeEventModifier`: no event → both null; mapped enum (injected map)
    → name; unmapped enum → `event_type` raw + `modifier: null` (never
    fabricated); the MAP is consulted, not an inline table; NaN eventType →
    both null; additive over `normalizeCampaign` (invariant 1 untouched).
  - `EVENT_MODIFIER_NAMES` ships EMPTY — pinned by test. When a live event
    confirms an enum value, seed the map AND update that test together.
  - Wiki pure (`wiki.ts`): candidate planning (as-sent + title-cased, deduped,
    one multi-title URL, `wiki:` cache key); success carries title/extract/
    canonical URL; redirect followed and reported via `redirected_from`;
    missing page and empty extract → `found: false` + hint, no throw;
    malformed body → `found: false`, no throw; long extract capped at
    `WIKI_EXTRACT_MAX_CHARS` with `truncated: true`.
  - **Attribution always present** (source/license/license_url/retrieved_at/
    notes/url) on every wiki outcome, found or not.
  - Wiki I/O (`wikiClient.ts`, injected fetch + in-memory KV): fresh cache hit
    never fetches; success caches under `wiki:` with the long TTL; failure →
    stale fallback when a copy exists, typed `WikiError` when not; descriptive
    User-Agent built from SUPER_CLIENT/SUPER_CONTACT with safe fallbacks.

- Stage 5 (`stage5.test.ts`):
  - `foldSignatures`: new tuple appended with `first_seen`; repeat tuple bumps
    `last_seen`/`sample_count` only past the 60s guard (cache replays never
    inflate counts); per-cycle dedupe; a missing upstream field is null INSIDE
    the tuple and null is a distinct identity; cap evicts oldest `last_seen`;
    empty observation set leaves the record untouched.
  - `advanceGlobalSeries`: null stats (a poll that never fetched the war) →
    series untouched, never an all-null row; missing fields → null, never 0;
    bounded by count + age with the newest sample surviving.
  - **Folded write**: `samplePlanetRates` performs exactly ONE put per call on
    `samples:planets` (30-day TTL) containing the folded signatures + global
    series; the batch poll preserves both accumulation layers while rebuilding
    planet series; a `carryForward` probe preserves them byte-identically;
    pre-Stage-5 stores coerce without gaining empty sections.
  - `moPlanetAssignmentMap`: parity with the legacy MO planet-set derivation
    (invariant-5 membership unchanged); first assignment wins on collision.
  - `buildNeighbors`: dangling waypoint counts in `total` + `unknown` bucket;
    `frontline` true iff a KNOWN owner differs (unknown owners never set it);
    no-waypoint case zeroed.
  - `historyRateAggregates`: exact min/max/mean/latest on a known series using
    the hp_per_hour sign convention; <2 points → all null; Δt ≤ 0 pairs
    skipped, never divided; no trend/forecast key emitted.
  - `buildGlobalHistoryPoints`: exact consecutive deltas, null-propagating
    (missing is never 0), negative deltas passed through as observed.
  - `buildFactionRollup`: `net_hp_per_hour` is ECHOED from the supplied front
    aggregates (sentinel-pinned — never recomputed); player sums follow the
    Stage 3 null-honesty pattern with coverage counts.
  - Combined worst-case store (full galaxy × max points + max signatures +
    max global samples) stays far under the 5MB KV value limit.

## Conventions

- Build fixtures with the `makeCampaign` / `makeEvent` / `ctx` helpers in
  `invariants.test.ts`; defaults are a mature (2h old), non-HPC liberation
  campaign at 600k/1M HP with a +10k/h rate — override only what the test is
  about.
- Rates in tests follow the client.ts sign convention: positive = progressing,
  negative = losing. Don't invent fixtures that contradict it.
