# P6-live-agent-proof Completion Report

Status: live-event-ready
Closed at commit: `b443c89` (with startup-path support in `592a7a5`)

## Scope compliance

Backfill confirms a deterministic harness exists for one-daemon-lifetime proof of tool discovery, ordered MCP calls, usage receipt, proposal review/apply, and post-apply recall path.

## Build and test evidence

- Primary harness: `apps/core-daemon/src/__tests__/agent-use-protocol.test.ts`.
- Supporting E2E harness: `apps/core-daemon/src/__tests__/e2e/release-loop.test.ts`.
- Legacy attach proof continuity: `apps/core-daemon/src/__tests__/attached-agent-mcp-proof.test.ts`.

## Closeout review/fix evidence (2026-05-06)

Round-1 closeout review kept the deterministic harness requirement but
required stronger public-path proof around install/profile launch, MCP
stdio lifecycle, and workspace-bound run context. The fix loop added
profile-mutation tests for installed package layout, `cli-register`
tests for stdio startup/close and `ALAYA_RUN_ID` trust, shared
`resolveTrustedCliRunId` validation for CLI fallback paths, and retained
the one-daemon-lifetime Phase 6 proof.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm test` passed: 266 files, 2081 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-tools cli-review cli-register` passed after the shared run-validation fix: 55 files, 317 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/mcp-memory-tool-handler.test.ts apps/core-daemon/src/__tests__/agent-use-protocol.test.ts` passed in Round-3 red-team re-review: 2 files, 9 tests.
- Isolated `alaya mcp stdio` smoke exited 0 and started Janitor, Auditor,
  Librarian, and GardenScheduler background services.

## Architecture compliance

Evidence stays on live daemon/MCP/CLI path and preserves explicit governance/promotion boundaries.

## Intentional deviations

The original backfill was documentation-only. The 2026-05-06 closeout
review/fix loop added targeted runtime/test hardening for the same live
agent path.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

`live-event-ready` retained because delivered integration proofs execute ordered live path behavior, including workspace-scoped review checks.

## Post-landing note

Any later amendment must use a separate `docs(p6-live-agent-proof):` commit touching both card and report.
