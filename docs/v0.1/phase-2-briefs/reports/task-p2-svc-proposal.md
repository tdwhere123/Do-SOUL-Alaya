# Task P2-svc-proposal Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-proposal.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/proposal-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/proposal-service.test.ts`
- Targets:
  - `packages/core/src/proposal-service.ts`
  - `packages/core/src/__tests__/proposal-service.test.ts`

No shared barrels, daemon, MCP, CLI, GUI, TUI, or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation and test were copied from the cited vendor paths.
Mechanical changes and adapter points:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `ProposalSseBroadcaster` -> `ProposalRuntimeNotifier`
- dependency property `sseBroadcaster` -> `runtimeNotifier`
- method call `broadcastEntry(entry)` -> `notifyEntry(entry)`
- `deferredBroadcastEvents` -> `deferredNotificationEvents`

## Parity Evidence

Source existence check passed for all source paths in the task card.

Normalized vendor parity passed for the implementation and test after the
package alias rewrite and declared SSE-to-runtime-notifier adapter points.

## Verification

- Source existence check for all remaining Phase 2 closeout source paths - passed.
- Normalized vendor parity check for copied source/test files - passed.
- `rtk pnpm install` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "ManifestationResolver|SynthesisService|ProposalService"` - passed; ProposalService file / 10 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` - passed; 32 files / 266 tests passed.
- `rtk rg -n "SseBroadcaster|EventSource|text/event-stream" packages --glob '!vendor/**'` - passed after adapter fix; no package runtime matches.

## Architecture Compliance

- Proposal remains a core package service and uses protocol-owned proposal,
  memory, synthesis, and event types.
- Upstream SSE contract names are adapted to in-process runtime notification
  ports per invariant §11.
- The port does not add daemon, MCP, CLI, GUI, TUI, or live surface wiring.
- `packages/core/src/index.ts` was not edited; P3-core-barrel still owns core
  exports.

## Intentional Deviations

- Upstream `ProposalSseBroadcaster` / `broadcastEntry` naming is intentionally
  replaced by runtime notifier naming because Alaya Phase 2 has no SSE
  transport surface.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports
ProposalService, but does not claim live consumption.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-proposal):` commit per Anti-Tail Rule R4.
