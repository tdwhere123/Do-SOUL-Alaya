# P6-agent-use-protocol Completion Report

Status: mcp-consumable
Closed at commit: `b443c89`

## Scope compliance

This backfill maps the delivered scope to active Phase 6 card `P6-agent-use-protocol`: MCP/CLI loop ordering, tool discovery parity, pending proposal parity, and operator instructions/docs alignment.

## Build and test evidence

- Integration proof test added in delivered commit: `apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts`.
- Supporting end-to-end continuity: `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts`.
- Backfill verification command:
  - `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts`

## Closeout review/fix evidence (2026-05-06)

Round-1 closeout review found that the attached MCP path needed stronger
installed-profile proof, workspace-bound run context, and stdio lifecycle
evidence. The fix loop added:

- installed profile launcher resolution through `apps/core-daemon/src/profile-mutation.ts`;
- shared workspace-owned run validation through `resolveTrustedCliRunId`, used by
  `mcp stdio`, `tools call`, and `review --run`;
- `cli-register` coverage for attached MCP stdio startup, context delivery, and close.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm test` passed: 266 files, 2081 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-tools cli-review cli-register` passed after the shared run-validation fix: 55 files, 317 tests.
- Round-3 red-team re-review (`.do-it/phase-6-review/round-3/red-team-rt-b1.md`) closed the CLI fallback run/workspace finding with zero Blocking / Important findings.

## Architecture compliance

The card stays within MCP/CLI surfaces and governance boundaries (`docs/handbook/invariants.md` §19-§23). No benchmark acceptance behavior is required.

## Intentional deviations

The original backfill was documentation-only. The 2026-05-06 closeout
review/fix loop added targeted runtime hardening for profile launch,
workspace-bound MCP/CLI run context, and stdio lifecycle proof.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

Readiness label `mcp-consumable` is retained because the delivered test proves ordered MCP operations with CLI parity in one daemon lifetime.

## Post-landing note

Any later amendment must use a separate `docs(p6-agent-use-protocol):` commit touching both card and report.
