# P6-cwd-workspace-startup Completion Report

Status: cli-consumable
Closed at commit: `592a7a5`

## Scope compliance

This report backfills delivered cwd-first workspace startup behavior with explicit override precedence and implicit local workspace registration.

## Build and test evidence

- Workspace context resolver: `apps/core-daemon/src/cli/workspace-context.ts`.
- CLI integration points: `apps/core-daemon/src/cli/register.ts`, `apps/core-daemon/src/cli/tools.ts`, `apps/core-daemon/src/cli/review.ts`, `apps/core-daemon/src/cli/doctor.ts`.
- Core workspace support: `packages/core/src/workspace-service.ts`.
- Delivered tests:
  - `apps/core-daemon/src/__tests__/cli-register.test.ts`
  - `apps/core-daemon/src/__tests__/cli-tools.test.ts`
  - `packages/core/src/__tests__/workspace-service.test.ts`

## Closeout review/fix evidence (2026-05-06)

Round-1 closeout review found a first-start race in implicit local
workspace registration. The fix loop updated
`packages/core/src/workspace-service.ts` so `ensureLocalWorkspace`
handles a duplicate workspace-id create collision by re-reading and
returning the already-persisted local workspace while preserving other
errors.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -- workspace-service` passed: 70 files, 637 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -- memory-service recall workspace-service` passed: 70 files, 637 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- agent-use-protocol mcp-memory-governance cli-tools cli-review cli-register profile-mutation attach-codex attach-claude cli-register garden-runtime daemon-runtime-lifecycle` passed: 55 files, 314 tests.

## Architecture compliance

Workspace scoping defaults to caller context and preserves explicit override controls.

## Intentional deviations

The original backfill was documentation-only. The 2026-05-06 closeout
review/fix loop added a core idempotency fix for concurrent cwd-derived
local workspace startup.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

`cli-consumable` retained because startup workspace resolution rules are coded centrally and asserted by CLI tests.

## Post-landing note

Any later amendment must use a separate `docs(p6-cwd-workspace-startup):` commit touching both card and report.
