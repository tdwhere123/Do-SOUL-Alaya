# v0.3.5 Patch - CLI/MCP Quality Hardening

v0.3.5 is a patch-internal code-quality and runtime-reliability
release. It handles the real engineering issues from the SafeSkill
review without treating style-only or archive-only scanner output as
release scope.

## Version Boundary

v0.3.5 remains patch-internal. It does not touch:

- MCP tool names, descriptions, request schemas, or response schemas;
- protocol zod schemas;
- EventLog payload schemas;
- runtime control-plane config schemas;
- SQLite migrations.

Any future change to one of those surfaces must cite invariant 25 and
move out of this patch track before implementation.

## Scope

| Slice | Scope | Status |
|---|---|---|
| 1 | CLI shim loaders use fixed module slots while preserving test injection | implemented |
| 2 | MCP stdio startup failures produce stderr diagnostics and deterministic exit codes | implemented |
| 3 | Background service warnings route through injected loggers instead of bare console calls | implemented |
| 4 | Local execution support tightens non-shell probes, child-process env allowlists, timeout/error tests | implemented |
| 5 | Install docs, workspace version metadata, release notes, and closeout report | done |

## SafeSkill Handling

The old PR #1 only carried a badge from a stale scan. It is not a
source of release truth for v0.3.5 and should be closed rather than
merged into the README. Badges can be revisited only from a fresh
scan of the v0.3.5 HEAD.

This track intentionally does not create a broad false-positive report.
The durable record is limited to real code changes, verification
evidence, and the PR #1 closure reason.

## Required Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-register cli-bridge background-bootstrap tool-runtime mcp-runtime-registry environment-status-service keychain-adapters cli-inspect
rtk pnpm run hygiene:unused
rtk pnpm build
rtk pnpm test
rtk pnpm alaya doctor
rtk npm pack --dry-run
rtk git diff --check
```

See `release-notes.md` and `reports/v0.3.5-closeout.md`.
