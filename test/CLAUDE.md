# test/ — unit tests

Plain vitest, no Workers runtime: everything under test is pure
(`src/invariants.ts`, `src/enrichment.ts`, `src/sampling.ts`, `src/wiki.ts`).
If a test needs I/O or KV, the code under test is in the wrong module — move
the logic, don't mock the world. Two sanctioned exceptions:
`src/wikiClient.ts` (stage4.test.ts), whose fetch is INJECTED per call, and
`samplePlanetRates` in `src/client.ts` (stage5.test.ts), which does no
network I/O — both use the same ~10-line in-memory KV stub; no network, no
global mocking. The stub's `puts` log is what proves the one-write-per-cycle
budget. A third sanctioned exception (stage6.test.ts, and scheduled.test.ts
on the same pattern): the `get_war_brief` / `get_campaigns` /
`resolve_planet` handlers — and the Worker's cron `scheduled` handler — run
against the same KV stub with every `raw:` cache entry pre-seeded FRESH and
`globalThis.fetch` replaced by a stub that throws — proving the handlers add
zero upstream fetch volume beyond the shared cache (the stub is restored in
`afterEach`; it forbids the network, it never simulates it).

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

- Stage 6 (`stage6.test.ts`):
  - `resolvePlanetName`: exact and punctuation/space-normalized matches
    resolve (canonical upstream casing); fuzzy near-misses and ties return
    RANKED candidates with `matched: false` — never a silent substitution;
    no match → empty candidates + hint; candidate list capped.
  - `filterCampaigns`: each filter narrows correctly, filters AND-combine,
    no-args (and explicit-false flags) return the full list with the SAME
    object references — filtering never re-normalizes.
  - `freshnessFrom`: as_of/fetched_at from the cache record's stored
    timestamp (OLDEST contributing endpoint governs), age in whole seconds
    clamped at 0, empty/garbled input → nulls.
  - Part F aliases: `defense_seconds_remaining` / `defense_time_remaining`
    agree with the untouched `defense_hours_remaining`; missing endTime →
    all null; `shapeMajorOrders` keeps the exact legacy get_major_order
    field set incl. the seconds + humanized pair.
  - Brief assembly: MO targets joined to live campaigns; a target with no
    active campaign is included with static state, never dropped; dangling
    MO index keeps nulls; `buildActiveEvents` empty when no events.
  - **Fetch/write budget**: with the raw cache pre-seeded fresh, getWarBrief
    makes ZERO network fetches and exactly one `samples:planets` put;
    resolve_planet makes zero KV writes.
  - **Prime directive pin**: every key in the brief payload (recursively) is
    checked against interpretive names (recommend/priority/rank/score/...).

- Stage 7 (`stage7.test.ts`):
  - **Direction regression across kinds**: positive rate → `repelling` on a
    defense and `liberating` on a liberation (unchanged); negative → `losing`
    for both; `directionFromRate` without a kind arg keeps the legacy
    liberation labels. The sanctioned semantic change is the defense
    positive-label ONLY.
  - `winCondition`: both kinds → `raw_hp_to_zero` — pinned to the LIVE
    verified orientation (2026-06-11, Crimsica/Bore Rock: event health falls
    while a defense is won). `hpRemainingToObjective`: a defense at 97% event
    HP reads as a LARGE distance (never nearly-complete); null HP → null.
  - `defenseWindowProjection`: exact `raw_hp − rate × hours` arithmetic both
    signs, unclamped through zero; the boolean is a pure
    `hours_to_resolution ≤ defense_hours_remaining` comparison; both null on
    a null rate; stalemate → projected = current HP, boolean null.
  - Part C: `LIBERATION_PCT_NOTE` carries the exact formula; the VALUE of
    `isolateLiberationPct` is unchanged (still display-only).
  - Part D: the live Omicron/Crimsica objective shapes decode to
    target/progress_pct/objective_kind/value_labels with the raw arrays
    retained verbatim; unknown task_type → label null (never fabricated);
    target 0/absent → progress_pct null; the label maps are pinned to
    live-confirmed entries only.
  - **End-to-end (KV stub, stage6 pattern)**: a Bore-Rock-shaped failing
    defense through getCampaigns/getPlanet surfaces repelling + large
    hp_remaining_to_objective + resolution_within_defense_window: false,
    with the convention notes riding the payloads — the retired misread,
    pinned.
- Stage 8 (`stage8.test.ts`):
  - `advanceMoSeries`: seeds per-objective series with `{t, progress, target}`;
    appends only past the 60s guard (cache replays never double-sample);
    multiple objectives tracked independently; MO TURNOVER — a new id starts
    a fresh series, the prior MO's series is retained with no point
    cross-contamination and ages out (stale samples drop, an emptied
    inactive series disappears); no active MO → carried forward, never
    wiped; missing progress/target → null in the sample (never 0) while a
    target of 0 is recorded as observed; non-finite series identity skipped;
    bounded per series (MAX_MO_SAMPLES, newest survives) and in series count
    (MAX_MO_SERIES, oldest newest-sample evicted).
  - `coerceStore` mo section: pre-Stage-8 store round-trips WITHOUT an `mo`
    key; stored series round-trip; garbage drops without throwing.
  - **Folded write**: `samplePlanetRates` performs exactly ONE put containing
    the folded MO series; the batch poll and a `carryForward` probe both
    preserve the layer; no empty `mo` section is ever written.
  - `moProgressObservations`: PARITY with `shapeMajorOrders` objectives
    (progress/target from the SAME `decodeObjectiveTarget` — never a second
    decode); missing progress/goal slot → null; non-finite assignment id
    skipped.
  - `buildMoHistorySeries`: exact consecutive `delta_progress`/`delta_hours`
    (first point null, null-propagating, negative deltas pass through);
    `progress_pct` divide-by-zero (target 0/missing) → null; < 2 points →
    `insufficient_history` with span null; `objective_kind` from the map
    only (unknown task_type → null label, never fabricated); **prime
    directive pin** — no forecast/pace/on-track/verdict key anywhere.
  - `getMajorOrderHistory` handler (KV stub, stage6 pattern): cold start →
    empty flagged series, zero KV writes, zero fetches; no active MO →
    flagged not an error, prior MO still queryable by id; default returns
    only the active MO's series; `objective_index` narrows.
  - Combined worst-case store INCLUDING max MO series stays far under the
    5MB KV value limit.
- Scheduled sampling (`scheduled.test.ts`):
  - The cron `scheduled` handler writes the IDENTICAL merged store a
    request-driven `get_war_status` poll writes (stores compared deep-equal
    with Worker-clock timestamps normalized) with the identical write set —
    behavioral proof the cron path rides the request path's own loader,
    never a fork.
  - A cold-store tick seeds planet series + signature tuple + global point;
    a tick past the 60s interval appends history points and bumps the
    signature count; a tick within 60s double-samples NOTHING (the
    `MIN_SAMPLE_INTERVAL_MS` guard is never bypassed).
  - Exactly ONE `samples:planets` put per tick (30-day TTL), nothing extra.
  - Upstream failure during a tick resolves silently with zero writes —
    best-effort, swallowed, never a thrown exception out of the Worker.

## Conventions

- Build fixtures with the `makeCampaign` / `makeEvent` / `ctx` helpers in
  `invariants.test.ts`; defaults are a mature (2h old), non-HPC liberation
  campaign at 600k/1M HP with a +10k/h rate — override only what the test is
  about.
- Rates in tests follow the client.ts sign convention: positive = progressing,
  negative = losing. Don't invent fixtures that contradict it.
