# hd2-strategist — "Strategist"

Headless MCP server on a single Cloudflare Worker. It fronts the Helldivers 2
community API (`api.helldivers2.dev`) as a **correctness layer**: it normalizes
raw war data to strip known deceptive/cosmetic fields and exposes exactly
twelve MCP tools. There is no frontend and no upstream app — the Worker IS
the app.

## Commands

```bash
npm test            # vitest — must stay green; invariants are the product
npm run typecheck   # tsc --noEmit (strict mode)
npm run dev         # wrangler dev on :8787 (POST JSON-RPC to / or /mcp)
npm run deploy      # wrangler deploy (needs Cloudflare auth)
```

Local dev secrets go in `.dev.vars` (gitignored): `SUPER_CLIENT`, `SUPER_CONTACT`.

## Map

```
src/   Worker source — see src/CLAUDE.md for the domain invariants (read it
       before touching anything in src/)
test/  Unit tests — see test/CLAUDE.md for required coverage
wrangler.toml  KV binding WAR_CACHE only. NEVER put secrets here.
```

## Hard rules (project-wide)

- **Exactly twelve tools**: `get_war_brief`, `get_war_status`,
  `get_campaigns`, `get_major_order`, `get_planet`, `get_dispatches`,
  `get_patch_notes`, `get_planet_history`, `get_planet_wiki`,
  `get_observed_signatures`, `get_global_history`, `resolve_planet`. Do not
  add tools or rename them.
- **The digest never concludes**: `get_war_brief` is pure ASSEMBLY of facts
  the other tools already return (MO + its targets' live trajectories,
  faction rollups, events, totals). No recommended target, no priority
  ranking, no "war is going well/badly" — ever. Judgment lives in the
  conversation layer.
- **KV write budget**: one KV read + one KV write per poll cycle is the
  ceiling. The Stage 5 accumulation layers (observed campaign signatures,
  global statistics series) fold into the existing `samples:planets` write —
  never a second per-cycle write.
- **Two sources, never mixed**: everything except `get_planet_wiki` is live
  war state from `api.helldivers2.dev`; `get_planet_wiki` is community LORE
  from `helldivers.wiki.gg` (own pipeline `src/wiki.ts` + `src/wikiClient.ts`,
  own `wiki:` KV namespace, mandatory attribution on every payload). Wiki
  prose must never appear in a live war-state field, live tools must never
  call the wiki, and the wiki payload must never carry live war numbers.
- **Secrets**: `SUPER_CLIENT` / `SUPER_CONTACT` come from `wrangler secret put`
  and are read from `env`. Never hardcode them, never commit them, never add
  them to `wrangler.toml`.
- **Out of scope by design**: no UI, no D1/SQLite, no Docker, no auth on the
  MCP endpoint (single-user URL connection; auth is a noted future extension).
- **Free-tier CPU budget (~10ms)**: normalization stays plain object
  transforms, O(n) over the campaign list. No SDK dependencies in the Worker;
  the MCP JSON-RPC layer in `src/mcp.ts` is deliberately hand-rolled.
- The five domain invariants in `src/invariants.ts` are the entire reason this
  server exists. They are non-negotiable and must remain unit-tested. Do not
  "improve" them by making suppressed fields (defense decay, liberation %)
  look more informative — suppression IS the requirement.

## Verifying a change end-to-end

1. `npm test && npm run typecheck`.
2. `npm run dev`, then curl JSON-RPC (`initialize`, `tools/list`, `tools/call`
   per tool) — see README "Development & verification" for exact payloads.
3. `hp_per_hour` timing trap: a numeric rate needs TWO calls separated by
   >60s wall-clock (use 70–90s — past both the 45s raw-cache TTL and the 60s
   `MIN_SAMPLE_INTERVAL_MS`). A `null` rate before that is expected, not a bug.
   The same timing governs `get_global_history` (two `get_war_status` polls
   >60s apart — global stats are sampled only on that path), and
   `get_observed_signatures` / `get_global_history` are expected to be empty
   on a cold start.
4. Freshness metadata (`as_of` / `fetched_at` / `cache_age_seconds`) rides
   every upstream-derived response. `as_of` and `fetched_at` coincide by
   construction (upstream serves live state at fetch time; its war `now` is
   game-epoch and unusable) — that is documented behavior, not a bug.
