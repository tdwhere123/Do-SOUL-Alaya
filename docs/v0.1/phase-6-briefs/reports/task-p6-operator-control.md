# P6-operator-control Completion Report

Status: cli-consumable
Closed at commits: `b443c89`, `592a7a5`

## Scope compliance

This card is backfilled against delivered CLI and tool-catalog contract hardening: explicit review surface, generic tool-call guardrails, and operator-facing wording alignment.

## Build and test evidence

- CLI/tool files: `apps/core-daemon/src/cli/tools.ts`, `apps/core-daemon/src/cli/review.ts`, `apps/core-daemon/src/cli/status.ts`, `apps/core-daemon/src/mcp-memory-tool-catalog.ts`.
- Delivered tests:
  - `apps/core-daemon/src/__tests__/cli-tools.test.ts`
  - `apps/core-daemon/src/__tests__/cli-review.test.ts`
- Doc parity surfaces: `README.md`, `README.zh-CN.md`.

## Closeout review/fix evidence (2026-05-06)

Round-1 closeout review found public README wording that implied a
candidate-first flow, while the runnable Phase 6 operator protocol is
recall-first. The fix loop aligned `README.md` and `README.zh-CN.md` to:
recall delivery -> usage receipt -> candidate signal -> proposal ->
accepted proposal -> durable memory application -> post-apply recall /
usage proof.

Round-2 red-team review then found that CLI fallback paths still accepted
unbound run ids. The follow-up fix moved trusted run validation into the
shared `resolveTrustedCliRunId` helper, so `tools call`, explicit `--run`,
`ALAYA_RUN_ID`, `review --run`, and `mcp stdio` now bind run identity to
the resolved workspace before stateful memory-tool context is built.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm test` passed: 266 files, 2081 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-tools cli-review cli-register` passed after the shared run-validation fix: 55 files, 317 tests.
- `rtk rg -n "P6-|Gate-6|benchmark|current-directory|Garden startup|usage receipt|durable memory" docs/v0.1/phase-6-briefs docs/v0.1/INDEX.md docs/handbook/runtime-status.md README.md README.zh-CN.md` was run as the docs wording sweep.
- Isolated CLI smoke with `/tmp` `ALAYA_CONFIG_DIR`, `DATA_DIR`, and
  `CODEX_HOME` passed for `alaya install --non-interactive --json`,
  `alaya attach codex --yes --json`, `alaya tools list --json`, and
  `alaya mcp stdio`; `alaya doctor` exited 75 only because no embedding
  provider is configured, with runtime/storage/MCP ready and Garden healthy.

## Architecture compliance

Surface behavior preserves MCP/CLI parity and human-review governance boundaries per invariants §21-§23.

## Intentional deviations

The original backfill was documentation-only. The 2026-05-06 closeout
review/fix loop updated public wording and CLI trust validation so
operator-control language matches the recall-first MCP/CLI path.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

`cli-consumable` retained because command semantics and guardrails are tested and documented together.

## Post-landing note

Any later amendment must use a separate `docs(p6-operator-control):` commit touching both card and report.
