# hd2-strategist — "Strategist"

A headless Galactic War **MCP server** running as a single Cloudflare Worker. It sits between an MCP client (e.g. Claude) and the Helldivers 2 community API (`api.helldivers2.dev`) as a **correctness layer**: it fetches raw war data, strips known deceptive/cosmetic fields, and exposes clean, strategy-ready data through twelve MCP tools.

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

The projection uses the magnitude (`abs`); the `direction` flag is the sole carrier of liberating-vs-losing.

## Tools

| Tool | Purpose |
|------|---------|
| `get_war_brief` | Single-call digest: current Major Order joined with the live trajectory of exactly its target planets, per-faction front rollups, active events, and totals — a pre-joined assembly of the same facts the tools below return; no recommendation, ranking, or verdict |
| `get_war_status` | War state, active fronts by faction, global stats, faction/sector rollups (counts and sums over fetched data) |
| `get_campaigns` | All active campaigns, invariant-normalized, with Major Order membership (`is_major_order_target` / `major_order_id`). Optional AND-combined filters: `faction`, `major_order_only`, `has_rate`, `hpc_only` (`filtered_count` vs `total_count` states coverage; no args → all) |
| `get_major_order` | Current MO: objectives, progress, rewards, time remaining |
| `get_planet` | Deep dive by `index` or `name`, with `hours_to_resolution` projection and waypoint neighbor context (`neighbors` / `neighbor_summary` / `frontline` adjacency fact) |
| `get_dispatches` | In-fiction war news feed, newest first (`limit` optional, default 10 / cap 25) |
| `get_patch_notes` | Steam news / patch notes, newest first, verbatim BBCode content (`limit` optional, default 5 / cap 10) |
| `get_planet_history` | Observed health time-series for one planet by `index` or `name`: retained samples + per-point `delta_health`/`delta_hours` and observed-only aggregates (`rate_min`/`rate_max`/`rate_mean`/`latest_rate`, `samples_span_hours`) — observed values, never a forecast |
| `get_planet_wiki` | **Lore source (separate from live war state):** community wiki entry from helldivers.wiki.gg for a planet (`name`) or any topic (`title`, e.g. "Jet Brigade") — plain-text lead extract, canonical URL, mandatory attribution (CC BY-NC-SA 4.0). Never authoritative for current war state |
| `get_observed_signatures` | Accumulated record of every distinct campaign signature tuple `{campaign_type, event_type, has_event, faction}` this server has observed, newest `last_seen` first — passive raw observation that captures rare states (special-faction events, defense campaign types) with timestamps |
| `get_global_history` | Global war statistics time-series sampled by this server (player count, missions, deaths, kills): retained points + raw observed deltas — observed values, never a forecast. Accrues on `get_war_status` polls |
| `resolve_planet` | Resolve a loose planet name (`query`) to the canonical planet: exact → punctuation/space-normalized → fuzzy. Near-misses and ties return ranked candidates (`score` = edit distance) with `matched: false` — never a silent substitution |

### Freshness metadata (Stage 6)

Every response derived from an upstream fetch carries `as_of`, `fetched_at`, and `cache_age_seconds`, computed from the cache record's stored retrieval timestamp (the oldest contributing endpoint when several are joined). `as_of` is the moment the snapshot is *from*; `fetched_at` is when this server *retrieved* it — the two coincide by construction here because the upstream serves live state at request time and its own war `now` field is game-epoch time (not a usable real-world timestamp). `stale: true` still marks an expired-cache fallback after an upstream failure. Pure metadata — it lets the consumer say "as of N seconds ago" honestly.

### Two sources, never mixed

The live tools answer *what is happening* (verifiable against `api.helldivers2.dev`); `get_planet_wiki` answers *what it means* (community-authored lore from `helldivers.wiki.gg`). The pipelines are physically separate in the code (`wiki.ts`/`wikiClient.ts` vs everything else), wiki prose never appears in a live war-state field, and the wiki payload never carries live numbers. They are joined only by the consumer, in conversation.

Live event identity rides the live side: `get_planet` and each campaign in `get_campaigns` carry `event_type` (the raw upstream `event.eventType`, passed through) and `modifier` (its decoded special-faction name — e.g. "Jet Brigade" — only for enum values confirmed in `EVENT_MODIFIER_NAMES`). No event → both `null`. Unconfirmed enum value → `event_type` set, `modifier: null`: visible, never named by guess.

## Setup & deploy (under five minutes)

```bash
npm install

# 1. Create the KV namespace and paste the printed id into wrangler.toml
npx wrangler kv namespace create WAR_CACHE

# 2. Set the upstream API courtesy headers (never committed to the repo)
npx wrangler secret put SUPER_CLIENT    # e.g. your-app-name or domain
npx wrangler secret put SUPER_CONTACT   # e.g. your email or Discord handle

# 3. Deploy
npx wrangler deploy
```

Cloudflare auth comes from `wrangler login` locally, or a `CLOUDFLARE_API_TOKEN` repo secret in CI.

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

`get_global_history` follows the same rule, with one narrowing: global statistics are sampled only on `get_war_status` polls (the one path that fetches `/api/v1/war`), so populate it with two `get_war_status` calls >60s apart. `get_observed_signatures` accumulates on every campaign poll and is expected to be empty on a cold start. Both tools are read-only:

```bash
curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_observed_signatures","arguments":{}}}'

curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_global_history","arguments":{}}}'
```

## Architecture

```
src/index.ts       Worker entry — routes POST / and /mcp
src/mcp.ts         JSON-RPC 2.0: initialize, tools/list, tools/call
src/client.ts      Upstream fetch + KV cache (raw responses) + rate sampling
src/invariants.ts  Pure normalization — the five invariants, no I/O
src/sampling.ts    Pure sample-series ring buffer behind hp_per_hour + history
src/enrichment.ts  Pure fact pass-throughs (stats, timing, dispatches, history deltas, event decode)
src/wiki.ts        Pure wiki lore logic (query plan, response shaping, attribution) — separate source
src/wikiClient.ts  Wiki fetch + long-TTL KV cache (`wiki:` namespace) — separate from client.ts
src/tools.ts       The twelve tool implementations
src/types.ts       Raw upstream + normalized types
```

Raw upstream responses are cached in KV (`WAR_CACHE`) for ~45s; on upstream 429/5xx/timeouts the server falls back to a stale copy (marked `stale: true`) and only errors — with a structured MCP error — when no copy exists. Normalization runs **after** the cache read, so invariant changes never require cache invalidation.
