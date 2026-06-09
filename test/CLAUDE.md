# test/ — unit tests

Plain vitest, no Workers runtime: everything under test is pure
(`src/invariants.ts`, `src/connectivity.ts`). If a test needs I/O or KV, the
code under test is in the wrong module — move the logic, don't mock the world.
One sanctioned exception: `connectivity.test.ts` mocks the `src/client`
module (the I/O boundary, nothing deeper) to assert the tool-level output
shapes of `get_planet` / `get_campaigns` / `get_supply_lines`.

## Coverage that must never regress

Each of these maps to a spec requirement; removing or weakening one breaks
the project's definition of done:

- Each of the five invariants in isolation.
- Edge case 3: `hp_per_hour === 0` → `hours_to_resolution: null`,
  `status: "stalemate"`, no division.
- Edge case 4: negative rate on a liberation campaign → `direction: "losing"`,
  but a young campaign gets `stabilizing: true` and a suppressed alert.
- Edge case 7: defense campaign WITH an upstream `regenPerSecond` value →
  output decay is null (invariant 1, tested specifically).
- Edge case 8: newly opened HPC with steep decay → not failing
  (invariants 4 + 5 stacked, tested specifically).
- Sign-convention mirror: losing DEFENSE campaign with RISING `event.health`
  → negative `hp_per_hour`, `direction: "losing"`, positive abs
  `hours_to_resolution`, alerts still suppressed when young or HPC. This
  proves the sign doesn't flip across campaign kinds.
- Data-quality gate: missing/NaN `raw_hp` → `data_quality: "degraded"`,
  excluded from projections, never substituted with 0.
- Connectivity (`connectivity.test.ts`): missing `waypoints` → `[]` (never
  null); missing `position` → `null` (never `{x:0,y:0}` — a real map origin);
  dangling waypoint index → link preserved with `name: null`, not dropped;
  `connection_count === waypoints.length` including dangling links; neighbor
  join resolves `owner` / `has_active_campaign` / `campaign_kind` from the
  planets list and active campaigns; `get_supply_lines` is sector-grouped,
  one entry per planet, lean fields only.

## Conventions

- Build fixtures with the `makeCampaign` / `makeEvent` / `ctx` helpers in
  `invariants.test.ts`; defaults are a mature (2h old), non-HPC liberation
  campaign at 600k/1M HP with a +10k/h rate — override only what the test is
  about.
- Rates in tests follow the client.ts sign convention: positive = progressing,
  negative = losing. Don't invent fixtures that contradict it.
