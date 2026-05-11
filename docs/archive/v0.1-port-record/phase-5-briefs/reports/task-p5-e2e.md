# Task P5-e2e Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-5-briefs/task-p5-e2e.md`
- Port mode: `requires-redesign`
- Sources used: `n/a`
- Targets changed:
  - `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts`

No daemon runtime, MCP server, CLI command implementation, storage, protocol,
core, vendor, or shared barrel files were changed.

## Redesign Summary

`v0.1-release-loop.test.ts` reuses the Gate-4 single-daemon pattern:

- isolated `DATA_DIR`, `ALAYA_CONFIG_DIR`, `CODEX_HOME`, and `HOME`
- seeded SQLite fixture with one active workspace, run, and memory entry
- one `createAlayaDaemonRuntime()` lifetime
- MCP SDK `InMemoryTransport`
- direct CLI dispatch through `createAlayaCliBridge()` and registered commands

The test proves:

- `alaya install` and `alaya attach codex`
- MCP `tools/list` returns the exact `ALAYA_MEMORY_TOOL_NAMES` `soul.*`
  catalog with no legacy `memory.*` tool names
- CLI `alaya tools list --json` matches the MCP catalog
- MCP `soul.recall -> soul.open_pointer -> soul.report_context_usage`
  records and verifies a delivery id and usage proof
- CLI `alaya tools call soul.open_pointer --json` returns the same pointer
  contract as MCP
- candidate signal emission persists to storage
- proposal creation plus governance reject leaves the original durable memory
  content and timestamp unchanged
- Garden background pass emits EventLog and health-journal evidence
- `alaya status` and `alaya doctor` report the configured, delivered, used,
  and healthy runtime state
- `alaya backup` and `alaya export` write portable bundles with database
  payloads

## Verification

- `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('source paths ok')"` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p apps/core-daemon` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon e2e` -
  passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon gate4-attached-agent-mcp-proof` -
  passed.
- `rtk git diff --check` - passed.

## Deviations

- None.

## Deferred Issues

Nothing deferred.

## Readiness Impact

P5-e2e closes as `live-event-ready`. It proves the v0.1 release-critical
MCP and CLI memory loop in one daemon lifetime. It does not close Gate-5 by
itself; P5-final-review still must run and report zero Blocking / Important
findings.

## Post-Landing Note

Any later edit to this report must land as a separate `docs(P5-e2e):` commit
per Anti-Tail Rule R4.
