# P3-mcp-discovery Completion Report

## Scope Compliance

- Card: `P3-mcp-discovery`
- Owned targets changed:
  - `packages/core/src/mcp-tool-discovery-service.ts`
  - `packages/core/src/extension-registry-service.ts`
  - `packages/core/src/__tests__/mcp-tool-discovery-service.test.ts`
  - `packages/core/src/__tests__/extension-registry-service.test.ts`
  - `docs/v0.1/phase-3-briefs/reports/task-p3-mcp-discovery.md`
- Forbidden shared barrels, phase status docs, package manifests, vendor files, and `node_modules` paths were not edited.

## Port Mode And Sources

- Port mode: `adapt-and-port`
- Source files copied from:
  - `vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts`

## Adapter Deviations

- Rewrote `@do-what/protocol` imports to `@do-soul/alaya-protocol`.
- Replaced optional `sseBroadcaster?.broadcastEntry(entry)` with optional `runtimeNotifier?.notifyEntry(entry)`.
- Adapted tests from `broadcastEntry` mocks to `notifyEntry` mocks.
- Added narrow mock invocation-order assertions proving EventLog append happens before notifier calls. No runtime behavior beyond the card adapter point was added.

## Verification

- `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` — pass
- `rtk pnpm build` — pass
- `rtk pnpm exec tsc --noEmit -p packages/core` — pass after build generated project-reference outputs
- `rtk pnpm exec vitest run --project @do-soul/alaya-core mcp-tool-discovery extension-registry` — pass, 2 files / 27 tests

## Architecture Compliance

- EventLog append remains before notify in both discovery and registry mutation paths.
- Alaya does not introduce SSE transport; the only notification dependency is the in-process `runtimeNotifier.notifyEntry` adapter.
- This card closes `implementation-ready` only. It does not claim daemon wiring, live MCP transport, `mcp-consumable`, or CLI parity.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

- P3-mcp-discovery is `implementation-ready`.
- P4-mcp-tooling / P4-mcp-memory-tools still own live daemon and MCP surface proof before any `mcp-consumable` claim.

## Post-Landing Note

Any later edit to this report or the task card must land as a separate `docs(P3-mcp-discovery):` commit per R4.
