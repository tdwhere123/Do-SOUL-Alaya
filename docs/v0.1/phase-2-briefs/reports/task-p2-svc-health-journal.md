# Task P2-svc-health-journal Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-health-journal.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/health-journal-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/karma-event-store.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/health-journal-service.test.ts`
- Targets:
  - `packages/core/src/health-journal-service.ts`
  - `packages/core/src/karma-event-store.ts`
  - `packages/core/src/__tests__/health-journal-service.test.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/task-p2-svc-health-journal.md`
  - `docs/v0.1/phase-2-briefs/README.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-svc-health-journal.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation and source test were copied from the cited vendor
paths. The permitted adaptations are:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `HealthJournalServiceSseBroadcasterPort` -> `HealthJournalServiceRuntimeNotifierPort`
- dependency property `sseBroadcaster` -> `runtimeNotifier`
- method call `broadcastEntry(entry)` -> `notifyEntry(entry)`

`karma-event-store.ts` uses only the package alias rewrite.

## Parity Evidence

Source existence check passed for:

- `vendor/do-what-new-snapshot/packages/core/src/health-journal-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/karma-event-store.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/health-journal-service.test.ts`

The target files match the vendor files after applying only the package alias
rewrite and the task-card SSE-to-runtime-notifier adapter point.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/health-journal-service.ts','vendor/do-what-new-snapshot/packages/core/src/karma-event-store.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/health-journal-service.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- Normalized vendor parity check - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "HealthJournalService"` - passed; 1 file / 5 tests passed
- `rtk git diff --check` - passed

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of health journal and karma
  protocol types.
- EventLog append still precedes repository write, preserving source ordering.
- Upstream SSE terminology is removed. Health journal notification is represented
  as an optional in-process `runtimeNotifier.notifyEntry` port only.
- No daemon, MCP, CLI, GUI, TUI, or live SSE surface was introduced.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because the
  upstream source contains an optional SSE broadcaster, and invariant §11
  requires stripping SSE transport while preserving in-process notification
  semantics.
- Cross-card dispatch ordering closure for `P2-svc-narrative-budget` is not
  health-journal completion evidence; it is recorded in the separate
  `fix(P2-svc-narrative-budget): align dispatch ordering [review Important]`
  review-fix commit.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the health
journal and karma event store behavior and tests, but does not wire the service
into daemon, MCP, CLI, or any live event path.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-health-journal):` commit per Anti-Tail Rule R4.
