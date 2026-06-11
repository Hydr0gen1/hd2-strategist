# src/ — Worker source

Module boundaries are strict; respect them when editing:

| File | Role | Boundary rule |
|------|------|---------------|
| `invariants.ts` | The five domain invariants + `normalizeCampaign` | **Pure. Zero I/O, zero imports from client/tools/mcp.** External facts (rates, ages, MO planet set) arrive via `NormalizeContext`. |
| `enrichment.ts` | Stage 1+2+4+5+6 fact pass-throughs: planet statistics subset, defense deadline timing, biome/hazards, dispatch/patch-note shaping, history deltas, live event/modifier decode (`EVENT_MODIFIER_NAMES`), Stage 5 joins/aggregates (waypoint neighbors, MO assignment map, history rate aggregates, global history points, signature shaping, faction/sector rollups), Stage 6 consumption helpers (MO shaping, freshness metadata, planet-name resolution, campaign filters, brief target/event assembly) | **Pure. Zero I/O.** Raw objects and the clock arrive from the handler layer. Facts and unit conversions only — never a judgment. |
| `wiki.ts` | Stage 4 LORE source, pure half: wiki query plan (title candidates, one multi-title request), response shaping, extract cap, mandatory attribution | **Pure. Zero I/O. SEPARATE source** — never imports from or feeds into the live war-state pipeline; no live war number in any output. |
| `wikiClient.ts` | Stage 4 LORE source, I/O half: helldivers.wiki.gg fetch (descriptive User-Agent) + long-TTL KV cache in the `wiki:` namespace with stale fallback | Deliberately separate from `client.ts`. Injectable fetch for tests. Never touches `raw:`/`samples:` keys. |
| `sampling.ts` | Pure sample-store logic: the bounded planet ring buffer (`advancePlanetSeries`), legacy-shape coercion, eviction, retention constants, and the Stage 5 accumulation layers (`foldSignatures`, `advanceGlobalSeries`) | **Pure. Zero I/O.** The store travels in/out via client.ts. Implements the rate formula verbatim; the sign convention is DEFINED in client.ts. |
| `client.ts` | Upstream fetch + KV cache + rate sampling | Owns the `hp_per_hour` sign convention (comment block) and all KV access. |
| `tools.ts` | The twelve tool implementations | Orchestration only: fetch → assemble context → call pure normalization/shaping. Stage 6: `get_war_brief` is pure assembly of facts the other tools return (never a recommendation/ranking); `resolve_planet` and the shared name resolution never silently substitute a planet — near-misses surface ranked candidates. |
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
takes its **sign** — `direction` is the SOLE carrier of liberating-vs-losing.
Never derive direction from a second, independently computed quantity, and
never let the convention drift between liberation and defense campaigns
(defense samples `event.health`, same formula).

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

A Cron Trigger (wrangler.toml `[triggers]`, every 2 minutes, UTC) drives
this same path on a schedule via `runScheduledSample` (tools.ts): one
merged store write per tick through the same `samplePlanetRates` call —
the war fetch is joined so global statistics sample on every tick — plus
the normal raw-cache refreshes from `fetchUpstream`. The 60s
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
