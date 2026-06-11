# src/ — Worker source

Module boundaries are strict; respect them when editing:

| File | Role | Boundary rule |
|------|------|---------------|
| `invariants.ts` | The five domain invariants + `normalizeCampaign` | **Pure. Zero I/O, zero imports from client/tools/mcp.** External facts (rates, ages, MO planet set) arrive via `NormalizeContext`. |
| `enrichment.ts` | Stage 1+2+4+5+6+7 fact pass-throughs: planet statistics subset, defense deadline timing, biome/hazards, dispatch/patch-note shaping, history deltas, live event/modifier decode (`EVENT_MODIFIER_NAMES`), Stage 5 joins/aggregates (waypoint neighbors, MO assignment map, history rate aggregates, global history points, signature shaping, faction/sector rollups), Stage 6 consumption helpers (MO shaping, freshness metadata, planet-name resolution, campaign filters, brief target/event assembly), Stage 7 objective framing (`winCondition` / `hpRemainingToObjective` / `defenseWindowProjection`, the MO objective decode maps `TASK_TYPE_NAMES`/`TASK_VALUE_TYPE_NAMES`, and the inline-convention note constants), Stage 8 MO progress history (`moProgressObservations`, `buildMoHistorySeries`, the shared `decodeObjectiveTarget`/`objectiveProgressPct` decode), Stage 9 dual ETAs (`buildEtaBlock`/`buildDefenseEtaBlock`, `rateDivergence`, `perIntervalRates`/`moIntervalRates`) | **Pure. Zero I/O.** Raw objects and the clock arrive from the handler layer. Facts and unit conversions only — never a judgment. |
| `wiki.ts` | Stage 4 LORE source, pure half: wiki query plan (title candidates, one multi-title request), response shaping, extract cap, mandatory attribution | **Pure. Zero I/O. SEPARATE source** — never imports from or feeds into the live war-state pipeline; no live war number in any output. |
| `wikiClient.ts` | Stage 4 LORE source, I/O half: helldivers.wiki.gg fetch (descriptive User-Agent) + long-TTL KV cache in the `wiki:` namespace with stale fallback | Deliberately separate from `client.ts`. Injectable fetch for tests. Never touches `raw:`/`samples:` keys. |
| `sampling.ts` | Pure sample-store logic: the bounded planet ring buffer (`advancePlanetSeries`), legacy-shape coercion, eviction, retention constants, the Stage 5 accumulation layers (`foldSignatures`, `advanceGlobalSeries`), and the Stage 8 Major Order progress series (`advanceMoSeries`) | **Pure. Zero I/O.** The store travels in/out via client.ts. Implements the rate formula verbatim; the sign convention is DEFINED in client.ts. |
| `client.ts` | Upstream fetch + KV cache + rate sampling | Owns the `hp_per_hour` sign convention (comment block) and all KV access. |
| `tools.ts` | The thirteen tool implementations | Orchestration only: fetch → assemble context → call pure normalization/shaping. Stage 6: `get_war_brief` is pure assembly of facts the other tools return (never a recommendation/ranking); `resolve_planet` and the shared name resolution never silently substitute a planet — near-misses surface ranked candidates. Stage 8: `get_major_order_history` is read-only observed data — no forecast, required pace, or on-track verdict, ever. |
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
get_war_status path supplies `war.statistics`). Both fold into the SAME
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
