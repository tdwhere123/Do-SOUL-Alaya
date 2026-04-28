# Task P2-security-2 Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-security-2.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/worker-safety-gate.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/worker-trust-assessor.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/stance-resolution-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/cross-cutting-permission-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/ports/tool-governance-client.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-safety-gate.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-trust-assessor.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/stance-resolution-service.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/cross-cutting-permission-service.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-governance-client.test.ts`
- Targets:
  - `packages/core/src/worker-safety-gate.ts`
  - `packages/core/src/worker-trust-assessor.ts`
  - `packages/core/src/stance-resolution-service.ts`
  - `packages/core/src/cross-cutting-permission-service.ts`
  - `packages/core/src/ports/tool-governance-client.ts`
  - `packages/core/src/__tests__/worker-safety-gate.test.ts`
  - `packages/core/src/__tests__/worker-trust-assessor.test.ts`
  - `packages/core/src/__tests__/stance-resolution-service.test.ts`
  - `packages/core/src/__tests__/cross-cutting-permission-service.test.ts`
  - `packages/core/src/__tests__/tool-governance-client.test.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/task-p2-security-2.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-security-2.md`
  - `docs/v0.1/phase-2-briefs/README.md`
  - `docs/v0.1/INDEX.md`
  - `docs/handbook/runtime-status.md`
  - `docs/handbook/code-map.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation and tests were copied from the cited vendor paths.
The permitted adaptations are:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `CrossCuttingPermissionSseBroadcaster` -> `CrossCuttingPermissionRuntimeNotifier`
- dependency property `sseBroadcaster` -> `runtimeNotifier`
- method call `broadcastEntry(entry)` -> `notifyEntry(entry)`
- test-only `ToolGovernanceClient` import from `../index.js` ->
  `../ports/tool-governance-client.js`

## Parity Evidence

Source existence check passed for all source paths in the task card.

The target files match the vendor files after applying only the package alias
rewrite, the task-card SSE-to-runtime-notifier adapter point, and the
task-card core-barrel test-boundary adapter point.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/worker-safety-gate.ts','vendor/do-what-new-snapshot/packages/core/src/worker-trust-assessor.ts','vendor/do-what-new-snapshot/packages/core/src/stance-resolution-service.ts','vendor/do-what-new-snapshot/packages/core/src/cross-cutting-permission-service.ts','vendor/do-what-new-snapshot/packages/core/src/ports/tool-governance-client.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-safety-gate.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-trust-assessor.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/stance-resolution-service.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/cross-cutting-permission-service.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-governance-client.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- Normalized vendor parity check - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core worker-safety worker-trust stance-resolution cross-cutting` - passed; 4 files / 19 tests passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/tool-governance-client.test.ts` - passed; 1 file / 8 tests passed
- `rtk git diff --check` - passed

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of worker safety, trust,
  stance, cross-cutting permission, and tool-governance types.
- Upstream SSE terminology is removed from CrossCuttingPermissionService.
  Notification is represented as an in-process `runtimeNotifier.notifyEntry`
  port only.
- `packages/core/src/index.ts` was not edited; the tool-governance client test
  uses the card-owned `ports/tool-governance-client.ts` boundary until
  P3-core-barrel.
- No daemon, MCP, CLI, GUI, TUI, or live surface was introduced.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because
  CrossCuttingPermissionService contains an SSE broadcaster dependency and the
  copied tool-governance client test imports through the P3-owned core barrel.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the worker
safety, worker trust, stance resolution, cross-cutting permission, and
tool-governance client units plus tests, but does not wire daemon, MCP, CLI, or
ConversationService live paths.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-security-2):` commit per Anti-Tail Rule R4.
