# src/ — Worker source

Module boundaries are strict; respect them when editing:

| File | Role | Boundary rule |
|------|------|---------------|
| `invariants.ts` | The five domain invariants + `normalizeCampaign` | **Pure. Zero I/O, zero imports from client/tools/mcp.** External facts (rates, ages, MO planet set) arrive via `NormalizeContext`. |
| `enrichment.ts` | Stage 1+2+4 fact pass-throughs: planet statistics subset, defense deadline timing, biome/hazards, dispatch/patch-note shaping, history deltas, live event/modifier decode (`EVENT_MODIFIER_NAMES`) | **Pure. Zero I/O.** Raw objects and the clock arrive from the handler layer. Facts and unit conversions only — never a judgment. |
| `wiki.ts` | Stage 4 LORE source, pure half: wiki query plan (title candidates, one multi-title request), response shaping, extract cap, mandatory attribution | **Pure. Zero I/O. SEPARATE source** — never imports from or feeds into the live war-state pipeline; no live war number in any output. |
| `wikiClient.ts` | Stage 4 LORE source, I/O half: helldivers.wiki.gg fetch (descriptive User-Agent) + long-TTL KV cache in the `wiki:` namespace with stale fallback | Deliberately separate from `client.ts`. Injectable fetch for tests. Never touches `raw:`/`samples:` keys. |
| `sampling.ts` | Pure planet-sample series logic: the bounded ring buffer (`advancePlanetSeries`), legacy-shape coercion, eviction, retention constants | **Pure. Zero I/O.** The store travels in/out via client.ts. Implements the rate formula verbatim; the sign convention is DEFINED in client.ts. |
| `client.ts` | Upstream fetch + KV cache + rate sampling | Owns the `hp_per_hour` sign convention (comment block) and all KV access. |
| `tools.ts` | The eight tool implementations | Orchestration only: fetch → assemble context → call pure normalization/shaping. |
| `mcp.ts` | JSON-RPC 2.0 protocol | No domain logic. Domain errors become `isError` tool results, never raw exceptions. |
| `types.ts` | Raw upstream + normalized types | Types only. |
| `index.ts` | Entry/routing | POST `/` or `/mcp` only. |

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
