# test/ — unit tests

Plain vitest, no Workers runtime: everything under test is pure
(`src/invariants.ts`, `src/enrichment.ts`, `src/sampling.ts`). If a test
needs I/O or KV, the code under test is in the wrong module — move the
logic, don't mock the world.

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
- Stage 1 (`stage1.test.ts`): `mission_success_rate` zero-missions → `null`
  (never 0, no divide-by-zero); defense timing from the SUPPLIED clock with
  past-end → `0` + `defense_expired: true` and missing `endTime` → `null`;
  missing statistics → `null`, never fabricated; missing biome → `null`;
  missing hazards → `[]`, never null.
- Stage 2 (`stage2.test.ts`):
  - **Rate-preservation regression**: `advancePlanetSeries` yields the EXACT
    signed `hp_per_hour` (float-equal, `toBe`) that the pre-ring-buffer
    single-sample store computed for the same two data points — both signs
    plus the zero case. This is the proof the history refactor didn't touch
    rate semantics.
  - Legacy-store migration (`{h, t, lastRate}` → one-sample series) produces
    the identical next-poll rate; hybrid/garbage entries coerce safely.
  - Ring-buffer bounds: never more than `MAX_SAMPLES_PER_PLANET` points,
    over-age points evicted on append, the newest sample never evicted,
    the no-append path leaves the series untouched.
  - Worst-case serialized store (full galaxy × max points) stays far under
    the 5MB KV value limit.
  - `buildHistoryPoints`: per-point `delta_health`/`delta_hours` are exact
    consecutive differences, first point null — observed deltas, never a
    projection.
  - `shapeDispatches`/`shapePatchNotes`: newest-first (unparseable dates
    sink), limit clamping at every edge, empty upstream → `[]`,
    message/content passed through verbatim.

## Conventions

- Build fixtures with the `makeCampaign` / `makeEvent` / `ctx` helpers in
  `invariants.test.ts`; defaults are a mature (2h old), non-HPC liberation
  campaign at 600k/1M HP with a +10k/h rate — override only what the test is
  about.
- Rates in tests follow the client.ts sign convention: positive = progressing,
  negative = losing. Don't invent fixtures that contradict it.
