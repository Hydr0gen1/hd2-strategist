# hd2-strategist — "Strategist"

A headless Galactic War **MCP server** running as a single Cloudflare Worker. It sits between an MCP client (e.g. Claude) and the Helldivers 2 community API (`api.helldivers2.dev`) as a **correctness layer**: it fetches raw war data, strips known deceptive/cosmetic fields, and exposes clean, strategy-ready data through eighteen MCP tools.

## The five invariants (the reason this server exists)

1. **Defense decay is cosmetic** — any defense-campaign decay/regen from upstream is force-nulled.
2. **Liberation % is not raw HP** — it is quarantined as `liberation_pct_display_only` and never used in math; all quantitative logic uses `raw_hp`.
3. **Projections use raw HP ÷ |HP-per-hour|** — never % progress. `hours_to_resolution = raw_hp / abs(hp_per_hour)`.
4. **Ramp-up stabilization** — campaigns younger than 1 hour (`RAMP_UP_THRESHOLD_MS` in `src/invariants.ts`) report `stabilizing: true` instead of false-collapse alerts.
5. **High Priority Campaign decay is intentionally deceptive** — HPCs never emit failure/collapse alerts.

All five live as pure, unit-tested functions in `src/invariants.ts`.

### `hp_per_hour` sign convention

Planet health counts **down** toward resolution. The server samples health into KV and computes `hp_per_hour = (previous − current) / hours`:

- **positive** → health depleting → progressing toward resolution (liberating/defending successfully)
- **negative** → health rising → losing ground
- `null` → not enough samples yet (see verification notes below)

The convention is identical for defense campaigns (the tracked health there is the **event** health, which depletes toward zero while a defense is being won — verified against live defenses on 2026-06-11). The projection uses the magnitude (`abs`); the `direction` flag is the sole carrier of progressing-vs-losing, with a kind-aware positive label: `liberating` on a liberation campaign, `repelling` on a defense. Every campaign also states its win-state orientation outright: `win_condition` (`raw_hp_to_zero` for both kinds) and `hp_remaining_to_objective` (always-positive distance to the win state, smaller = closer), so direction never has to be inferred from sign conventions. Defense campaigns additionally co-locate the timing gap as numbers: `projected_hp_at_defense_end` (linear extrapolation of the signed rate to the defense deadline) and `resolution_within_defense_window` (`hours_to_resolution ≤ defense_hours_remaining` — a deterministic comparison, not a success prediction).

## Tools

| Tool | Purpose |
|------|---------|
| `get_war_brief` | Single-call digest: current Major Order joined with the live trajectory of exactly its target planets, per-faction front rollups, active events, and totals — a pre-joined assembly of the same facts the tools below return; no recommendation, ranking, or verdict |
| `get_war_status` | War state, active fronts by faction, global stats, faction/sector rollups (counts and sums over fetched data) |
| `get_campaigns` | All active campaigns, invariant-normalized, with Major Order membership (`is_major_order_target` / `major_order_id`). Optional AND-combined filters: `faction`, `major_order_only`, `has_rate`, `hpc_only` (`filtered_count` vs `total_count` states coverage; no args → all) |
| `get_major_order` | Current MO: objectives, progress, rewards, time remaining. Objectives are decoded into named fields (`target`, `progress_pct`, `objective_kind`, `value_labels`) beside the untouched raw `values`/`value_types` arrays — labels only for live-confirmed enum values, never fabricated |
| `get_planet` | Deep dive by `index` or `name`, with `hours_to_resolution` projection, waypoint neighbor context (`neighbors` / `neighbor_summary` / `frontline` adjacency fact), reverse adjacency (`inbound_neighbors` / `adjacency_summary` with the `borders_super_earth` fact), `per_player_rates` (net & gross per-1k-players, consuming the one signed rate), per-region/city sub-objectives (`regions` / `regions_available` / `has_city_region`), the defense `gambit_origin(s)` (the planet attacking this defense — raw state + MO membership, never a viability verdict), and a `cross_check` block verifying the normalized fields against the raw ArrowHead status (both values surfaced on any disagreement, never resolved; degrades to a reasoned null when `/raw` is unavailable). Serves the most recent cached bulk snapshot (`stale: true`) when a live fetch cannot complete. **Persistence requires a complete live fetch:** a stale/snapshot/outage observation is served but never recorded (no history/archive write), and during a campaign-fetch outage campaign state is `campaign_state_known: false` with `has_active_campaign: null` — never asserted false |
| `get_supply_graph` | Supply-line graph over **observed waypoint edges**. No args → the active-campaign subgraph (every active-campaign planet plus its one-hop inbound+outbound neighbors); `full: true` → the whole galaxy; `root` (index/name) + `depth` (default 1, cap 3) walks outward; `active_only` narrows nodes to active campaigns. Returns `nodes` (with `borders_super_earth` and `campaign_state_known`) and directed `edges` (`observed: true` — implied reverse edges are never synthesized). **Read-only** (records nothing). Staleness names its source: a structured `provenance` block separates planet-list provenance (`planet_provenance: live_fresh\|live_expired_cache\|snapshot_fallback`, governs topology) from campaign-overlay provenance (`campaigns: ok\|stale\|unavailable`), and `active_campaign_overlay` (`complete\|degraded\|unavailable`) states the overlay's trust. Under a campaign outage the topology stays complete while nodes are `campaign_state_known: false` — an empty active subgraph reads as *unknown*, never "no active campaigns" |
| `get_dispatches` | In-fiction war news feed, newest first (`limit` optional, default 10 / cap 25) |
| `get_patch_notes` | Steam news / patch notes, newest first, verbatim BBCode content (`limit` optional, default 5 / cap 10) |
| `get_planet_history` | Observed health time-series for one planet by `index` or `name`: retained samples + per-point `delta_health`/`delta_hours` and observed-only aggregates (`rate_min`/`rate_max`/`rate_mean`/`latest_rate`, `samples_span_hours`) — observed values, never a forecast |
| `get_wiki_page` | **Lore source (separate from live war state):** community wiki entry from helldivers.wiki.gg for any topic by `title` (weapons, warbonds, stratagems, enemies/subfactions like "Jet Brigade", boosters, passives, missions, biomes, planets). Returns the plain-text intro extract by default; `full: true` returns the raw page wikitext. Carries the canonical URL and mandatory attribution (CC BY-NC-SA 4.0). Never authoritative for current war state |
| `get_observed_signatures` | Accumulated record of every distinct campaign signature tuple `{campaign_type, event_type, has_event, faction}` this server has observed, newest `last_seen` first — passive raw observation that captures rare states (special-faction events, defense campaign types) with timestamps |
| `get_global_history` | Global war statistics time-series sampled by this server (player count, missions, deaths, kills): retained points + raw observed deltas — observed values, never a forecast. Accrues on `get_war_status` polls |
| `get_major_order_history` | Observed Major Order objective-progress time-series: one bounded series per objective (`major_order_id` + `objective_index`) with per-point `delta_progress`/`delta_hours`, latest progress/target, and `progress_pct` — observed samples and deltas only, never a forecast, required pace, or on-track verdict. No args → the active MO(s); a recently ended MO stays queryable by `major_order_id` until it ages out |
| `resolve_planet` | Resolve a loose planet name (`query`) to the canonical planet: exact → punctuation/space-normalized → fuzzy. Near-misses and ties return ranked candidates (`score` = edit distance) with `matched: false` — never a silent substitution |
| `get_source_crosscheck` | Normalization-faithfulness health check: every active campaign and Major Order objective cross-checked against the raw ArrowHead payloads (the same wrapper's `/raw` endpoints — same host, auth, and cache, not a second provider). Tallies agreements / unexpected disagreements / expected invariant transforms / uncheckable fields, plus the specific divergent fields with BOTH values and the diff. Disagreements are surfaced, never resolved — no side is ranked correct |
| `get_planet_archive` | **Long-range (D1 archive):** the unbounded counterpart to `get_planet_history` — a planet's observed health series read from the durable D1 store (`index` or `name`, optional `since_hours` default 168 / `limit` cap 1000), with per-point `delta_health`/`delta_hours` and the stored signed `hp_per_hour`. Observed points and deltas only, never a forecast |
| `get_global_archive` | **Long-range (D1 archive):** the unbounded counterpart to `get_global_history` — global war statistics over days/weeks (player count, `impact_multiplier`, `active_campaign_count`, missions, deaths, kills) with raw observed deltas. The view that answers impact-multiplier-vs-population and the daily population cycle; no correlation or model, ever |
| `get_major_order_archive` | **Long-range (D1 archive):** the unbounded counterpart to `get_major_order_history` — Major Order objective progress across a whole order, one series per objective with `delta_progress`/`delta_hours` and `progress_pct`. Optional `major_order_id`/`objective_index`. Observed samples and deltas only, never a forecast, required pace, or verdict (`objective_kind` is `null` here — the raw task type is not archived; use `get_major_order_history` for the label) |

### Two stores: KV (recent, fast) + D1 (unbounded archive) — Stage 12

History lives in **two stores with different jobs, never one replacing the other**:

- **KV ring buffer (`samples:planets`)** — the fast recent-window cache. Every live calculation (`hp_per_hour`, the dual ETAs, divergence) reads *only* the recent samples from KV. Bounded to ~96 points/planet (~16h at the `*/10` cadence). This path is unchanged and remains the **source of truth for all live logic**.
- **D1 archive (`HISTORY_DB`)** — an **append-only, effectively unbounded** long-term record (Cloudflare D1 free tier: 5 GB / 5 M writes-month; at ~5,900 rows/day that lasts decades). On each sample tick, *in addition to* the existing KV write, the tick's observations are inserted into D1 in a single batched write. Nothing reads D1 for live logic; it is read only by the three `*_archive` tools above when someone wants the long view.

The two never conflict because they serve different time ranges (last ~16h vs. forever) and are never reconciled. The D1 write is **best-effort and failure-isolated** — if D1 is briefly unavailable a tick is simply not archived; the KV write and the primary response are never affected. The same 60s minimum-sample interval that gates the KV write gates the D1 write, so the archive never accrues duplicate rows.

### Freshness metadata (Stage 6)

Every response derived from an upstream fetch carries `as_of`, `fetched_at`, and `cache_age_seconds`, computed from the cache record's stored retrieval timestamp (the oldest contributing endpoint when several are joined). `as_of` is the moment the snapshot is *from*; `fetched_at` is when this server *retrieved* it — the two coincide by construction here because the upstream serves live state at request time and its own war `now` field is game-epoch time (not a usable real-world timestamp). `stale: true` still marks an expired-cache fallback after an upstream failure. Pure metadata — it lets the consumer say "as of N seconds ago" honestly.

### Two sources, never mixed

The live tools answer *what is happening* (verifiable against `api.helldivers2.dev`); `get_wiki_page` answers *what it means* (community-authored lore from `helldivers.wiki.gg`). The pipelines are physically separate in the code (`wiki.ts`/`wikiClient.ts` vs everything else), wiki prose never appears in a live war-state field, and the wiki payload never carries live numbers. They are joined only by the consumer, in conversation.

Live event identity rides the live side: `get_planet` and each campaign in `get_campaigns` carry `event_type` (the raw upstream `event.eventType`, passed through) and `modifier` (its decoded special-faction name — e.g. "Jet Brigade" — only for enum values confirmed in `EVENT_MODIFIER_NAMES`). No event → both `null`. Unconfirmed enum value → `event_type` set, `modifier: null`: visible, never named by guess.

## Setup & deploy (under five minutes)

```bash
npm install

# 1. Create the KV namespace and paste the printed id into wrangler.toml
npx wrangler kv namespace create WAR_CACHE

# 2. Create the D1 archive DB and paste the printed database_id into wrangler.toml
#    (replaces the REPLACE_WITH_D1_DATABASE_ID placeholder in [[d1_databases]])
npx wrangler d1 create hd2-strategist-history

# 3. Apply the schema (migrations/0001_init.sql) — BOTH local and remote.
#    The --remote migration is a PREREQUISITE of deploy (see the warning below).
npx wrangler d1 migrations apply hd2-strategist-history --local    # for local dev
npx wrangler d1 migrations apply hd2-strategist-history --remote   # for production

# 4. Set the upstream API courtesy headers (never committed to the repo)
npx wrangler secret put SUPER_CLIENT    # e.g. your-app-name or domain
npx wrangler secret put SUPER_CONTACT   # e.g. your email or Discord handle

# 5. Deploy
npx wrangler deploy
```

Cloudflare auth comes from `wrangler login` locally, or a `CLOUDFLARE_API_TOKEN` repo secret in CI.

> **⚠️ Deploy has a database-setup prerequisite (new in Stage 12).** Unlike earlier
> stages, you must create the D1 database, paste its id into `wrangler.toml`, and
> **apply `wrangler d1 migrations apply hd2-strategist-history --remote`** *before*
> `wrangler deploy`. If a deploy shows the `*_archive` tools erroring while the
> KV-backed tools work fine, the remote migration was almost certainly not applied
> (it was run `--local` only). The archive starts empty and fills one tick at a
> time — same cold-start honesty as every history feature; within a day
> `get_global_archive` holds multi-hour trends, within a week genuine multi-day
> patterns. After deploy, toggle the connector so the three new tools appear.

## Connecting an MCP client

The Worker speaks MCP (JSON-RPC 2.0) over plain HTTP POST at `/` or `/mcp`:

```
https://hd2-strategist.<your-account>.workers.dev/mcp
```

- **Claude Code:** `claude mcp add --transport http strategist https://hd2-strategist.<your-account>.workers.dev/mcp`
- **claude.ai / Claude Desktop:** add a custom connector with that URL.

> **Note:** this version has no authentication on the MCP endpoint (single-user, URL-based connection). Adding auth is a future extension.

## Development & verification

```bash
npm test            # vitest: all five invariants + edge cases
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev (local)
```

Smoke-test with curl against `wrangler dev`:

```bash
curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_campaigns","arguments":{}}}'
```

### Verification notes: `hp_per_hour` timing

The rate needs **two calls separated by more than 60 seconds of wall-clock time** (use ~70–90s to comfortably clear both the 45s raw-response cache TTL and the 60s minimum sample interval). The first call seeds the health sample; the second produces a fresh, distinct read and therefore a numeric `hp_per_hour`. **A `null` rate when polling faster than this is expected behavior, not a bug.** Until then, projections report `status: "insufficient_data"`.

The same timing governs `get_planet_history`: it returns the samples accumulated by polling (`get_campaigns` / `get_war_status` / `get_planet` calls), so on a cold start it correctly reports an empty series with `insufficient_history: true` — populate it with two polls >60s apart.

`get_global_history` follows the same rule, with one narrowing: global statistics are sampled only when the war state is fetched (`get_war_status` polls — and every cron tick, see below), so locally populate it with two `get_war_status` calls >60s apart. `get_major_order_history` follows the same rule too — MO objective progress is sampled on every campaign poll (assignments are part of that fetch set), so a cold start correctly reports empty series with `insufficient_history: true`, populating after two polls >60s apart. `get_observed_signatures` accumulates on every campaign poll and is expected to be empty on a cold start. All three tools are read-only:

```bash
curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_observed_signatures","arguments":{}}}'

curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_global_history","arguments":{}}}'

curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_major_order_history","arguments":{}}}'
```

### Background sampling (Cron Trigger)

A Cloudflare Cron Trigger (`[triggers]` in `wrangler.toml`) fires the Worker's `scheduled` handler **every 10 minutes** and drives exactly the same sampling path a request-driven poll does: the same cache/fetch logic, the same 60s minimum sample interval, and the same single merged `samples:planets` write (planet series + observed signatures + global statistics + Major Order progress series — global stats are sampled on every tick because the war fetch is joined). The accumulation layers behind `get_planet_history`, `get_global_history`, `get_major_order_history`, and `get_observed_signatures` therefore advance continuously on the deployed Worker, independent of user calls. It introduces no new data, fields, or interpretation — it only runs the existing sampler on a schedule.

- **Cadence & KV write budget:** the KV free tier allows ~1,000 writes/day, and a tick costs ~4 KV writes — the single merged store write **plus** up to three `raw:` cache refreshes (the 45s response cache is always expired between ticks). At `*/10` that is 144 runs × 4 ≈ 576 writes/day, comfortably under the ceiling with headroom for user traffic; a 2-min cadence would be ~2,880/day (≈3× over budget — KV writes then fail silently and the sampler stalls for the rest of the UTC day). Faster sampling also *shortens* the visible history window: the 96-point ring buffer spans 16h at `*/10` but only ~3h at `*/2`. Re-check the full budget before ever tightening the cadence.
- **UTC:** Cloudflare cron always evaluates in UTC. Irrelevant for a fixed-interval poll, but any future time-of-day schedule must account for it.
- **Failure is silent by design:** an upstream failure during a scheduled run is logged and swallowed (no user is watching a cron tick); the next tick retries. The interval guard makes overlapping cron/request samples safe — last-write-wins on the single merged store, with `first_seen` preserved by the merge.
- **Cron triggers only run on the deployed Worker.** Locally, test the handler via wrangler's scheduled-test mode:

```bash
npm run dev -- --test-scheduled
# then trigger a tick:
curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"
```

After a deploy, verify it end-to-end by leaving the server idle and checking that `get_observed_signatures` `last_seen` and `get_global_history` timestamps keep advancing on their own.

## Architecture

```
src/index.ts       Worker entry — routes POST / and /mcp; `scheduled` cron entry
src/mcp.ts         JSON-RPC 2.0: initialize, tools/list, tools/call
src/client.ts      Upstream fetch + KV cache (raw responses) + rate sampling; triggers the D1 archive write
src/archive.ts     D1 history archive I/O — best-effort batched write + the long-range read queries (Stage 12)
src/invariants.ts  Pure normalization — the five invariants, no I/O
src/sampling.ts    Pure sample-series ring buffer behind hp_per_hour + history
src/enrichment.ts  Pure fact pass-throughs (stats, timing, dispatches, history deltas, event decode, archive points)
src/wiki.ts        Pure wiki lore logic (URL/key builders, response shaping, attribution) — separate source
src/wikiClient.ts  Wiki fetch + canonical-keyed KV cache (`wiki:` namespace) — separate from client.ts
src/tools.ts       The eighteen tool implementations
src/types.ts       Raw upstream + normalized types
migrations/        D1 schema migrations (0001_init.sql) applied via `wrangler d1 migrations apply`
```

Raw upstream responses are cached in KV (`WAR_CACHE`) for ~45s; on upstream 429/5xx/timeouts the server falls back to a stale copy (marked `stale: true`) and only errors — with a structured MCP error — when no copy exists. Normalization runs **after** the cache read, so invariant changes never require cache invalidation.

**Two history stores (Stage 12).** KV (`WAR_CACHE`, `samples:planets`) holds the bounded recent ring buffer and is the source of truth for all live logic. D1 (`HISTORY_DB`) is the append-only unbounded archive: on each sample tick, immediately after the KV write, the same observations are inserted into D1 in one batched, best-effort, failure-isolated write (a D1 outage degrades to "this tick wasn't archived", never an error). The `*_archive` tools read D1 for the long view; nothing else does. The two stores serve different time ranges and are never reconciled.
