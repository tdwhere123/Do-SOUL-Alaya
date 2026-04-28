# Task P2-svc-narrative-budget Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-narrative-budget.md`
- Source: `vendor/do-what-new-snapshot/packages/core/src/narrative-budget-service.ts`
- Source test: `vendor/do-what-new-snapshot/packages/core/src/__tests__/narrative-budget-service.test.ts`
- Target: `packages/core/src/narrative-budget-service.ts`
- Target test: `packages/core/src/__tests__/narrative-budget-service.test.ts`
- Owned paths changed:
  - `packages/core/src/narrative-budget-service.ts`
  - `packages/core/src/__tests__/narrative-budget-service.test.ts`
  - `docs/v0.1/phase-2-briefs/task-p2-svc-narrative-budget.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-svc-narrative-budget.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited. The task card prerequisite was repaired before
commit because the source imports `./event-publisher.js`, which is owned by
`P2-svc-event-publisher`.

## Port Mode

Port mode: `trivial-copy`.

The target implementation and source test were copied from the cited vendor
paths. The only content adaptation is the required package alias rewrite:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`

No function bodies, signatures, constants, helper structure, or test assertions
were rewritten.

## Parity Evidence

Source existence check passed for:

- `vendor/do-what-new-snapshot/packages/core/src/narrative-budget-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/narrative-budget-service.test.ts`

The target files match the vendor files after applying only the allowed package
alias rewrite.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/narrative-budget-service.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/narrative-budget-service.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "NarrativeBudgetService"` - passed; 1 file / 7 tests passed
- `rtk git diff --check` - passed

## Review Fixes

- Fixed review Important finding I1: the Phase 2 README now lists
  `P2-svc-event-publisher` before `P2-svc-narrative-budget` in both the service
  ordering block and the service table, and the table marks narrative-budget as
  `2B.0 follow-on after event-publisher`.

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of narrative budget config and
  Phase B event schemas.
- The service depends on the already ported event publisher through
  `Pick<EventPublisher, "publish">`; it does not own or edit the core barrel.
- Narrative budget events are emitted as EventLog entries only. No daemon, MCP,
  CLI, GUI, TUI, Garden, or live runtime surface was introduced.

## Intentional Deviations

- Package alias rewrite only: `@do-what/protocol` to
  `@do-soul/alaya-protocol`.
- Task-card prerequisite repaired from `P1-protocol, P1-core-skeleton` to
  include `P2-svc-event-publisher`, matching the source import.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the
NarrativeBudgetService behavior and unit tests, but does not wire the service
into daemon, MCP, CLI, or any live event path.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-narrative-budget):` commit per Anti-Tail Rule R4.
