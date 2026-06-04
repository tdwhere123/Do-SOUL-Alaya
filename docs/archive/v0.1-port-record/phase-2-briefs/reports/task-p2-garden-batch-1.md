# Task P2-garden-batch-1 Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-garden-batch-1.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/auditor.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/scheduler.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/compute-provider.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/compute-routing-service.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/local-heuristics.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor.test.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor-4b.test.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/garden-scheduler.test.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-provider.test.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-routing-service.test.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/local-heuristics.test.ts`
- Targets:
  - `packages/soul/src/garden/auditor.ts`
  - `packages/soul/src/garden/scheduler.ts`
  - `packages/soul/src/garden/compute-provider.ts`
  - `packages/soul/src/garden/compute-routing-service.ts`
  - `packages/soul/src/garden/local-heuristics.ts`
  - `packages/soul/src/__tests__/auditor.test.ts`
  - `packages/soul/src/__tests__/auditor-repair-orphan-detection.test.ts`
  - `packages/soul/src/__tests__/garden-scheduler.test.ts`
  - `packages/soul/src/__tests__/compute-provider.test.ts`
  - `packages/soul/src/__tests__/compute-routing-service.test.ts`
  - `packages/soul/src/__tests__/local-heuristics.test.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/task-p2-garden-batch-1.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-garden-batch-1.md`
  - `docs/v0.1/phase-2-briefs/README.md`
  - `docs/v0.1/INDEX.md`
  - `docs/handbook/runtime-status.md`
  - `docs/handbook/code-map.md`

No shared barrels, root config, storage repos, core files, daemon files, MCP,
CLI, GUI, TUI, or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation and tests were copied from the cited vendor paths.
The permitted adaptations are:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `compute-routing-service.test.ts` imports `ComputeRoutingService` from
  `../garden/compute-routing-service.js` and provider types from
  `../garden/compute-provider.js` instead of importing through the package
  barrel.
- `local-heuristics.test.ts` imports `LocalHeuristics` from
  `../garden/local-heuristics.js` and `GardenCompileContext` from
  `../garden/compute-provider.js` instead of importing through the package
  barrel.

## Parity Evidence

Source existence check passed for all source paths in the task card.

The production target files match the vendor files after applying only the
package alias rewrite. The test target files match after the package alias
rewrite and the two task-card test-boundary adapter points.

## Verification

- Source existence check for the 11 cited source/test paths - passed.
- Normalized vendor parity check - passed.
- `rtk pnpm install` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/soul` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-soul auditor auditor-repair-orphan-detection garden-scheduler compute-provider compute-routing-service local-heuristics` - passed; 6 files / 69 tests passed.
- `rtk git diff --check` - passed.

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of Garden task, provider,
  compute-routing, signal, health, lifecycle, and event types.
- Garden roles remain inside `packages/soul` and communicate through
  protocol-facing ports.
- `packages/soul/src/index.ts` and `packages/soul/src/garden/index.ts` were not
  edited; P2-barrel-soul still owns Garden exports.
- No daemon, MCP, CLI, GUI, TUI, or live surface was introduced.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because two
  source tests import through the upstream `@do-what/soul` barrel. Alaya keeps
  the soul barrels under P2-barrel-soul, so those tests import directly from the
  card-owned Garden files until the barrel card lands.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports Auditor,
GardenScheduler, compute providers, compute routing, and local heuristics, but
does not wire daemon startup, MCP, CLI, or live Garden scheduling surfaces.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-garden-batch-1):` commit per Anti-Tail Rule R4.
