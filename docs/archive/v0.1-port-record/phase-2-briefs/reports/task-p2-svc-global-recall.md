# Task P2-svc-global-recall Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-global-recall.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/global-memory-recall-port.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/global-memory-recall-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/global-memory-recall-service.test.ts`
- Targets:
  - `packages/core/src/global-memory-recall-port.ts`
  - `packages/core/src/global-memory-recall-service.ts`
  - `packages/core/src/__tests__/global-memory-recall-service.test.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/task-p2-svc-global-recall.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-svc-global-recall.md`
  - `docs/v0.1/INDEX.md`
  - `docs/handbook/runtime-status.md`
  - `docs/handbook/code-map.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation and tests were copied from the cited vendor paths.
The permitted adaptations are:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `global-memory-recall-service.test.ts` replaces the upstream import from
  `../recall-service.js` with a test-local copy of the same
  `classifyGlobalCandidate` body from the vendor `recall-service.ts`.

## Parity Evidence

Source existence check passed for all source paths in the task card.

The production target files match the vendor files after applying only the
package alias rewrite. The test target matches after the package alias rewrite
and the task-card test-boundary adapter point.

## Verification

- Source existence check for the three cited source/test paths - passed.
- Normalized vendor parity check - passed.
- `rtk pnpm install` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/global-memory-recall-service.test.ts` - passed.
- `rtk git diff --check` - passed.

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of global memory, project
  mapping, lifecycle, and scope types.
- The service remains a package-local recall helper and does not introduce
  daemon, MCP, CLI, GUI, TUI, or live surface wiring.
- `packages/core/src/index.ts` was not edited; P3-core-barrel still owns core
  service exports.
- The production GlobalMemoryRecallService contract still receives the global
  candidate classifier as an injected dependency, preserving the P2-svc-recall
  handoff.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because the
  vendor test imports `classifyGlobalCandidate` from `../recall-service.js`,
  while this card blocks P2-svc-recall and cannot depend on the not-yet-ported
  target file without creating a card cycle.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the
GlobalMemoryRecallService and global recall source port, but does not wire
RecallService, daemon startup, MCP, CLI, or live-event surfaces.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-global-recall):` commit per Anti-Tail Rule R4.
