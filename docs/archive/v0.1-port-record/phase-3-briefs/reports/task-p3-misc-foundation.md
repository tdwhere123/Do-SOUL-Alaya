# Task P3-misc-foundation Report

## Scope Compliance

- Owned files only: `packages/core/src/tool-spec-service.ts`, `packages/core/src/strong-ref-service.ts`, `packages/core/src/dirty-state-panic-service.ts`, `packages/core/src/file-path.ts`, `packages/core/src/message-history.ts`, the three owned core tests, and this report.
- Did not edit shared barrels, phase status docs, package manifests, or `vendor/**`.

## Port Mode And Sources

Port mode: `adapt-and-port`.

- `vendor/do-what-new-snapshot/packages/core/src/tool-spec-service.ts` -> `packages/core/src/tool-spec-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/strong-ref-service.ts` -> `packages/core/src/strong-ref-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/dirty-state-panic-service.ts` -> `packages/core/src/dirty-state-panic-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/file-path.ts` -> `packages/core/src/file-path.ts`
- `vendor/do-what-new-snapshot/packages/core/src/message-history.ts` -> `packages/core/src/message-history.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-spec-service.test.ts` -> `packages/core/src/__tests__/tool-spec-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/strong-ref-service.test.ts` -> `packages/core/src/__tests__/strong-ref-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/dirty-state-panic-service.test.ts` -> `packages/core/src/__tests__/dirty-state-panic-service.test.ts`

## Adapter Deviations

- Package imports were rewritten from `@do-what/protocol` to `@do-soul/alaya-protocol`.
- `dirty-state-panic-service.ts` uses the already-ported Alaya `EventPublisher` type, whose notification path is `RuntimeNotifier.notifyEntry`.
- `dirty-state-panic-service.ts` replaces the vendor type-only `WorkerRunLifecycleService` import with a local structural `DirtyStatePanicWorkerRunLifecyclePort` exposing `freeze(...)`. This keeps the foundation card compilable before `P3-run-lifecycle` owns `packages/core/src/worker-run-lifecycle-service.ts`, without changing call ordering or behavior.

## Verification

Passed in `/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p3-misc-foundation`:

- source existence check from the task card
- `rtk git diff --check`
- `rtk pnpm build`
- `rtk pnpm exec tsc --noEmit -p packages/core`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core tool-spec strong-ref dirty-state`
  - 3 test files passed
  - 23 tests passed

Worktree note: verification required temporary local `node_modules` symlinks
from the main checkout because this isolated worktree did not have its own
dependency links. Those symlinks were removed before commit.

## Architecture Compliance

- No SSE transport or broadcaster dependency was introduced.
- Dirty-state panic still uses EventLog-first `publishWithMutation` semantics and rollback of the dossier row on freeze failure.
- This card closes as `implementation-ready`; no `live-event-ready`, MCP, CLI, or daemon wiring is claimed.

## Deferrals

Nothing deferred.

## Follow-Up Readiness Impact

This card unblocks `P3-mcp-discovery`, `P3-run-lifecycle`, `P3-conversation`, `P3-misc-services`, and `P3-core-barrel` at the helper-file level. Public exports remain owned by `P3-core-barrel`.

## Post-Landing Note

Any later edit to this report or its task card must land as a separate `docs(P3-misc-foundation):` commit per R4.
