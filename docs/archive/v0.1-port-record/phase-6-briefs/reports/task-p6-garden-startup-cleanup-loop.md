# P6-garden-startup-cleanup-loop Completion Report

Status: live-event-ready
Closed at commit: `592a7a5`

## Scope compliance

Backfill covers the delivered startup lifecycle behavior: Garden services start once through attach/runtime path and trigger one startup cleanup pass.

## Build and test evidence

- Runtime lifecycle wiring: `apps/core-daemon/src/daemon-runtime-lifecycle.ts`, `apps/core-daemon/src/index.ts`, `apps/core-daemon/src/garden-runtime.ts`.
- Delivered tests:
  - `apps/core-daemon/src/__tests__/daemon-runtime-lifecycle.test.ts`
  - `apps/core-daemon/src/__tests__/garden-runtime.test.ts`
  - `apps/core-daemon/src/__tests__/cli-register.test.ts`

## Closeout review/fix evidence (2026-05-06)

Round-1 closeout review found that the real `alaya mcp stdio` command
needed explicit startup/close lifecycle proof rather than only direct
runtime helper proof. The fix loop added `cli-register` assertions that
the attached MCP stdio command starts background services, passes the
workspace/run context into the MCP server, and calls server close when
the stdio input closes.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- agent-use-protocol mcp-memory-governance cli-tools cli-review cli-register profile-mutation attach-codex attach-claude cli-register garden-runtime daemon-runtime-lifecycle` passed: 55 files, 314 tests.

## Architecture compliance

Garden remains fire-and-forget relative to main path, with explicit lifecycle start/stop controls.

## Intentional deviations

The original backfill was documentation-only. The 2026-05-06 closeout
review/fix loop added command-surface lifecycle coverage for attached
MCP stdio.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

`live-event-ready` retained because lifecycle tests assert one-time startup and cleanup pass invocation on live daemon controls.

## Post-landing note

Any later amendment must use a separate `docs(p6-garden-startup-cleanup-loop):` commit touching both card and report.
