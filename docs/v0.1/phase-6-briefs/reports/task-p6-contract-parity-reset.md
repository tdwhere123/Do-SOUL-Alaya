# P6-contract-parity-reset Completion Report

Status: docs-truth-ready
Closed at commits: `b443c89`, `592a7a5`

## Scope compliance

This backfill ties together the delivered contract reset across README surfaces, v0.1 index, runtime status, glossary, and Phase 6 plan semantics.

## Build and test evidence

- Doc surfaces changed in delivered commits:
  - `README.md`
  - `README.zh-CN.md`
  - `docs/v0.1/INDEX.md`
  - `docs/handbook/runtime-status.md`
  - `docs/handbook/glossary.md`
  - `docs/v0.1/phase-6-briefs/README.md`
- Verification sweeps:
  - `rtk git diff --name-status b443c89^..592a7a5`
  - targeted `rtk rg` checks for Phase 6 charter/gate wording and benchmark archival boundary.

## Closeout review/fix evidence (2026-05-06)

Round-1 closeout review found one public-language mismatch: README
surfaces described the Trustworthy Memory Loop as candidate-first, while
the runnable Phase 6 operator path is recall-first. The fix loop aligned
`README.md` and `README.zh-CN.md` to the sequence used by the MCP proof:
recall delivery -> usage receipt -> candidate signal -> proposal ->
accepted proposal -> durable memory application -> post-apply recall /
usage proof.

Fresh verification:

- `rtk pnpm build` passed.
- `rtk pnpm test` passed: 266 files, 2081 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol -- mcp-types` passed: 63 files, 535 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage -- proposal` passed: 46 files, 344 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -- memory-service recall workspace-service` passed: 70 files, 637 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-tools cli-review cli-register` passed after the shared run-validation fix: 55 files, 317 tests.
- `rtk pnpm --dir apps/core-daemon pack --dry-run --json` passed after build and included `bin/alaya.mjs` plus `dist/**`.
- Isolated `/tmp` profile smoke passed for `alaya --help`, `alaya install --non-interactive --json`, `alaya attach codex --yes --json`, `alaya tools list --json`, and `alaya mcp stdio`. `alaya doctor` exited 75 only because no embedding provider is configured; runtime, storage, MCP transport, and Garden were ready/healthy.

## Architecture compliance

Terminology remains aligned with invariants and keeps active acceptance centered on MCP Agent-Use Protocol plus Trustworthy Memory Loop.

## Intentional deviations

The original backfill was documentation-only. The 2026-05-06 closeout
review/fix loop added wording fixes plus the runtime/test hardening
needed to make the docs claims release-proven.

## Deferred issues

Nothing deferred.

## Follow-up readiness impact

`docs-truth-ready` retained for documentation parity. No benchmark acceptance text is used for active Phase 6 cards/reports.

## Post-landing note

Any later amendment must use a separate `docs(p6-contract-parity-reset):` commit touching both card and report.
