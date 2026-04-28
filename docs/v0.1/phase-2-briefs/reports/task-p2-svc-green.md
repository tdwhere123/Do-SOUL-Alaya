# Task P2-svc-green Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-green.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/green-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/green-service.test.ts`
- Targets:
  - `packages/core/src/green-service.ts`
  - `packages/core/src/__tests__/green-service.test.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/task-p2-svc-green.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-svc-green.md`
  - `docs/handbook/runtime-status.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation and source test were copied from the cited vendor
paths. The permitted adaptations are:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `GreenSseBroadcaster` -> `GreenRuntimeNotifier`
- dependency property `sseBroadcaster` -> `runtimeNotifier`
- method call `broadcastEntry(entry)` -> `notifyEntry(entry)`
- test/comment wording from SSE/broadcast language to in-process notification
  language

## Parity Evidence

Source existence check passed for:

- `vendor/do-what-new-snapshot/packages/core/src/green-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/green-service.test.ts`

The target files match the vendor files after applying only the package alias
rewrite and the task-card SSE-to-runtime-notifier adapter point.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/green-service.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/green-service.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- Normalized vendor parity check - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "GreenService"` - passed; 1 file / 22 tests passed
- `rtk git diff --check` - passed

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of Green status, verification,
  memory, and EventLog protocol types.
- EventLog append and repository mutation ordering is preserved from the source.
- Upstream SSE terminology is removed. Green notification is represented as an
  in-process `runtimeNotifier.notifyEntry` port only.
- No daemon, MCP, CLI, GUI, TUI, or live SSE surface was introduced.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because the
  upstream source contains an SSE broadcaster dependency, and invariant §11
  requires stripping SSE transport while preserving in-process notification
  semantics.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the Green
state machine implementation and tests, but does not wire the service into
daemon, MCP, CLI, Garden runtime, or any live event path.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-green):` commit per Anti-Tail Rule R4.
