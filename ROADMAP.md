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
- **Pure normalization/enrichment.** All domain logic lives in pure, I/O-free functions (`invariants.ts`, `enrichment.ts`, `sampling.ts`) that receive everything via context. Handlers (`tools.ts`) do the fetching and assembly. This keeps logic unit-testable without a Workers runtime.
- **Cache raw, normalize after.** KV stores raw upstream responses; normalization always runs post-cache so logic changes never require cache invalidation.
- **Fail safe, never crash.** Upstream errors become structured MCP tool errors with stale-cache fallback — never a thrown exception out of the Worker.
- **Free-tier discipline.** Single Worker + KV. Keep payloads lean and CPU work to plain object transforms (10ms budget). No D1, no Docker, no Durable Objects unless a feature genuinely demands it (and then it gets its own design review).
- **Secrets external.** Header values and credentials via `wrangler secret` / `.dev.vars` (gitignored) — never in the repo.
- **Display formatting is the consumer’s job.** The server returns names exactly as upstream sends them (all-caps). Title-casing and presentation happen in the conversation layer.

-----

## Current capabilities (shipped)

- `get_war_status` — fronts by faction, planet counts, global stats, and (Stage 5) deterministic faction/sector rollups.
- `get_campaigns` — invariant-normalized campaigns with trajectory flags and (Stage 5) Major Order membership joins (`is_major_order_target` / `major_order_id`).
- `get_major_order` — objectives, progress, rewards, time remaining.
- `get_planet` — single-planet deep dive incl. (Stage 5) waypoint neighbor context: enriched `neighbors` (name/owner/campaign-joined), `neighbor_summary` counts, and the `frontline` adjacency fact. (This supersedes the earlier `get_supply_lines` whole-galaxy graph idea — the scoped-down neighbor join ships the verifiable part without graph construction; no separate supply-lines tool exists.)
- Cross-cutting: KV raw-cache + stale fallback, KV health-sampling for signed `hp_per_hour`, the five invariants.
- Stage 4 — live event identity: `event_type` (raw upstream `event.eventType`, passed through) + `modifier` (decoded special-faction name, only for enum values confirmed in `EVENT_MODIFIER_NAMES`) on `get_planet` and every campaign in `get_campaigns`. Presence + name only — no difficulty/threat interpretation.
- Stage 4 — `get_planet_wiki`: community lore from helldivers.wiki.gg (MediaWiki `prop=extracts`, root `/api.php`), a physically separate source with mandatory attribution (CC BY-NC-SA 4.0 per the wiki's own rightsinfo), long-TTL `wiki:` KV cache with stale fallback. Live tools say *what is happening*; the wiki says *what it means*; the two are joined only in the conversation layer.
- Stage 5 — accumulation layer, joins, and rollups (Parts A–F):
  - **A. Passive signature accumulation** — every distinct `{campaign_type, event_type, has_event, faction}` tuple observed while polling is folded into the existing sample-store write (never a second per-cycle KV put; capped at 500 tuples; `sample_count` deduplicated at the 60s sampler interval). Inspectable via the read-only `get_observed_signatures` tool, newest `last_seen` first. This is the instrumentation for the `campaign_type`/`eventType` watch-list items below.
  - **B. Neighbor context on `get_planet`** — `neighbors` (upstream waypoints joined by index against the full planets list + campaign set), `neighbor_summary` counts (incl. an `unknown` bucket for dangling indices), and `frontline`: a factual adjacency flag ("borders territory of a different owner"), nothing more.
  - **C. History aggregates** — `get_planet_history` adds `rate_min`/`rate_max`/`rate_mean`/`latest_rate` (plain stats over per-interval observed rates, hp_per_hour sign convention) + `samples_span_hours`. No trend labels, no smoothing, no projection from history.
  - **D. Major Order joins** — `is_major_order_target` + `major_order_id` on each campaign: a pure membership join against the same MO planet map invariant 5 consumes (first assignment wins on collision). No priority scoring.
  - **E. Global statistics history** — a lean subset of `war.statistics` sampled into a bounded ring buffer (96 points / 48h) inside the same single store write, accruing on `get_war_status` polls; served with raw observed deltas by the read-only `get_global_history` tool.
  - **F. Faction & sector rollups on `get_war_status`** — per-faction `{planets_owned, active_campaigns, net_hp_per_hour (the Stage 3 aggregate echoed verbatim — never recomputed), total_players_on_front (+ coverage counts)}` and per-sector `{planet_count, owners, active_campaigns}`. Deterministic counts/sums only; null-coverage honesty as in Stage 3.
  - Cross-cutting: KV write budget unchanged (one read + one write per poll cycle — A and E fold into the existing write); the combined store key worst case is ~1.0 MB (planets ~0.9 MB + signatures ~60 KB + global ~15 KB), far under the 5 MB KV value limit (size-tested); the store key TTL was raised 24h → 30 days so accumulated observations survive gaps in usage (planet-sample eviction is age-based in code and unchanged). Tool count is now ten — remember the connector tool-list refresh after deploy (see watch list).

- Stage 6 — consumption ergonomics (Parts A–F): assembly, filtering, resolution, and metadata over facts already available — no new upstream data, nothing interpretive:
  - **A. `get_war_brief`** — single-call digest: the current MO joined with the live trajectory of exactly its target planets (echoed from the campaign normalizer; a target with no active campaign is included with static state, never dropped), per-faction front rollups (the Stage 5 rollup + Stage 3 aggregate reused verbatim), active events (empty array when none), and totals. Pure assembly — every field verifiable against the three tools it pre-joins; no recommendation, ranking, or verdict, by design and by test. Fetch set and the single sample-store write are exactly a `get_war_status` poll's (shared 45s raw cache).
  - **B. `get_campaigns` filters** — optional `faction` / `major_order_only` / `has_rate` / `hpc_only`, AND-combined, applied AFTER normalization (invariants always run over the full list); `filtered_count` vs `total_count` keeps coverage legible; no args → unchanged full output.
  - **C. `resolve_planet` + shared name resolution** — exact case-insensitive, then punctuation/space-normalized, then fuzzy (edit distance ≤ 2 or ≥3-char prefix). Only exact/normalized matches resolve; near-misses and ties return ranked candidates (`score` = edit distance) with `matched: false` — never a silent substitution. Wired into `get_planet` / `get_planet_history` name handling: a near-miss error now lists the candidates. Canonical upstream casing throughout.
  - **D+E. Freshness metadata** — `as_of`, `fetched_at`, `cache_age_seconds` on every upstream-derived response, computed from the cache record's stored retrieval timestamp (oldest contributing endpoint governs). `as_of` (when the snapshot is FROM) and `fetched_at` (when WE retrieved it) coincide by construction — upstream serves live state at request time and its own war `now` is game-epoch (see watch list), so the upstream timestamp the spec imagined does not exist; the deviation is documented on every payload via the shared freshness note. `stale: true` still marks expired-cache fallback.
  - **F. Unit consistency** — additive aliases only, nothing renamed: defense campaigns now carry `defense_seconds_remaining` + humanized `defense_time_remaining` alongside the untouched `defense_hours_remaining` (matching the MO `expires_in_seconds`/`expires_in` pair); a `units` note on `get_campaigns` states the conventions (*_per_hour, regen_per_second, *_seconds, *_hours, humanized strings always paired with a raw field).
  - Tool count is now twelve (`get_war_brief`, `resolve_planet` added) — connector toggle required after deploy.
- Stage 7 — defense facts made un-misreadable (Parts A–D): additive framing, derivations, and inline documentation that remove the cross-referencing a reader previously had to do by hand — nothing interpretive, no new tools. Motivated by a live near-miss: a defense at 97% event HP with a positive rate and `direction: "liberating"` read as "almost won" when it was almost lost.
  - **A. Objective-relative framing** — `win_condition` and `hp_remaining_to_objective` on every campaign (`get_campaigns`, `get_planet`). Orientation VERIFIED live (2026-06-11, Crimsica/Bore Rock — the type:0 lesson applied): a successful defense DEPLETES event health toward zero, so both kinds share `win_condition: "raw_hp_to_zero"` and the distance to the win state is always raw_hp, smaller = closer. The `direction` label is now kind-aware — positive rate reads `repelling` on a defense (previously `liberating`, the misread); negative stays `losing`, liberation labels and all sign semantics unchanged (regression-tested). The hp_per_hour sign convention is restated inline on every rate-bearing payload (`RATE_SIGN_NOTE` et al. — matching the history-tool notes that made the correct live read possible).
  - **B. Defense window gap as numbers** — on defense campaigns: `projected_hp_at_defense_end` (raw_hp − hp_per_hour × defense_hours_remaining; unclamped linear extrapolation of the one signed rate, ≤ 0 = reaches the win state inside the window) and `resolution_within_defense_window` (`hours_to_resolution ≤ defense_hours_remaining` — a deterministic comparison of two co-located fields, documented as exactly that, never a success/failure prediction). Both null without a rate — the existing projection honesty.
  - **C. Liberation-% formula inline** — `liberation_pct_display_only = (max_hp − raw_hp) / max_hp × 100` plus the raw_hp-is-authoritative statement, in the notes of every payload carrying the field. Documentation only; the value is untouched and still never used in math (invariant 2 stands).
  - **D. Major Order objective decode** — each objective carries `target` (the valueType-3 goal quantity), `progress_pct` (progress / target × 100, divide-by-zero → null), `objective_kind`, and positional `value_labels` BESIDE the untouched raw `values`/`value_types` arrays. Labels come from configurable maps (`TASK_TYPE_NAMES`, `TASK_VALUE_TYPE_NAMES`) seeded only with live-confirmed values (task 9 = complete_operations, 13 = hold_planet; valueType 3 = goal, 12 = planet_index — both MOs live 2026-06-11); an unknown enum keeps its raw number with a null label (the EVENT_MODIFIER_NAMES fail-safe: never fabricate a name).
- Stage 8 — Major Order progress history: the third history surface, completing the planet/global/MO triad on identical consumer-facing rules (observed points + raw consecutive deltas, `insufficient_history` honesty, no forecast).
  - **Sampling** — `advanceMoSeries` (sampling.ts): one bounded series (96 points / 48h — the planet/global ring-buffer discipline, 60s minimum interval) per `{major_order_id, objective_index}`, observed on every campaign poll from the SAME assignments fetch the loader already makes, folded into the SAME single `samples:planets` write (`mo` section, absent until data accrues — pre-Stage-8 stores round-trip unchanged). Each point is `{t, progress, target}` where progress/target are the Stage 7 objective decode reused verbatim (`decodeObjectiveTarget` / `objectiveProgressPct` extracted from `shapeMajorOrders` — one decode, parity-tested). The cron tick advances it automatically (assignments are in the loader's fetch set); write budget unchanged.
  - **MO turnover** — a new MO id seeds fresh series; the prior MO's series stop accruing but are RETAINED as historical record (queryable by id) until their samples age out (plain 48h eviction for unobserved series; an emptied series drops). Points never move across series — no cross-contamination, regression-tested.
  - **`get_major_order_history`** — read-only (one assignments fetch for the active MO ids + one KV read, zero writes). Optional `{major_order_id, objective_index}`; no args → every series of the active MO(s). Per series: `objective_kind` (Stage 7 label map, decoded at read time so later-confirmed labels apply retroactively), samples with `delta_progress`/`delta_hours` (observed differences, null-propagating, resets pass through), `latest_progress`/`target`/`progress_pct` (divide-by-zero → null), `samples_span_hours`, `insufficient_history` when < 2 points. No active MO → flagged empty result, never an error. NO forecast, completion estimate, required pace, or on-track/behind verdict anywhere (key-name pinned) — pace interpretation lives in the conversation layer, grounded on these points.
  - Worst case the `mo` section adds ~0.35 MB (defensive 50-series cap; a few KB in practice) — combined store still far under the 5 MB KV limit, size-tested. Tool count became thirteen here — connector toggle required after deploy.
- Stage 9 — dual ETAs (instantaneous + historical) with divergence: the one class of derived number this project permits — a projection — formalized under strict transparency rules. Every campaign (`get_campaigns`, `get_planet`) and every Major Order objective (`get_major_order`, `get_major_order_history`) carries an additive `eta` block presenting BOTH projections with their assumptions; the server never picks one, never predicts success/failure, never says on-track/behind.
  - **The dual model** — `eta_instantaneous_hours` = distance ÷ |current rate| (reacts immediately to a rate regime change — a city falling, players redeploying — but noisy) and `eta_historical_hours` = distance ÷ |trend rate| (the unweighted mean of per-interval observed rates over the retained history window — stable, but LAGS after a regime change). Neither is universally better; `rate_divergence` (`abs_diff`, symmetric `pct_diff`, `diverging` past a documented 50% threshold) states by how much the two rates disagree — arithmetic only, the regime-change inference is the consumer's. `rate_stability` (max − min of the interval rates) is observed spread, not a confidence score.
  - **One source of truth throughout** — distance is the Stage 7 orientation (`hp_remaining_to_objective` for campaigns; `target − progress` for MO objectives, clamped ≥ 0); the instantaneous campaign rate IS the sampled signed `hp_per_hour` (so liberation `eta_instantaneous_hours` equals `hours_to_resolution` exactly — test-pinned); the historical rates are `perIntervalRates` — the same derivation `get_planet_history`'s aggregates use, extracted so it cannot fork; MO rates come from the Stage 8 series (`moIntervalRates`, latest delta = instantaneous, mean = historical). ETAs use the rate's magnitude (the invariant-3 convention); the signed rate rides alongside and `direction` stays the sole sign carrier.
  - **Defenses get competing clocks, never a prediction** — `depletion_eta_instantaneous_hours` / `depletion_eta_historical_hours` vs the echoed `defense_hours_remaining` deadline, with the Stage 7 window comparison evaluated against EACH rate (`resolution_within_defense_window_instantaneous` / `_historical`, labeled). The race is the information; no success/failure field exists (key-name pinned).
  - **Thin-history honesty** — every null ETA carries a machine-readable `reason`: `no_current_rate` (cold start / <2 samples), `insufficient_history` (the existing <2-points threshold), `stalemate` (rate exactly 0 — never divide-by-zero, never Infinity), `unknown_distance` (missing HP/progress/target — never substituted with 0). `rate_divergence` is null when either rate is null.
  - **Budget unchanged** — the campaign path reads the series from the SAME single KV read `samplePlanetRates` already performs (its output now exposes the retained samples); `get_major_order` adds one read-only KV read (the `get_major_order_history` discipline), zero writes. No new tools; all fields additive; `get_war_brief` is unchanged.
- Stage 10 — raw-source cross-check layer: the server's NORMALIZED fields verified against the RAW ArrowHead payloads they derive from, with disagreement surfaced as data — never resolved. Uses the SAME wrapper host's `/raw` endpoints (`/raw/api/WarSeason/801/Status`, `/raw/api/v2/Assignment/War/801` — paths, shapes, and field mappings verified live 2026-06-11; the maintainers steer consumers to `/raw` rather than the official API directly), fetched through the existing `fetchUpstream` cache/header/stale-fallback machinery — no new provider, no parallel fetch stack, ZERO additional sample-store writes.
  - **The rule** — every checked field presents `{normalized_value, raw_value, agrees, abs_diff/pct_diff}`; the server never picks a side, averages, or flags one source correct (key-name pinned: no authoritative/chosen/trusted/preferred key anywhere). The ONLY classification is `expected_transform: true` for documented invariant behavior: defense decay force-nulled (invariant 1, raw value shown beside the deliberate null) and liberation % recomputed (invariant 2) — normalization doing its job is distinguished from genuine divergence by construction, never flagged as a mismatch.
  - **Mechanics** — `agrees` is exact for discrete fields (owner via the live-verified `RAW_FACTION_NAMES` enum map 1→Humans/2→Terminids/3→Automaton/4→Illuminate, unknown values fail-safe to `agrees: null` `unconfirmed_raw_enum_value`; campaign_type joined by campaign id; event_type; player_count) and within a documented relative 1e-6 tolerance for floats (raw_hp — event health on defenses, regen). A field with no counterpart (liberation max_hp is absent from the raw status; liberation % has no raw field) → `agrees: null` + reason, never a false mismatch. Both sides' retrieval timestamps (`normalized_as_of` / `raw_as_of`) ride the block so fetch-moment skew is visible, never silently compared across time. Campaign-set membership on one side only is reported (`unmatched`), never dropped.
  - **Surfaces** — `get_planet` carries a `cross_check` block (degrades to `available: false, reason: "raw_unavailable"` on a `/raw` outage — the primary response is never blocked, the missing side never guessed); the new `get_source_crosscheck` tool summarizes faithfulness across every active campaign and MO objective: tallies (agreements / unexpected disagreements EXCLUDING expected transforms / uncheckable) plus the specific divergent fields with both values and the diff. Pure observation — the "is my normalization still faithful to upstream?" health check, no verdict on which side is right. Live verification at ship time: 41 campaigns, 330 fields, 0 unexpected disagreements, 43 expected transforms. Tool count is now fourteen — connector toggle required after deploy. (A genuinely separate second provider remains a possible Stage 11, gated on this layer proving useful.)
- Stage 11 — Galactic Impact Multiplier time-series: the global-history sampler now co-samples `impact_multiplier` (raw upstream `war.impactMultiplier`, war-payload root — verified live 2026-06-11, observed 0.031) and `active_campaign_count` (campaigns-list length) into the SAME global sample the Stage 5E write already carries — no new KV write, no cadence change, same 96-point/48h ring buffer. `get_global_history` serves both with raw consecutive deltas on the existing null-honesty rules (missing upstream → null never 0; delta null when either end is null; pre-Stage-11 points read as null, never backfilled). `get_war_status` already exposed the current `impact_multiplier`. RAW OBSERVED SERIES ONLY: no correlation, regression, predicted-multiplier, or formula field anywhere — the hypothesized multiplier-vs-population relationship is for the consumer to read off the paired curves (the prime directive applied to the hypothesis).
- Post-launch — background sampling via Cloudflare Cron Trigger: the Worker's `scheduled` handler (every 10 minutes, UTC) drives the SAME request-path sampler (`runScheduledSample` → the shared campaign loader with the war fetch joined), so the accumulation layers (planet history, global statistics, observed signatures, and — since Stage 8 — Major Order progress) advance continuously without user traffic. One merged store write per tick, the 60s interval guard intact, upstream failures swallowed; no new data, fields, or interpretation. Cadence is bound by the KV free-tier write budget — the rationale (incl. the per-tick raw-cache refreshes the budget math must count) lives next to the cron line in `wrangler.toml`; re-check it before tightening.

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

- **`campaign_type` enum — partially resolved (2026-06-10).** `get_observed_signatures` has now captured the live enum: `0` = standard liberation (all three factions observed) and `4` = defense (`event_type: 1`, `has_event: true`, observed on Terminid defenses). The guessed `HPC_CAMPAIGN_TYPES = {1,2,3}` seed never appeared live and was re-seeded EMPTY; type 4 is defense, not HPC, and is handled by the defense path. HPC detection rides entirely on the Major-Order link (its reliable signal all along); the type set remains the configurable hook for a future live-confirmed HPC type. Keep watching `get_observed_signatures` for any new type value.
- **`event.eventType` enum is unverified — `EVENT_MODIFIER_NAMES` ships EMPTY.** At Stage 4 implementation time the war had zero active events and upstream documents no enum (its spec says only "the type of event"), so no (value → name) pair could be confirmed. Unlike `HPC_CAMPAIGN_TYPES` (where over-inclusion is fail-safe), a wrong entry here fabricates a subfaction name, so nothing was seeded. **Instrumented (Stage 5):** `get_observed_signatures` captures any new `event_type` the moment it appears, with first/last seen timestamps. **Action:** when a special-faction event (Jet Brigade, Predator Strain, Incineration Corps, The Great Host, …) goes live, read its `eventType` from the signature record, confirm against the live event, seed the map, and update the pinned stage4 test. Caution: eventType 1 has historically been the plain defense event — do not map it to a subfaction.
- **Invariant 1 (defense-null) — verified live (2026-06-11).** The Crimsica/Bore Rock defenses (campaign_type 4, event_type 1) exercised the path: defense decay nulled, event health tracked, `campaign_kind: "defense"` correct. The same session verified the defense win-direction (event health depletes toward zero — Stage 7's `win_condition` rests on it).
- **Defense timing (Stage 1) — verified live (2026-06-11).** `defense_hours_remaining` / `defense_ends_at` matched the live events' real-world ISO `endTime` on both active defenses; Stage 7's window projection derives from the same values.
- **MO task/value enum maps (Stage 7) are seeded minimally.** `TASK_TYPE_NAMES` (9, 13) and `TASK_VALUE_TYPE_NAMES` (3, 12) carry only live-confirmed values; observed-but-unconfirmed values (task types 2/3/11/12 candidates; valueTypes 1/8/9/11) surface with null labels. Confirm against a live MO before seeding — same fail-safe as `EVENT_MODIFIER_NAMES`.
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