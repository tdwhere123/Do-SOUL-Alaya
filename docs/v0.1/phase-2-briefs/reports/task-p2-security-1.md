# Task P2-security-1 Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-security-1.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/permission-policy/`
  - `vendor/do-what-new-snapshot/packages/core/src/zero-day-security-layer.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/constraint-proxy.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/integration-gate.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/permission-policy.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/zero-day-security-layer.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/constraint-proxy.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/integration-gate.test.ts`
- Targets:
  - `packages/core/src/permission-policy/`
  - `packages/core/src/zero-day-security-layer.ts`
  - `packages/core/src/constraint-proxy.ts`
  - `packages/core/src/integration-gate.ts`
  - `packages/core/src/__tests__/permission-policy.test.ts`
  - `packages/core/src/__tests__/zero-day-security-layer.test.ts`
  - `packages/core/src/__tests__/constraint-proxy.test.ts`
  - `packages/core/src/__tests__/integration-gate.test.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/task-p2-security-1.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-security-1.md`
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
- test-only permission-policy import from `../index.js` ->
  `../permission-policy/index.js`

## Parity Evidence

Source existence check passed for all source paths in the task card.

The target files match the vendor files after applying only the package alias
rewrite and the task-card core-barrel test-boundary adapter point.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/permission-policy/','vendor/do-what-new-snapshot/packages/core/src/zero-day-security-layer.ts','vendor/do-what-new-snapshot/packages/core/src/constraint-proxy.ts','vendor/do-what-new-snapshot/packages/core/src/integration-gate.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/permission-policy.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/zero-day-security-layer.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/constraint-proxy.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/integration-gate.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- Normalized vendor parity check - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core permission-policy zero-day constraint-proxy integration-gate` - passed; 4 files / 34 tests passed
- `rtk git diff --check` - passed

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of permission, stance,
  worker-security, EventLog, and trust-state types.
- `packages/core/src/index.ts` was not edited; the permission-policy test uses
  the card-owned `permission-policy/index.ts` boundary until P3-core-barrel.
- No daemon, MCP, CLI, GUI, TUI, or live surface was introduced.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because the
  copied vendor permission-policy test imports through the core package barrel.
  P3-core-barrel owns `packages/core/src/index.ts`, so the target test imports
  from the card-owned permission-policy barrel instead.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the
permission policy and zero-day defense stack plus tests, but does not wire them
into daemon, MCP, CLI, or ConversationService live paths.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-security-1):` commit per Anti-Tail Rule R4.
