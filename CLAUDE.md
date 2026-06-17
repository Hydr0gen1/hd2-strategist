# hd2-strategist — "Strategist"

Headless MCP server on a single Cloudflare Worker. It fronts the Helldivers 2
community API (`api.helldivers2.dev`) as a **correctness layer**: it normalizes
raw war data to strip known deceptive/cosmetic fields and exposes exactly
seventeen MCP tools. There is no frontend and no upstream app — the Worker IS
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
src/         Worker source — see src/CLAUDE.md for the domain invariants (read
             it before touching anything in src/)
test/        Unit tests — see test/CLAUDE.md for required coverage
migrations/  D1 schema (0001_init.sql) — applied via `wrangler d1 migrations apply`
wrangler.toml  KV binding WAR_CACHE + D1 binding HISTORY_DB. NEVER put secrets here.
```

## Hard rules (project-wide)

- **Exactly eighteen tools**: `get_war_brief`, `get_war_status`,
  `get_campaigns`, `get_major_order`, `get_planet`, `get_supply_graph`,
  `get_dispatches`, `get_patch_notes`, `get_planet_history`,
  `get_planet_wiki`, `get_observed_signatures`, `get_global_history`,
  `get_major_order_history`, `resolve_planet`, `get_source_crosscheck`,
  and the Stage 12 D1 archive trio `get_planet_archive`,
  `get_global_archive`, `get_major_order_archive`. Do not add tools or
  rename them. (`get_supply_graph` was the eighteenth, added by the Fabel
  supply-graph/gambit pass; the count was seventeen before it.)
- **Fabel additive-fact rule** (supply graph, gambit, per-player rates,
  regions, warm cache): every new field is a raw upstream value or a
  deterministic transform of values already in the payload — never a verdict.
  Names state facts (`borders_super_earth`, `gambit_origin`), never
  judgments (`can_liberate`, `gambit_viable`). The five invariants are
  frozen — new code CONSUMES the single signed `hp_per_hour` and the
  invariant-1 nulled decay, never recomputing a rate or reaching around a
  suppressed field. `inbound_neighbors` is the pure inversion of observed
  waypoints (no symmetrization/routing); `gambit_origin` inverts the observed
  source→target attack pairs; `per_player_rates` divide-guard zero players;
  `regions` is a faithful passthrough with NO derived liberation-contribution
  math; the warm `snapshot:planets` cache feeds adjacency/ownership/HP context
  lookups ONLY (get_planet / get_supply_graph fallback) and MUST NOT backfill
  the history/global-stats archive.
- **Two history stores, never reconciled** (Stage 12): KV
  (`samples:planets`) is the bounded recent ring buffer and the SOURCE OF
  TRUTH for all live logic (`hp_per_hour`, the dual ETAs, divergence read
  ONLY the recent KV samples). D1 (`HISTORY_DB`, `src/archive.ts`) is the
  append-only unbounded archive, read ONLY by the three `*_archive` tools.
  The D1 write rides immediately after the existing KV write (and ONLY when
  the KV put actually committed — a failed/absent KV write is not archived,
  so the archive never drifts ahead of the ring buffer), is BATCHED (one
  `db.batch` per tick, never a per-row await loop), gated by the SAME 60s
  interval, and BEST-EFFORT / FAILURE-ISOLATED (its own try/catch swallows
  — a D1 outage degrades to "tick not archived", never an error and never
  touching the KV write or the response). The no-duplicate guarantee holds
  even under concurrent overlapping polls (cron + request) via an ATOMIC
  DB gate: every append-only row carries a `tick_anchor` (its predecessor
  KV sample's timestamp — which both racers share because they read the
  same old store) and a UNIQUE index makes the second `INSERT OR IGNORE` a
  no-op. Reads ORDER BY `sampled_at DESC` + LIMIT then re-sort ascending,
  so a capped window keeps the NEWEST rows, never the oldest. Never
  add reconciliation logic between the two stores; never let D1 feed live
  logic; never change the KV/rate path to accommodate D1. Parameterized SQL
  ONLY — every value via `.bind()`. The archive tools enrich, never
  conclude: observed points + raw deltas, `insufficient_history` below two
  rows, no forecast/pace/trend verdict (same prime directive as the KV
  history tools).
- **Cross-checks surface, never resolve** (Stage 10): the raw-source
  cross-check layer (`src/crosscheck.ts`, the wrapper's `/raw` endpoints —
  same host/auth/cache, NOT a second provider) presents the normalized
  value, the raw value, and the difference. It must never pick a side,
  average, or flag one source as correct; the only permitted classification
  is `expected_transform: true` for documented invariant transforms
  (defense decay force-nulled, liberation % recomputed) — key-name pinned
  by test.
- **The digest never concludes**: `get_war_brief` is pure ASSEMBLY of facts
  the other tools already return (MO + its targets' live trajectories,
  faction rollups, events, totals). No recommended target, no priority
  ranking, no "war is going well/badly" — ever. Judgment lives in the
  conversation layer.
- **KV write budget**: one KV read + one KV write per poll cycle is the
  ceiling. The Stage 5/8 accumulation layers (observed campaign signatures,
  global statistics series, Major Order progress series) fold into the
  existing `samples:planets` write — never a second per-cycle write. (The
  Stage 12 D1 archive write is a separate store, not a KV write, so it does
  not count against this budget; it is one batched D1 call per tick.)
- **Two sources, never mixed**: everything except `get_planet_wiki` is live
  war state from `api.helldivers2.dev`; `get_planet_wiki` is community LORE
  from `helldivers.wiki.gg` (own pipeline `src/wiki.ts` + `src/wikiClient.ts`,
  own `wiki:` KV namespace, mandatory attribution on every payload). Wiki
  prose must never appear in a live war-state field, live tools must never
  call the wiki, and the wiki payload must never carry live war numbers.
- **Secrets**: `SUPER_CLIENT` / `SUPER_CONTACT` come from `wrangler secret put`
  and are read from `env`. Never hardcode them, never commit them, never add
  them to `wrangler.toml`.
- **Out of scope by design**: no UI, no Docker, no auth on the MCP endpoint
  (single-user URL connection; auth is a noted future extension). (D1/SQLite
  WAS out of scope pre-Stage-12; it is now the unbounded history archive —
  but ONLY as the append-only archive described above, never for live logic.)
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
   >60s apart — global stats are sampled only on that path) and
   `get_major_order_history` (two campaign polls >60s apart — MO progress
   samples on every poll), and `get_observed_signatures` /
   `get_global_history` / `get_major_order_history` are expected to be empty
   on a cold start.
4. Freshness metadata (`as_of` / `fetched_at` / `cache_age_seconds`) rides
   every upstream-derived response. `as_of` and `fetched_at` coincide by
   construction (upstream serves live state at fetch time; its war `now` is
   game-epoch and unusable) — that is documented behavior, not a bug.
