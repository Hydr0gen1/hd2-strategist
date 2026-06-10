# Strategist — Development Roadmap

A planning document for the Helldivers 2 Galactic War MCP server (`Hydr0gen1/hd2-strategist`). This is the source of truth for what we build next and the rules we build by. It is not a changelog.

-----

## Prime directive

**The server ENRICHES facts; it never CONCLUDES.**

Every field the server returns must be either (a) directly verifiable against the raw upstream API, or (b) a trivial, deterministic derivation of it — a join, a count, a sum, a unit conversion, a sort. The server must never return an interpretive or strategic judgment: no recommended targets, no priority rankings, no routing/reachability verdicts, no “front collapsing” conclusions, no graph algorithms that encode an assumption about player intent.

The test for any proposed field: *Could the player verify it against the raw API, or is it a mechanical derivation with no hidden choice?* If answering requires an assumption about what the player **should** do, or what a loaded word like “reachable” or “winning” **means**, it is a conclusion — it stays out of the server and lives in the conversation layer, where the reasoning is visible and arguable.

This is the five invariants generalized. The whole reason this server exists is to hand over correct, auditable data; an authoritative-looking field that hides a judgment is the exact failure mode we built it to prevent.

-----

## The five invariants (permanent, never weakened)

These are load-bearing and must survive every future change unchanged in spirit and ordering:

1. **Defense decay is cosmetic** — force-null it, even when upstream sends a real-looking value.
1. **Liberation % is not raw HP** — keep it isolated as `liberation_pct_display_only`; all math uses `raw_hp`.
1. **Projections derive from raw HP ÷ |HP-per-hour|** — never from liberation %; guard divide-by-zero explicitly.
1. **Ramp-up stabilization** — campaigns younger than the threshold report `stabilizing: true`, never a false collapse signal. Unknown age is treated as young (fail-safe).
1. **High Priority Campaign decay is intentionally deceptive** — never flag an HPC as failing. When in doubt, classify AS HPC (over-inclusion is fail-safe).

Invariant ordering in normalization (`1 → 2 → rate/direction → 4 → 5 → 3`) is deliberate and must not be reshuffled: direction is computed, *then* suppression runs, *then* projection.

-----

## Architecture principles

- **Stay headless.** No frontend, no UI. The conversation layer (Claude) is the only frontend.
- **Pure normalization/enrichment.** All domain logic lives in pure, I/O-free functions (`invariants.ts`, `connectivity.ts`) that receive everything via context. Handlers (`tools.ts`) do the fetching and assembly. This keeps logic unit-testable without a Workers runtime.
- **Cache raw, normalize after.** KV stores raw upstream responses; normalization always runs post-cache so logic changes never require cache invalidation.
- **Fail safe, never crash.** Upstream errors become structured MCP tool errors with stale-cache fallback — never a thrown exception out of the Worker.
- **Free-tier discipline.** Single Worker + KV. Keep payloads lean and CPU work to plain object transforms (10ms budget). No D1, no Docker, no Durable Objects unless a feature genuinely demands it (and then it gets its own design review).
- **Secrets external.** Header values and credentials via `wrangler secret` / `.dev.vars` (gitignored) — never in the repo.
- **Display formatting is the consumer’s job.** The server returns names exactly as upstream sends them (all-caps). Title-casing and presentation happen in the conversation layer.

-----

## Current capabilities (shipped)

- `get_war_status` — fronts by faction, planet counts, global stats.
- `get_campaigns` — invariant-normalized campaigns with trajectory flags + enriched connectivity.
- `get_major_order` — objectives, progress, rewards, time remaining.
- `get_planet` — single-planet deep dive incl. connectivity.
- `get_supply_lines` — whole-galaxy connectivity graph, sector-grouped, neighbor-joined.
- Cross-cutting: KV raw-cache + stale fallback, KV health-sampling for signed `hp_per_hour`, the five invariants, enriched waypoints (name/owner/campaign-joined).
- Stage 4 — live event identity: `event_type` (raw upstream `event.eventType`, passed through) + `modifier` (decoded special-faction name, only for enum values confirmed in `EVENT_MODIFIER_NAMES`) on `get_planet` and every campaign in `get_campaigns`. Presence + name only — no difficulty/threat interpretation.
- Stage 4 — `get_planet_wiki`: community lore from helldivers.wiki.gg (MediaWiki `prop=extracts`, root `/api.php`), a physically separate source with mandatory attribution (CC BY-NC-SA 4.0 per the wiki's own rightsinfo), long-TTL `wiki:` KV cache with stale fallback. Live tools say *what is happening*; the wiki says *what it means*; the two are joined only in the conversation layer.

-----

## Roadmap

Tiers are ordered by cost/risk, not necessarily by priority. Within the prime directive, everything here is enrichment or new fact-sourcing.

### Tier 1 — surface data already in fetched payloads (cheap, safe, do first)

- [x] **Per-planet `statistics`** — player count, mission win/loss, kills per planet. Exposes where the playerbase actually is vs. where HP is moving.
- [x] **Defense `endTime` + `hours_remaining`** — the hard deadline on a defense campaign. The single most decision-relevant fact when a defense is live. (Currently unexercised — no live defenses — so verify against real data when one appears.)
- [x] **Biome + environmental hazard per planet** — factual, feeds loadout reasoning (cold/atmospheric hazards).

### Tier 2 — new upstream endpoints

- [x] **`/api/v1/dispatches`** — in-fiction news feed; narrative context for why an MO exists. (`get_dispatches`, newest-first, capped limit.)
- [x] **Steam news / patch-notes endpoint (if exposed)** — the hook for “did a balance patch land,” which affects weapon-stat analysis. (Upstream `/api/v1/steam` verified live; `get_patch_notes` returns verbatim BBCode `content` — no server-side summary.)
- [x] **`get_planet_history`** *(highest-value single addition)* — expose the time-series our KV sampler is already collecting. Turns the sampler into a genuine trajectory source no other HD2 tool has: trend over time, not just current state. (Bounded ring buffer in `sampling.ts`: 96 points / 48h per planet, ~0.9MB worst case « 5MB KV limit; `hp_per_hour` preserved bit-identically — regression-tested; write budget unchanged.)

### Tier 3 — deterministic derivations (on the right side of the line)

- [x] **Per-front aggregated `hp_per_hour`** — sum of net rates across a faction’s planets. A sum, not a verdict; gives the *inputs* to reason about a front’s trajectory without the server concluding. (`get_war_status` fronts: `net_hp_per_hour` + `planets_with_rate`/`planets_total` coverage counts. Sums the SAME signed per-campaign rates — never recomputed; null rates are excluded, never coerced to 0; a front with no known rates reports null, not a fake 0.)
- [x] **`decay_per_hour`** — `regenPerSecond × 3600`, so regen reads in the same units as the rate. Pure unit conversion. (On `get_campaigns` and `get_planet`. Derived from the invariant-1 normalized `regen_per_second`, so defense campaigns stay null — the conversion cannot resurrect suppressed cosmetic decay; regression-tested in `test/stage3.test.ts`.)

### Explicitly OUT of scope (do not build server-side, ever)

- Recommended MO target, liberation-ETA ranking, “should I play here,” threat scores.
- Shortest-path / reachability / “attackable from here” verdicts.
- Any field whose value depends on an assumption about player intent or the meaning of a loaded term.
- Name case-conversion or other display formatting.
- These are not “later” items — they belong in the conversation layer permanently.

-----

## Known open items / watch list

- **`campaign_type` enum is unverified.** Live data shows every active campaign is `type: 0`; HPC detection currently rides entirely on the Major-Order link. The `HPC_CAMPAIGN_TYPES = {1,2,3}` seed has had zero live coverage. **Action:** log distinct `(type, hasEvent)` pairs over time and confirm what non-zero types actually mean before trusting the type half of HPC detection.
- **`event.eventType` enum is unverified — `EVENT_MODIFIER_NAMES` ships EMPTY.** At Stage 4 implementation time the war had zero active events and upstream documents no enum (its spec says only "the type of event"), so no (value → name) pair could be confirmed. Unlike `HPC_CAMPAIGN_TYPES` (where over-inclusion is fail-safe), a wrong entry here fabricates a subfaction name, so nothing was seeded. **Action:** when a special-faction event (Jet Brigade, Predator Strain, Incineration Corps, The Great Host, …) goes live, capture its `eventType`, seed the map, and update the pinned stage4 test. Caution: eventType 1 has historically been the plain defense event — do not map it to a subfaction.
- **Invariant 1 (defense-null) unexercised live.** No defense campaigns have appeared since launch; the path is unit-tested only. Re-verify against real data when a defense goes active.
- **Defense timing (Stage 1) unexercised live.** Same gap: `defense_hours_remaining` / `defense_expired` are unit-tested against the documented `event` shape only. Verify against real data when a defense goes active.
- **Upstream `war.now` is game-epoch time** (observed `1972-04-26T…`), NOT comparable to the real-world ISO timestamps in `event.startTime`/`endTime` or MO `expiration`. All deadline math (MO `expires_in`, defense timing) therefore uses the Worker clock against those real-world timestamps.
- **Impact multiplier is very low** (~0.024 observed). Not a bug, but worth remembering when interpreting why heavily-populated planets stall.
- **Connector tool-list refresh.** Adding a tool requires the MCP client to re-discover `tools/list`; budget a connector toggle after any deploy that changes the tool set.

-----

## Definition of done (applies to every feature)

1. `npm run typecheck` clean.
1. `npm test` green, including new tests for the feature’s edge cases.
1. New tools appear in `tools/list`; live `wrangler dev` call returns expected shape against real upstream.
1. All prior tool outputs unchanged except for explicitly additive fields.
1. No interpretive/strategic field introduced anywhere in server output.
1. Pushed to a working branch; deploy is a separate, deliberate step.

-----

## Working method

- Exhaustive spec up front → Fabel implements → review against this roadmap + the prime directive → fix prompt if needed → deploy.
- Each new capability gets its own scoped prompt with explicit “do not touch” constraints, so existing invariants and tools never drift.
- This roadmap is updated when priorities change or an item ships — it leads development; it does not trail it.