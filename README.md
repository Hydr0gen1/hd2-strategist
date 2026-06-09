# hd2-strategist — "Strategist"

A headless Galactic War **MCP server** running as a single Cloudflare Worker. It sits between an MCP client (e.g. Claude) and the Helldivers 2 community API (`api.helldivers2.dev`) as a **correctness layer**: it fetches raw war data, strips known deceptive/cosmetic fields, and exposes clean, strategy-ready data through five MCP tools.

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
| `get_war_status` | War state, active fronts by faction, global stats |
| `get_campaigns` | All active campaigns, invariant-normalized |
| `get_major_order` | Current MO: objectives, progress, rewards, time remaining |
| `get_planet` | Deep dive by `index` or `name`, with `hours_to_resolution` projection |
| `get_supply_lines` | Whole-galaxy supply-line graph, sector-grouped, with neighbor-joined waypoints — raw connectivity only, no routing/targeting judgment |

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

## Architecture

```
src/index.ts       Worker entry — routes POST / and /mcp
src/mcp.ts         JSON-RPC 2.0: initialize, tools/list, tools/call
src/client.ts      Upstream fetch + KV cache (raw responses) + rate sampling
src/invariants.ts  Pure normalization — the five invariants, no I/O
src/tools.ts       The five tool implementations
src/types.ts       Raw upstream + normalized types
```

Raw upstream responses are cached in KV (`WAR_CACHE`) for ~45s; on upstream 429/5xx/timeouts the server falls back to a stale copy (marked `stale: true`) and only errors — with a structured MCP error — when no copy exists. Normalization runs **after** the cache read, so invariant changes never require cache invalidation.
