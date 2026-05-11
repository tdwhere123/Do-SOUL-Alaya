# Task P3-run-lifecycle Report

## Scope Compliance

- Owned files only: the seven run lifecycle / serial delegation service files, the scripted runtime test double, the seven owned tests, and this report.
- Did not edit `packages/core/src/index.ts`, `packages/core/src/task-surface-builder.ts`, phase status docs, package manifests, `vendor/**`, or any `node_modules` path.

## Port Mode And Sources

Port mode: `adapt-and-port`.

- `vendor/do-what-new-snapshot/packages/core/src/worker-run-lifecycle-service.ts` -> `packages/core/src/worker-run-lifecycle-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/worker-run-state-machine.ts` -> `packages/core/src/worker-run-state-machine.ts`
- `vendor/do-what-new-snapshot/packages/core/src/run-service.ts` -> `packages/core/src/run-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/run-hot-state-service.ts` -> `packages/core/src/run-hot-state-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-service.ts` -> `packages/core/src/serial-delegation-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-event-intake.ts` -> `packages/core/src/serial-delegation-event-intake.ts`
- `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-recovery.ts` -> `packages/core/src/serial-delegation-recovery.ts`
- `vendor/do-what-new-snapshot/packages/core/src/test-doubles/scripted-runtime-adapter.ts` -> `packages/core/src/test-doubles/scripted-runtime-adapter.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-lifecycle-service.test.ts` -> `packages/core/src/__tests__/worker-run-lifecycle-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-state-machine.test.ts` -> `packages/core/src/__tests__/worker-run-state-machine.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/run-service.test.ts` -> `packages/core/src/__tests__/run-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/run-hot-state-service.test.ts` -> `packages/core/src/__tests__/run-hot-state-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-service.test.ts` -> `packages/core/src/__tests__/serial-delegation-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-event-intake.test.ts` -> `packages/core/src/__tests__/serial-delegation-event-intake.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-recovery.test.ts` -> `packages/core/src/__tests__/serial-delegation-recovery.test.ts`

## Adapter Deviations

- Package imports were rewritten from `@do-what/protocol` to `@do-soul/alaya-protocol`.
- `serial-delegation-service.ts` keeps only the protocol-level `AgentRuntimePort` injection / factory seam. It does not import concrete runtime adapters or Claude SDK implementations.
- Strong-ref and dirty-state behavior uses the already-ported `StrongRefService` and `DirtyStatePanicService` ports; no helper logic was inlined or duplicated.
- `serial-delegation-service.test.ts` imports `CoreError`, `EventPublisher`, and `WorkerRunLifecycleService` from their direct owned source files instead of the shared core barrel because `packages/core/src/index.ts` is explicitly owned by `P3-core-barrel`.
- `run-service.test.ts` adds a minimal `runRepo.update` test double method required by the ported `RunRepoPort` shape.
- `serial-delegation-service.test.ts` adds an explicit runtime-event handler type on the local fake adapter to satisfy Alaya's current strict TypeScript settings.

## Verification

Passed in `/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p3-run-lifecycle`:

- source existence check from the task card
- `rtk pnpm build`
- `rtk pnpm exec tsc --noEmit -p packages/core`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core run-service worker-run serial-delegation task-surface`
  - 7 test files passed
  - 87 tests passed

Additional targeted coverage:

- `rtk pnpm exec vitest run --project @do-soul/alaya-core run-hot-state-service`

Final hygiene checks are recorded in the closeout response.

Worktree note: this isolated worktree had pre-existing untracked
`node_modules` symlinks for verification. They were not edited, added, or
committed.

## Architecture Compliance

- EventLog-first lifecycle transitions remain in `WorkerRunLifecycleService` through `EventPublisher.publishWithMutation`.
- Run hot state remains in-process implementation-ready state only; no SSE, daemon, MCP, or CLI surface is introduced by this card.
- Serial delegation keeps runtime adapter behavior behind the protocol port
  seam. Chat worker dispatch runtime behavior is product-scope pruned because
  Alaya exposes memory through MCP and plain CLI, not upstream chat sessions.
- This card closes as `implementation-ready`; no `live-event-ready`, `mcp-consumable`, or `cli-consumable` claim is made.

## Pruned Scope

- Chat-specific worker dispatch runtime behavior is not ported and is not a
  backlog item. It is outside the Alaya memory plugin core.

## Follow-Up Readiness Impact

This card unblocks `P3-conversation`, `P4-routes-workspace`, and
`P3-core-barrel` at the run lifecycle / serial delegation implementation
level. Public exports remain owned by `P3-core-barrel`.

## Post-Landing Note

Any later edit to this report or its task card must land as a separate
`docs(P3-run-lifecycle):` commit per R4.
