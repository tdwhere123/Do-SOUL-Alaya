# Task P2-svc-event-publisher Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-event-publisher.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/event-publisher.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer-state.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/event-publisher.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/runtime-event-normalizer.test.ts`
- Targets:
  - `packages/core/src/event-publisher.ts`
  - `packages/core/src/runtime-event-normalizer.ts`
  - `packages/core/src/runtime-event-normalizer-state.ts`
  - `packages/core/src/__tests__/event-publisher.test.ts`
  - `packages/core/src/__tests__/runtime-event-normalizer.test.ts`

No core barrel, root config, storage files, daemon files, MCP, CLI, GUI, TUI, or
future Phase 3+ surfaces were edited. The task card was updated before commit to
include the normalizer state dependency and the narrow run-hot-state port
adapter.

## Port Mode

Port mode: `requires-redesign`.

The implementation starts from the vendor source but applies the required Alaya
redesign:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `sseBroadcaster` dependency -> `runtimeNotifier` in-process notification port
- `broadcastEntry` calls -> `notifyEntry` calls
- concrete `RunHotStateService` import -> local `RunHotStateApplierPort`
  interface with `apply(Phase0Event)`
- SSE/reconnect wording in tests and comments -> in-process listener wording

`runtime-event-normalizer-state.ts` was copied unchanged from the vendor source.

## Verification

- Source existence check for the five cited source/test paths - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "EventPublisher|RuntimeEventNormalizer"` - passed; 2 files / 26 tests passed.

## Review Fixes

- Fixed review Blocking finding B1 for `RuntimeEventNormalizer`: notify failure
  after durable append now throws `RuntimeEventNormalizerPropagationError` with
  the appended entry attached, and retry re-notifies the pending durable entry
  instead of appending a duplicate or suppressing notification.
- Fixed review Important finding I1 for `publishManyWithMutation`: batch
  propagation failure now exposes the full durable batch through
  `EventPublisherPropagationError.entries`, and tests cover mutation rollback,
  partial append rollback, and post-mutation propagation failure.

## Architecture Compliance

- Alaya does not introduce SSE transport. Target code/tests contain no
  `sseBroadcaster`, `SseBroadcaster`, or `broadcastEntry` runtime dependency.
- Event propagation remains append first, optional run-hot-state apply for
  Phase 0 events, then in-process notification.
- Mutation failure still deletes unnotified EventLog entries before any
  in-process listener can observe false history.
- Propagation failure still surfaces `EventPublisherPropagationError` with the
  durable entry attached so callers know the EventLog append already happened;
  batch propagation failure also exposes the full appended batch.
- Runtime normalization notify failure surfaces the appended entry and preserves
  a pending in-process notification retry path for the durable entry.
- No daemon, MCP, CLI, GUI, or TUI surface was introduced.

## Intentional Deviations

- The concrete upstream `RunHotStateService` import is replaced by a narrow
  local port because P3-run-lifecycle owns the concrete run hot-state service.
- Runtime notification is an in-process port instead of SSE, per invariant §11.
- The task card source list was repaired to include
  `runtime-event-normalizer-state.ts`, which is a direct source dependency of
  `runtime-event-normalizer.ts`.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card provides the
in-package event publishing/normalization behavior needed by later Phase 2
services, but it does not wire daemon startup, MCP, CLI, or live-event surfaces.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-event-publisher):` commit per Anti-Tail Rule R4.
