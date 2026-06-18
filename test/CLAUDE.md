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

A fourth sanctioned exception (stage12.test.ts): a small in-memory D1 stub
(`FakeD1`) — same spirit as the KV stub. It stores rows per table and executes
the four archive INSERTs (incl. the signature UPSERT) and the three archive
SELECTs, recording every `db.batch` call (proving the single-batch-per-tick
budget) and the SELECT SQL (proving values are bound, never interpolated). No
network, no real SQLite. The KV stub still proves the KV write budget is
UNCHANGED by Stage 12 (the D1 write is a separate store).

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
- Stage 9 (`stage9.test.ts`):
  - `perIntervalRates` IS the `historyRateAggregates` derivation (parity-
    pinned — never a parallel path); non-positive Δt pairs skipped.
    `moIntervalRates`: progress counts UP, positive = progressing; null-
    progress pairs skipped (missing is never 0).
  - `buildEtaBlock` on a known fixture: eta_instantaneous = distance ÷
    |current rate|, eta_historical = distance ÷ mean of interval rates;
    negative rates project by MAGNITUDE with the signed rate carried
    alongside; `rate_stability` = exact max − min spread (null below two
    rates).
  - Thin-history honesty: no current rate → null + `no_current_rate`;
    < 2 points → null + `insufficient_history`; rate 0 (either path) →
    null + `stalemate` with every numeric field finite (no divide-by-zero,
    no Infinity); unknown distance → null + `unknown_distance` while the
    observed rates stay reported. Every null ETA has a reason; every
    computed ETA has none.
  - `rateDivergence`: exact abs/pct (symmetric over max(|a|,|b|)); null when
    EITHER rate is null; both-zero → pct 0, no division; `diverging` flips
    exactly at the documented threshold.
  - `buildDefenseEtaBlock`: both depletion ETAs computed; the window
    comparison evaluated against EACH rate independently (a fast current
    rate flips only the instantaneous column); null ETAs/window → null
    comparisons; Stage 7 orientation preserved (high event HP = LARGE
    depletion ETA); **key-name pin** — no success/fail/outcome/predict/
    verdict key anywhere in the block.
  - End-to-end (KV stub, stage6 pattern): liberation
    `eta_instantaneous_hours` === `hours_to_resolution` (one projection
    source); the defense block agrees with the Stage 7
    `resolution_within_defense_window`; cold start → reasons; getCampaigns
    still performs exactly one `samples:planets` put; getMajorOrder /
    getMajorOrderHistory stay at ZERO KV writes; the MO eta uses the latest
    delta (instantaneous) and series mean (historical) with the
    (target − progress) numerator, and rides BESIDE the byte-identical
    Stage 8 series shape.
- Stage 11 (`stage11.test.ts`):
  - `advanceGlobalSeries` extras: `impact_multiplier` / `active_campaign_count`
    recorded on a sampled point; absent/null/non-finite → null, never 0;
    extras never create a sample alone (the stats gate and 60s guard are
    unchanged).
  - Back-compat: pre-Stage-11 global points coerce with both new fields null
    — never backfilled; new-shape points round-trip intact.
  - **Folded write**: the extras ride the existing single `samples:planets`
    put; a later poll without them appends nulls, never 0.
  - `buildGlobalHistoryPoints`: exact `delta_impact_multiplier` /
    `delta_active_campaign_count`, null-propagating, negative deltas pass
    through; full series with the new fields stays far under the KV limit.
  - Handlers (KV stub): `get_war_status` exposes the current raw
    `impact_multiplier`; `get_global_history` serves the new fields read-only
    with a **prime-directive key-name pin** — no correlation/regression/
    forecast/model/formula key anywhere.
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

- Stage 10 (`stage10.test.ts`):
  - `crossCheckSubject`: agreeing liberation fields all `agrees: true` with
    both values present; a genuine divergence → `agrees: false` with both
    values AND abs/pct diff (never resolved); discrete divergence
    (campaign_type) surfaced with both values; owner decoded via the
    live-verified `RAW_FACTION_NAMES` map only — an unmapped enum value →
    `agrees: null` + `unconfirmed_raw_enum_value`, never a guessed name.
  - Float tolerance (documented relative 1e-6): within → `agrees: true`;
    outside → `agrees: false` with the diff; `floatsAgree` flips exactly
    around the threshold.
  - **Expected transforms are never mismatches**: defense regen (invariant-1
    force-null) → `expected_transform: true` with the raw value shown beside
    the deliberate null, NOT `agrees: false` (specific test); liberation %
    (invariant-2 recompute) → `expected_transform: true`; a defense compares
    EVENT health/maxHealth (the tracked health).
  - Absent sides → `agrees: null` + reason (`field_absent_in_raw`,
    `field_absent_in_normalized`, `planet_absent_in_raw`,
    `campaign_absent_in_raw`), never a false mismatch; a quiet-planet probe
    makes no campaign_type claim at all.
  - `summarizeChecks`: agreements / unexpected disagreements / expected
    transforms / uncheckable tallied apart — transforms never count as
    disagreements.
  - `crossCheckAssignments`: identical assignment fully agrees (one shared
    goal decode); divergent progress → both values; an absent raw assignment
    is reported, never dropped. `unmatchedCampaigns`: both directions, sorted.
  - **Key-name pin (prime directive)**: no source-resolution key
    (authoritative/chosen/trusted/preferred/winner/correct/resolved/verdict)
    exists recursively in a built block (agreeing AND diverging), the
    unavailable block, or the full `get_source_crosscheck` payload.
  - Handlers (KV stub, stage6 pattern): `get_planet` cross_check agrees on a
    seeded match with invariant transforms classified; `/raw` outage →
    `available: false, reason: "raw_unavailable"` with the primary response
    unaffected; `get_source_crosscheck` summarizes with expected transforms
    excluded from disagreements and lists divergent fields with planet
    context + both values + diff; **the raw fetch adds ZERO sample-store
    writes** — still exactly one `samples:planets` put per poll.

- Stage 12 (`stage12.test.ts`) — the D1 archive ALONGSIDE the unchanged KV path:
  - Pure builders: `buildPlanetArchivePoints` (first point null deltas, exact
    consecutive diffs, null health → null delta never 0, stored signed
    `hp_per_hour` carried), `buildGlobalArchivePoints` (reuses the global
    history delta derivation over archive rows), `buildMoArchiveSeries` (groups
    flat rows per objective, exact `delta_progress`, `objective_kind` null
    because `task_type` is not archived, `insufficient_history` below two).
  - `archiveSampleTick`: no binding → no-op; empty tick → no batch; all four
    sections insert in ONE batch; the signature UPSERT seeds `first_seen` then
    a later observation PRESERVES `first_seen` and bumps `last_seen` /
    `sample_count`; a forced D1 error is SWALLOWED, never thrown; **concurrent
    overlap** — two ticks sharing a `tick_anchor` insert only ONE row (the
    unique index `INSERT OR IGNORE` no-ops the second; first writer wins). The
    `FakeD1` stub emulates the unique index per append-only table.
  - **Write path through `samplePlanetRates` (KV stub + D1 stub):** a fresh
    tick writes BOTH the single unchanged `samples:planets` KV put AND the D1
    archive rows (planet/global/MO + signature) in ONE `db.batch`; a later
    tick archives the computed signed rate; **interval gating** — a within-60s
    replay inserts NO duplicate D1 rows and performs no batch; **overlapping
    polls** — two polls that read the same predecessor tail (the second
    simulated by restoring the pre-A store) archive ONCE, not twice (shared
    `tick_anchor` → unique-index drop); **failure isolation** — D1 down still
    yields a normal result AND the KV write; **KV-commit gate** — a FAILED KV
    put (or no KV binding) means the tick is NOT archived (no over-sampling
    against a stale store); no D1 binding → KV path behaves exactly as before
    (one put, no throw).
  - Read path: `readPlanetArchive`/`readGlobalArchive`/`readMoArchive` return
    rows time-ordered ascending, scoped (planet / MO id / objective), honoring
    `since`/`limit`, with **parameterized SQL pinned** (placeholders present,
    no interpolated values); a CAPPED window returns the NEWEST `limit` rows
    (DESC + LIMIT, re-sorted ascending), never the oldest. Handlers
    (`getPlanetArchive` over a seeded raw
    cache + D1 stub; `getGlobalArchive`/`getMajorOrderArchive`): time-ordered
    points with correct deltas, `insufficient_history` on a cold archive with a
    non-error note, zero KV writes, and a **prime-directive key-name pin** (no
    forecast/on_track/required_pace/verdict/recommend/priority/rank key).

- Fabel features (`stage13.test.ts`) — additive facts over the existing,
  unchanged pipeline:
  - Feature 1: `buildInboundNeighbors` inverts observed waypoints (sorted, no
    dangling); existing outbound `buildNeighbors` is byte-unchanged;
    `buildAdjacencySummary` counts inbound ∪ outbound and sets
    `borders_super_earth` only from a Human neighbor. `buildSupplyGraph`:
    default = active-campaign subgraph + one-hop; `active_only` narrows to
    active planets; `full` spans the galaxy; edges are observed waypoints ONLY
    (no implied reverse), dangling targets never become nodes/edges.
  - Feature 2: `buildGambitOrigins` resolves the attacker(s) of a defense from
    inverted attack pairs, joins `is_major_order_target`, sorts by index, and
    carries NO viability/verdict key (pinned).
  - Feature 3: `perPlayerRates` — the Basquine-VIII validation checkpoint
    (gross ≈ +71k, ≈2.35k per 1k, sign positive); defense nulls gross with
    `defense_decay_nulled_invariant_1` (net still present); zero players nulls
    the per-player fields with `no_players` (no divide-by-zero); missing rate →
    `no_current_rate`.
  - Feature 4: `selectRegions` passes raw fields through faithfully, detects a
    City via upstream `size`, coerces the literal `"null"` description, and
    reports `regions_available: false` with nothing fabricated on an absent
    array.
  - Handlers (KV stub, stage6 pattern): `get_planet` surfaces all four
    features cache-served with a **prime-directive key-name pin** over the whole
    payload; `get_supply_graph` returns the active-campaign subgraph READ-ONLY
    (zero `samples:planets` puts), resolves a root by name / `full`, and carries
    the split `provenance` + `active_campaign_overlay` block. Split-provenance
    acceptance tests: (1) campaign-only outage → `campaigns: 'unavailable'`,
    overlay `unavailable`, `planet_source: 'live'`, topology returned flagged
    `campaign_state_known: false` (not a bare empty), note points at provenance;
    (2) planet-snapshot-only → `planet_snapshot_used: true`, `campaigns: 'ok'`,
    overlay `complete`; (3) both nominal → `stale` absent, overlay `complete`;
    (4) both degraded → both flags + reasons; (5) `full:true` under campaign
    outage → complete topology, per-node `campaign_state_known: false`, overlay
    `unavailable`; (6) no node asserts `has_active_campaign: false` while
    unknown; (7) ZERO persistence (KV + `FakeD1` batch) on every degraded path.
  - Feature 5: `get_planet` serves the durable `snapshot:planets` (`stale:
    true`) when every live fetch fails; the snapshot is refreshed only on a
    genuine upstream fetch (a cache hit writes none).
  - P1 provenance-gated persistence (the `samplePlanetRates` `persist` gate):
    (1) get_planet during a campaign-fetch failure with planets from snapshot →
    `stale: true`, ZERO `samples:planets` puts and ZERO D1 batches; (2) a cron
    tick over EXPIRED (stale-served) caches → no KV append, no D1 row; (3) a
    fully-live fetch still samples + archives (the gate did not over-block);
    (4) an active planet during a campaign outage is `has_active_campaign: null`
    + `campaign_state_known: false` (never false) and does not sample as quiet;
    (5) an empty-but-LIVE campaigns result (`ok: true`) still records —
    distinguished from `ok: false`; (6) predicate unity — a `stale: true`
    response wrote nothing and a writing response was not stale, asserted both
    directions. A minimal `FakeD1` (batch counter) proves the archive gate; the
    `samples:planets` put count proves the KV gate.
  - P1 round 2 (decoupled persistence): the reviewer's case — planets SNAPSHOT
    + campaigns FRESH → `get_planet` writes ZERO samples (the loader records
    nothing; the terminal gate suppresses the commit); planets-live+campaigns-ok
    still persists (regression); planets-live+campaigns-`ok:false` writes
    nothing; **loader purity** — a fully-live `get_supply_graph` commits nothing
    (the loader itself never writes); cron over a stale campaign cache records
    nothing.
  - P2 (active_only under outage): `{full:true, active_only:true}` during a
    campaign outage returns the COMPLETE topology (`active_only_applied: false`,
    overlay `unavailable`, per-node `campaign_state_known: false`), never an
    empty graph misread as "no active campaigns"; `active_only` with `ok`
    campaigns applies the filter (`active_only_applied: true`); with `stale`
    campaigns applies it on the last-known set (overlay `degraded`).

## Conventions

- Build fixtures with the `makeCampaign` / `makeEvent` / `ctx` helpers in
  `invariants.test.ts`; defaults are a mature (2h old), non-HPC liberation
  campaign at 600k/1M HP with a +10k/h rate — override only what the test is
  about.
- Rates in tests follow the client.ts sign convention: positive = progressing,
  negative = losing. Don't invent fixtures that contradict it.
