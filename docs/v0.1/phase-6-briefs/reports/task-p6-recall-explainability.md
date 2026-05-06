# P6-recall-explainability Completion Report

Status: schema-ready
Closed at commit: `b443c89`

## Scope compliance

Backfill confirms recall explainability fields were added and wired through protocol/core/daemon MCP response shapes.

## Build and test evidence

- Protocol contracts: `packages/protocol/src/soul/recall-candidate.ts`, `packages/protocol/src/soul/mcp-types.ts`.
- Core compute path: `packages/core/src/recall-service.ts`.
- Daemon response shaping: `apps/core-daemon/src/mcp-memory-tool-handler.ts`.
- Delivered tests:
  - `packages/protocol/src/__tests__/recall-candidate.test.ts`
  - `packages/protocol/src/__tests__/dynamics-mcp-events.test.ts`
  - `packages/core/src/__tests__/recall-service.test.ts`

## Closeout review/fix evidence (2026-05-06)

No round-1 closeout finding required recall-explainability code changes.
Fresh verification reconfirmed that the recall contracts still pass after
the governance, workspace, profile, and MCP stdio hardening fixes.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol -- mcp-types` passed: 63 files, 535 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -- memory-service recall workspace-service` passed: 70 files, 637 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- phase6-agent-use-protocol mcp-memory-governance cli-tools cli-review cli-register profile-mutation attach-codex attach-claude cli-register garden-runtime daemon-runtime-lifecycle` passed: 55 files, 314 tests.

## Architecture compliance

Explainability fields are schema-governed and remain recall metadata, not durable-memory promotion bypass.

## Intentional deviations

No runtime code changes in this backfill; documentation only.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

Readiness remains `schema-ready` (not raised) because this card’s closeout target is contract stability for explainability fields.

## Post-landing note

Any later amendment must use a separate `docs(p6-recall-explainability):` commit touching both card and report.
