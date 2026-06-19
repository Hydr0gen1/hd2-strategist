# src/ — Worker source

Module boundaries are strict; respect them when editing:

| File | Role | Boundary rule |
|------|------|---------------|
| `invariants.ts` | The five domain invariants + `normalizeCampaign` | **Pure. Zero I/O, zero imports from client/tools/mcp.** External facts (rates, ages, MO planet set) arrive via `NormalizeContext`. |
| `enrichment.ts` | Stage 1+2+4+5+6+7 fact pass-throughs: planet statistics subset, defense deadline timing, biome/hazards, dispatch/patch-note shaping, history deltas, live event/modifier decode (`EVENT_MODIFIER_NAMES`), Stage 5 joins/aggregates (waypoint neighbors, MO assignment map, history rate aggregates, global history points, signature shaping, faction/sector rollups), Stage 6 consumption helpers (MO shaping, freshness metadata, planet-name resolution, campaign filters, brief target/event assembly), Stage 7 objective framing (`winCondition` / `hpRemainingToObjective` / `defenseWindowProjection`, the MO objective decode maps `TASK_TYPE_NAMES`/`TASK_VALUE_TYPE_NAMES`, and the inline-convention note constants), Stage 8 MO progress history (`moProgressObservations`, `buildMoHistorySeries`, the shared `decodeObjectiveTarget`/`objectiveProgressPct` decode), Stage 9 dual ETAs (`buildEtaBlock`/`buildDefenseEtaBlock`, `rateDivergence`, `perIntervalRates`/`moIntervalRates`), Fabel additive facts (`buildInboundNeighbors`/`buildAdjacencySummary`/`buildSupplyGraph` — pure edge inversion, observed edges only; `buildGambitOrigins` — inverted attack pairs; `perPlayerRates` — divide-guarded, consumes the one signed rate + nulled decay; `selectRegions` — faithful passthrough). Every campaign/MO annotation builder takes the tri-state `CampaignView` (from `provenance.ts`), never a raw map — absence is never silently `false` | **Pure. Zero I/O.** Raw objects and the clock arrive from the handler layer. Facts and unit conversions only — never a judgment. |
| `wiki.ts` | Stage 4 LORE source, pure half: wiki query plan (title candidates, one multi-title request), response shaping, extract cap, mandatory attribution | **Pure. Zero I/O. SEPARATE source** — never imports from or feeds into the live war-state pipeline; no live war number in any output. |
| `wikiClient.ts` | Stage 4 LORE source, I/O half: helldivers.wiki.gg fetch (descriptive User-Agent) + long-TTL KV cache in the `wiki:` namespace with stale fallback | Deliberately separate from `client.ts`. Injectable fetch for tests. Never touches `raw:`/`samples:` keys. |
| `sampling.ts` | Pure sample-store logic: the bounded planet ring buffer (`advancePlanetSeries`), legacy-shape coercion, eviction, retention constants, the Stage 5 accumulation layers (`foldSignatures`, `advanceGlobalSeries`), and the Stage 8 Major Order progress series (`advanceMoSeries`) | **Pure. Zero I/O.** The store travels in/out via client.ts. Implements the rate formula verbatim; the sign convention is DEFINED in client.ts. |
| `client.ts` | Upstream fetch + KV cache + rate sampling; triggers the Stage 12 D1 archive write after the KV write; Fabel warm bulk-planet snapshot (`cacheBulkPlanets` / `readBulkPlanetsSnapshot`, key `snapshot:planets`) | Owns the `hp_per_hour` sign convention (comment block) and all KV access. The D1 write is delegated to `archive.ts` and is best-effort — it NEVER alters the KV write, the rate path, or the return value. The warm snapshot is written ONLY on a genuine upstream fetch (`UpstreamResult.cached === false`), so it adds no KV write on a plain cache hit; it is a context-lookup fallback ONLY and never feeds the history/archive path. **P1 provenance gate:** persistence is DECOUPLED from loading — `prepareSampleTick` (one KV read, ZERO writes) computes the rates + the unwritten next-store; `commitSampleTick` is the single gated write (KV put → `kvCommitted` → D1 row). `samplePlanetRates` = prepare + (persist ? commit) for direct callers; loaders use prepare ONLY and hand the tick back for the handler's terminal `commitCampaignTick`, so no loader writes and the gate can't be bypassed by fetch ordering. |
| `archive.ts` | Stage 12 D1 history archive I/O: the best-effort batched per-tick write (`archiveSampleTick`) and the long-range read queries (`readPlanetArchive` / `readGlobalArchive` / `readMoArchive`) behind the three `*_archive` tools | **The D1 analog of client.ts (I/O).** APPEND-ONLY archive that lives ALONGSIDE the KV ring buffer, never replacing it — D1 is read ONLY by the archive tools, NEVER by live logic. Write is one `db.batch` per tick (never a per-row loop), gated by the SAME 60s interval as the KV write (no duplicate rows), wrapped in its own try/catch that swallows (a D1 outage degrades to "tick not archived", never an error). Parameterized SQL ONLY — every value via `.bind()`. The pure row→point delta builders live in `enrichment.ts`. |
| `crosscheck.ts` | Stage 10 raw-source cross-check: normalized fields verified against the raw ArrowHead payloads from the wrapper's `/raw` endpoints (paths + field mappings verified live 2026-06-11; `RAW_FACTION_NAMES` enum map live-verified, fail-safe null on unknown values) | **Pure. Zero I/O.** SURFACE, NEVER RESOLVE: every check presents both values + the diff; no side is picked, averaged, or ranked correct (key-name pinned). The only classification is `expected_transform: true` for documented invariant transforms (defense decay nulled, liberation % recomputed). Absent counterparts → `agrees: null` + reason, never a false mismatch; float tolerance relative 1e-6. |
| `tools.ts` | The eighteen tool implementations | Orchestration only: fetch → assemble context → call pure normalization/shaping. Fabel: `get_supply_graph` is the eighteenth tool — READ-ONLY (the side-effect-free loader is never committed; records nothing), with split `provenance` (planet-list `planet_source` for topology vs campaign-overlay `campaigns: ok|stale|unavailable`) + `active_campaign_overlay`; under a campaign outage it returns complete topology with per-node `campaign_state_known: false` (never `has_active_campaign: false`). P2: the `active_only` deletion runs ONLY when campaign state is known — under an outage it is skipped (`active_only_applied: false`, full topology kept) so an empty result is never a silent "no active campaigns". `get_planet` gains `inbound_neighbors`/`adjacency_summary` (feature 1), `gambit_origin(s)` on the defense event (feature 2), `per_player_rates` (feature 3), and `regions`/`regions_available`/`has_city_region` (feature 4). `get_planet` and `get_supply_graph` load planets via `fetchPlanetsWithFallback` (returns `planet_provenance`) and `loadCampaignsResilient` (returns `campaign_provenance` + the `view`) — an outage degrades to `stale: true` (the `anyDegraded` rollup), never an error. **P1:** persistence is gated on provenance (`persist` into `samplePlanetRates`), never on planet state — a snapshot/stale/resilient-empty observation is served but NOT recorded; `stale: true` and "wrote nothing" are the same predicate. When campaign state is UNKNOWN (`ok: false`), get_planet does NOT enter the quiet-sampling branch (unknown ≠ quiet): it serves read-only from last-known samples, with `has_active_campaign: null` + `campaign_state_known: false`. All five are additive facts (raw or deterministic transform), never a verdict. Stage 12: the three `*_archive` tools read the D1 archive (`archive.ts`) and shape it through the pure builders in `enrichment.ts` — same prime-directive honesty as the KV history tools (observed points + deltas, `insufficient_history` below two rows, no forecast/pace/verdict); they NEVER read D1 for anything live and the live tools NEVER read the archive. Stage 6: `get_war_brief` is pure assembly of facts the other tools return (never a recommendation/ranking); `resolve_planet` and the shared name resolution never silently substitute a planet — near-misses surface ranked candidates. Stage 8: `get_major_order_history` is read-only observed data — no forecast, required pace, or on-track verdict, ever. Stage 10: the `/raw` fetches ride `fetchUpstream` (same headers/cache/stale-fallback — never a parallel fetch stack) via best-effort `tryFetchRaw`; a `/raw` failure degrades `cross_check` to a reasoned null, never blocks the primary response, and adds ZERO sample-store writes. |
| `provenance.ts` | The ONE provenance contract: `PlanetProvenance` / `CampaignProvenance` enums, the `anyDegraded` (rollup) + `allFresh` (persist gate) predicates, `provenanceReasons`, and the tri-state `campaignView` accessor (`status`/`hasActiveCampaign`/`moMembership`) | **Pure. Zero I/O.** The SINGLE place degradation is represented. Loaders report through the enums; every tool/writer/builder consumes the predicates + accessor — NO raw `source === 'live'` or campaign-map `.has()` anywhere else (predicate-audit test enforces). `unavailable` ⇒ every accessor query is `unknown`/`null`, so absence is never silently `false`. |
| `mcp.ts` | JSON-RPC 2.0 protocol | No domain logic. Domain errors become `isError` tool results, never raw exceptions. |
| `types.ts` | Raw upstream + normalized types | Types only. |
| `index.ts` | Entry/routing + cron entry | POST `/` or `/mcp` only; the `scheduled` handler (Cron Trigger, always UTC) delegates to `runScheduledSample` in tools.ts — the request path's own loader and store write, never a fork; failures are swallowed (no user watches a cron tick). |

## The five invariants (do not weaken)

1. **Defense decay is cosmetic → force-null** (`nullifyDefenseDecay`), even
   when upstream sends a real-looking `regenPerSecond`.
2. **Liberation % is NOT raw HP** — exists only as
   `liberation_pct_display_only`; never used in any math.
3. **Projections = `raw_hp / abs(hp_per_hour)`** (`projectResolution`), never
   from % progress. `hp_per_hour === 0` → `status: "stalemate"`, null hours —
   never divide by zero. Missing HP → `data_error`, never substitute 0.
4. **Ramp-up stabilization**: campaigns younger than `RAMP_UP_THRESHOLD_MS`
   (1h) get `stabilizing: true` and suppressed alerts. Unknown age = young
   (fail-safe).
5. **HPC decay is intentionally deceptive**: HPCs never emit collapse alerts.
   HPC = `HPC_CAMPAIGN_TYPES.has(type) || moPlanetIndices.has(planetIndex)`.
   When in doubt, classify AS HPC — over-inclusion is fail-safe.

Invariant order in `normalizeCampaign`: data-quality gate → direction/alert →
invariant 4 → invariant 5 → projection.

## hp_per_hour sign convention (single source of truth)

Defined ONCE in the comment block above `samplePlanetRates` in `client.ts`.
Health counts DOWN toward resolution:

- `hp_per_hour = (previous.health − current.health) / hoursElapsed`
- positive → health depleting → progressing; negative → health rising → losing

One signed value, consumed in exactly two places: `projectResolution` takes
its **magnitude** (`abs`, deliberately sign-blind) and `directionFromRate`
takes its **sign** — `direction` is the SOLE carrier of progressing-vs-losing.
Never derive direction from a second, independently computed quantity, and
never let the convention drift between liberation and defense campaigns
(defense samples `event.health`, same formula — verified live 2026-06-11:
event health DEPLETES toward zero while a defense is being won).

Stage 7: the positive-rate LABEL is kind-aware — `liberating` on a
liberation, `repelling` on a defense (sign semantics identical; the word
changed because "liberating" on a high-HP defense misread as nearly-won).
Every campaign also states the orientation outright: `win_condition`
(`raw_hp_to_zero`, both kinds) + `hp_remaining_to_objective` (= raw_hp,
smaller = closer), and the convention is restated inline on every
rate-bearing payload via the `RATE_SIGN_NOTE`/`DIRECTION_NOTE` constants.
Defense campaigns add `projected_hp_at_defense_end` /
`resolution_within_defense_window` (`defenseWindowProjection`) — comparisons
of co-located numbers from the SAME signed rate, never success predictions,
both null without a rate.

## Stage 9 ETA rules (projections under transparency, never a pick)

ETAs are the ONE permitted class of derived number, and only as a dual:
`eta_instantaneous_hours` (distance ÷ |current rate| — reactive, noisy) and
`eta_historical_hours` (distance ÷ |trend rate|, the unweighted mean of the
per-interval observed rates — stable, lags a regime change), both presented
with their assumptions; the server NEVER picks one, predicts success/failure,
or says on-track/behind. Reuse rules: distance = the Stage 7 orientation
(`hp_remaining_to_objective`; `target − progress` for MO objectives); the
campaign instantaneous rate IS the sampled `hp_per_hour` (liberation
`eta_instantaneous_hours` equals `hours_to_resolution` exactly — pinned);
historical rates come from `perIntervalRates` (the get_planet_history
derivation, extracted — never a parallel path) over the series the existing
single KV read already supplies (`SampleOutput.samples`), or from the Stage 8
MO series via `moIntervalRates` (latest delta = instantaneous). ETAs take the
rate's MAGNITUDE (invariant-3 convention); the signed rate rides alongside.
`rate_divergence` (abs/pct/`diverging` ≥ 50%) and `rate_stability` (max −
min) are documented as arithmetic/observed spread — never confidence or
regime verdicts. Defenses carry COMPETING clocks (`depletion_eta_*` vs the
deadline, the window comparison evaluated against each rate, labeled) and no
success/fail field, key-name pinned. Every null ETA carries a machine-
readable `reason` (`no_current_rate` / `insufficient_history` / `stalemate` /
`unknown_distance`); rate 0 is a stalemate reason, never a divide-by-zero or
Infinity. `get_major_order` gained one read-only KV read for the series;
write budget unchanged everywhere.

## Stage 4 source-separation rule (live vs lore)

Live tools answer WHAT IS HAPPENING (verifiable against the upstream war
API); `get_planet_wiki` answers WHAT IT MEANS (community lore from
helldivers.wiki.gg, CC BY-NC-SA 4.0, attribution mandatory on every payload
including not-found). The pipelines never touch: live tools must not call
the wiki or embed wiki prose; the wiki payload must not carry HP, rates, or
ownership. The event/modifier decode (`decodeEventModifier`) is LIVE-side
only: raw `event.eventType` passed through + a name ONLY when confirmed in
`EVENT_MODIFIER_NAMES` (ships EMPTY — upstream documents no enum and no
live event existed to verify against; a wrong entry would fabricate a name,
so unlike HPC_CAMPAIGN_TYPES the fail-safe here is to seed NOTHING).
Unknown value → `event_type` set, `modifier: null` — visible, never named.

## Caching rule

KV (`WAR_CACHE`) stores **RAW** upstream responses; normalization always runs
AFTER the cache read, so invariant changes never require cache invalidation.
Rate samples only update when ≥60s apart (`MIN_SAMPLE_INTERVAL_MS`) — closer
reads reuse `lastRate` so cached health doesn't collapse the rate to a bogus 0.
On upstream 429/5xx/timeout: serve the stale KV copy with `stale: true`, else
throw `UpstreamError` (which `mcp.ts` turns into a structured tool error).

The sample store (`samples:planets`) holds a bounded per-planet ring buffer
(`sampling.ts`: max 96 points / 48h — worst case ~0.9MB, far under the 5MB KV
value limit). The rate logic reads only the TAIL of the buffer, so
`hp_per_hour` is bit-identical to the old single-sample store (regression
test in `test/stage2.test.ts`). Write budget is unchanged: one read + one
write per `samplePlanetRates` call; `get_planet_history` is read-only.
Single-planet probes pass `carryForward: true` so they don't wipe other
planets' series — the batch poll deliberately does NOT (planets leaving the
campaign set must drop and reseed a null rate, as always).

Stage 5 adds two ACCUMULATION layers inside the same store/key — observed
campaign signatures (`signatures`, capped at 500 tuples) and the global
statistics series (`global`, 96 points / 48h, sampled only when the
get_war_status path supplies `war.statistics`). Stage 11 co-samples
`impact_multiplier` (raw war-root `impactMultiplier`) and
`active_campaign_count` (campaigns-list length) into the same global point —
same gate, same write, OPTIONAL fields so pre-Stage-11 points read as null
(never backfilled, never 0); served by get_global_history with raw deltas
only — no correlation/model/prediction field relating them, ever. Both fold into the SAME
single per-cycle write (never a second put), and both ALWAYS carry forward —
`carryForward` semantics apply to planet series/campaign ages only. The
sections stay absent until they first accrue data, so pre-Stage-5 stores
round-trip unchanged. Worst case they add ~75KB to the store. The store key
carries a 30-day KV TTL refreshed on every write (planet samples still age
out in code at 48h): long enough for accumulated signatures to survive gaps
in usage, while a truly abandoned store still evaporates.
`get_observed_signatures` and `get_global_history` are read-only.

Stage 8 adds a third accumulation layer on the same rules — the Major Order
progress series (`mo`): one bounded series (96 points / 48h, the
planet/global discipline) per {major_order_id, objective_index}, sampled on
every campaign poll from the SAME assignments fetch and the SAME Stage 7
objective decode (`decodeObjectiveTarget` — never a second decode of the
positional arrays). Same single folded write, same 60s guard, always carries
forward; the section stays absent until data accrues. MO TURNOVER: a new MO
id seeds fresh series while the prior MO's series are retained (queryable by
id) until their samples age out — series not observed in a cycle get plain
age eviction and drop when emptied; points never move across series. Worst
case adds ~0.35MB (defensive 50-series cap × 96 points; in practice a few
KB) — combined store still far under the 5MB KV limit (size-tested).
`get_major_order_history` is read-only and serves observed points + raw
consecutive deltas only — no forecast, no required pace, no on-track/behind
verdict (the prime directive applied to time-series).

A Cron Trigger (wrangler.toml `[triggers]`, every 10 minutes, UTC) drives
this same path on a schedule via `runScheduledSample` (tools.ts): one
merged store write per tick through the same `samplePlanetRates` call —
the war fetch is joined so global statistics sample on every tick, and MO
progress samples on every tick too (assignments are part of the loader's
fetch set) — plus the normal raw-cache refreshes from `fetchUpstream`. The 60s
`MIN_SAMPLE_INTERVAL_MS` guard applies unchanged, overlapping cron/request
samples stay last-write-wins on the single key, and an upstream failure
during a tick is swallowed (next tick retries). The cadence-vs-KV-write-
budget rationale lives in the comment next to the cron line — re-check it
before tightening the schedule.

## Stage 12 D1 archive rule (two stores, never reconciled)

The KV ring buffer above is FROZEN — the rate formula, the ring buffer, the
ETAs, the invariants are unchanged, and KV remains the source of truth for all
live logic. Stage 12 adds D1 (`HISTORY_DB`, `src/archive.ts`) as a SECOND store
with a different job: an append-only, effectively unbounded history archive read
ONLY by the three `*_archive` tools. The two never conflict because they serve
different time ranges (KV: last ~16h, fast; D1: forever, on disk) and there is
NO reconciliation logic between them.

The write rides inside `samplePlanetRates` (client.ts) IMMEDIATELY AFTER the
existing single KV put, never altering it, and ONLY when that put actually
COMMITTED (a `kvCommitted` flag) — a failed or absent KV write means the ring
buffer did not advance, so archiving would over-sample against a store the next
poll re-reads as fresh. It archives ONLY the observations just committed to KV
as NEW this tick — the determination is reused (a committed sample's newest
timestamp equals the tick clock), never recomputed — so the SAME 60s
`MIN_SAMPLE_INTERVAL_MS` that gates the KV write gates the D1 write: a within-60s
replay commits nothing and archives nothing.

The no-duplicate guarantee survives CONCURRENT overlapping polls (a cron tick +
a request poll racing after the 60s interval) too, where the in-memory guard
alone cannot help — both invocations read the same old KV store before either
put lands, so both build rows. The atomic backstop is a `tick_anchor` on every
append-only row + a UNIQUE index: the anchor is the PREDECESSOR KV sample's
timestamp (which both racers share, having read the same old tail), so the
second `INSERT OR IGNORE` no-ops at the DB level. Seeds (no predecessor) anchor
on a negative 60s bucket of the clock (disjoint from positive predecessor
timestamps; `tickAnchor()` in client.ts). Legit consecutive samples follow
DIFFERENT predecessors → distinct anchors → never collapsed.

All of a tick's rows (planet/global/MO + the signature UPSERT) go out in ONE
`db.batch` (never a per-row await loop), wrapped in `archiveSampleTick`'s own
try/catch that logs and swallows — D1 being briefly unavailable degrades to "we
missed archiving this tick", NEVER a broken KV write or response. Parameterized
SQL ONLY (every value via `.bind()`). Reads ORDER BY `sampled_at DESC` + LIMIT
then re-sort ascending, so a capped window returns the NEWEST rows (never the
oldest) — important because the default 168h window already holds ~1008 cron
samples. The pure row→point delta builders
(`buildPlanetArchivePoints` / `buildGlobalArchivePoints` / `buildMoArchiveSeries`)
live in enrichment.ts and reuse the existing history-delta derivations, so the
archive view is verifiable against the live history view. Same prime directive:
observed points + raw deltas, `insufficient_history` below two rows, NO forecast,
required pace, or trend verdict. The archive does not store `task_type`, so MO
`objective_kind` is null there (the KV history tool carries it). Deploy has a
DATABASE-SETUP PREREQUISITE: `wrangler d1 create` + paste id + `migrations apply
--remote` BEFORE `wrangler deploy` (see README) — if the archive tools error
while KV tools work, the remote migration was not applied.

## Stage 6 consumption rules

- **Freshness metadata** (`as_of` / `fetched_at` / `cache_age_seconds`) rides
  every upstream-derived response, computed from the cache record's stored
  `fetchedAt` (oldest contributing endpoint when several are joined). The two
  timestamps coincide by construction — upstream serves live state at fetch
  time and its own war `now` is game-epoch (unusable) — but stay separate
  fields with documented, different meanings. Pure metadata, never a verdict.
- **`get_war_brief` is assembly, not conclusion**: it reuses the SAME
  normalized campaigns, MO shaping, Stage-3 rate aggregate, and Stage-5
  faction rollup the individual tools return. Its fetch set (planets,
  campaigns, assignments, war — shared 45s cache) and its single sample-store
  write are exactly a `get_war_status` poll's; never more.
- **Campaign filters** run AFTER normalization and only narrow the returned
  array — invariants always run over the full list; `filtered_count` vs
  `total_count` keeps coverage legible. No args = unfiltered (compat).
- **Name resolution** (`resolvePlanetName`): exact / normalized-exact matches
  resolve; fuzzy near-misses and ties return ranked candidates and NEVER
  auto-substitute. Output names keep verbatim upstream casing.
