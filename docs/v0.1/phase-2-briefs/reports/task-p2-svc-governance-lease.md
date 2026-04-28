# Task P2-svc-governance-lease Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-governance-lease.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/governance-lease-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/governance-lease-service.test.ts`
- Targets:
  - `packages/core/src/governance-lease-service.ts`
  - `packages/core/src/__tests__/governance-lease-service.test.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/reports/task-p2-svc-governance-lease.md`
  - `docs/handbook/runtime-status.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `trivial-copy`.

The target implementation and source test were copied from the cited vendor
paths. The only permitted adaptation is:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`

## Parity Evidence

Source existence check passed for:

- `vendor/do-what-new-snapshot/packages/core/src/governance-lease-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/governance-lease-service.test.ts`

The target files match the vendor files after applying only the package alias
rewrite.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/governance-lease-service.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/governance-lease-service.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- Normalized vendor parity check - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "GovernanceLeaseService"` - passed; 1 file / 10 tests passed
- `rtk git diff --check` - passed

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of governance lease and EventLog
  protocol types.
- EventLog append precedes cache mutation in acquire/release/pierce paths,
  preserving source ordering.
- No SSE, daemon, MCP, CLI, GUI, or TUI surface was introduced.

## Intentional Deviations

None.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the
GovernanceLeaseService implementation and tests, but does not wire the service
into daemon, MCP, CLI, or any live event path.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-governance-lease):` commit per Anti-Tail Rule R4.
