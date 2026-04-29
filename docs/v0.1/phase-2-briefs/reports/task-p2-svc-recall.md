# Task P2-svc-recall Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-recall.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/recall-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-service.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-global-filter.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-8factor.test.ts`
- Targets:
  - `packages/core/src/recall-service.ts`
  - `packages/core/src/__tests__/recall-service.test.ts`
  - `packages/core/src/__tests__/recall-global-filter.test.ts`
  - `packages/core/src/__tests__/recall-8factor.test.ts`

No shared barrels, daemon, MCP, CLI, GUI, TUI, or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `trivial-copy`.

The target implementation and tests were copied from the cited vendor paths.
Mechanical changes:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`

## Parity Evidence

Source existence check passed for all source paths in the task card.

Normalized vendor parity passed for the implementation and tests after the
package alias rewrite.

## Verification

- Source existence check for all remaining Phase 2 closeout source paths - passed.
- Normalized vendor parity check for copied source/test files - passed.
- `rtk pnpm install` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "RecallService"` - passed; 4 recall-side files / 38 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` - passed; 32 files / 266 tests passed.

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of recall, context lens,
  memory, evidence, and event types.
- Recall uses the Phase 2 prelude `TaskSurfaceBuilder` defaults without adding
  any P3 run lifecycle ownership.
- `packages/core/src/index.ts` was not edited; P3-core-barrel still owns core
  exports.

## Intentional Deviations

None.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. RecallService is ported and
unit-tested, but daemon startup, MCP, CLI, and live-event wiring remain later
phase work.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-recall):` commit per Anti-Tail Rule R4.
