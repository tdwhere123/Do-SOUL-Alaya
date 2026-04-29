# Task P2-svc-task-surface-builder-prelude Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-task-surface-builder-prelude.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/task-surface-builder.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/task-surface-builder.test.ts`
- Targets:
  - `packages/core/src/task-surface-builder.ts`
  - `packages/core/src/__tests__/task-surface-builder.test.ts`

No core barrel, Phase 3 run lifecycle service, daemon, MCP, CLI, GUI, or TUI
files were edited.

## Port Mode

Port mode: `trivial-copy`.

The target implementation and test were copied from the cited vendor paths.
Mechanical changes:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`

## Parity Evidence

Source existence check passed for all source paths in the task card.

Normalized vendor parity passed for the implementation and test after the
package alias rewrite.

## Verification

- Source existence check for all remaining Phase 2 closeout source paths - passed.
- Normalized vendor parity check for copied source/test files - passed.
- `rtk pnpm install` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "TaskSurfaceBuilder"` - passed; 1 file / 4 tests passed.

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of run, surface, event, and
  recall policy types.
- `TaskSurfaceBuilder` is available as an internal Phase 2 dependency for
  RecallService, but `packages/core/src/index.ts` remains owned by
  P3-core-barrel.
- The card does not start P3-run-lifecycle, ConversationService, daemon wiring,
  MCP, or CLI work.

## Intentional Deviations

None.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card only ports the
TaskSurfaceBuilder internal dependency and recall defaults; it does not create
any live event, MCP, or CLI surface.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-task-surface-builder-prelude):` commit per Anti-Tail Rule R4.
