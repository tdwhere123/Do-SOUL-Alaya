# P6-governance-accept-apply Completion Report

Status: live-event-ready
Closed at commit: `b443c89`

## Scope compliance

This report backfills evidence that proposal `accept` applies persisted `proposed_changes` through the governed durable path, with reviewer identity enforcement and parity across MCP/Inspector/CLI.

## Build and test evidence

- Storage migration and repo changes: `packages/storage/src/migrations/063-proposal-memory-update-patch.sql`, `packages/storage/src/repos/proposal-repo.ts`.
- Workflow/apply wiring: `apps/core-daemon/src/mcp-memory-proposal-workflow.ts`.
- Delivered tests:
  - `apps/core-daemon/src/__tests__/mcp-memory-governance.test.ts`
  - `apps/core-daemon/src/__tests__/proposal-review-parity.test.ts`
  - `packages/storage/src/__tests__/proposal-repo.test.ts`
  - `packages/storage/src/__tests__/proposal-repo-reviewer-identity.test.ts`

## Closeout review/fix evidence (2026-05-06)

Round-1 closeout review found that the storage primitive could accept a
proposal id while applying caller-supplied patch data for another memory.
The fix loop updated `packages/storage/src/repos/proposal-repo.ts` so
`acceptPendingMemoryUpdateWithEvents` reloads the pending proposal row
inside the transaction and verifies workspace, target kind, `derived_from`,
and stored `proposed_changes` before any review event or durable mutation.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage -- proposal` passed: 46 files, 344 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- agent-use-protocol mcp-memory-governance cli-tools cli-review cli-register profile-mutation attach-codex attach-claude cli-register garden-runtime daemon-runtime-lifecycle` passed: 55 files, 314 tests.

## Architecture compliance

Event/state path remains EventLog+audit governed and does not bypass core/governance invariants.

## Intentional deviations

The original backfill was documentation-only. The 2026-05-06 closeout
review/fix loop added a storage hardening patch and regression coverage
for proposal-payload mismatch.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

`live-event-ready` retained based on integration-style daemon governance tests and parity test proving one contract across MCP, Inspector HTTP, and CLI.

## Post-landing note

Any later amendment must use a separate `docs(p6-governance-accept-apply):` commit touching both card and report.
