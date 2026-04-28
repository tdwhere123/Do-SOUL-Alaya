# Task P2-svc-memory Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-memory.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/memory-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/memory-service.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/mock-types.ts`
- Targets:
  - `packages/core/src/memory-service.ts`
  - `packages/core/src/__tests__/memory-service.test.ts`
  - `packages/core/src/__tests__/mock-types.ts`
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/task-p2-svc-memory.md`
  - `docs/v0.1/phase-2-briefs/reports/task-p2-svc-memory.md`
  - `docs/handbook/runtime-status.md`
  - `docs/handbook/code-map.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation, source test, and direct test helper were copied from
the cited vendor paths. The permitted adaptations are:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- `MemorySseBroadcaster` -> `MemoryRuntimeNotifier`
- dependency property `sseBroadcaster` -> `runtimeNotifier`
- method call `broadcastEntry(entry)` -> `notifyEntry(entry)`
- optional lifecycle / tombstone delete repo-port checks now run before EventLog
  append so durable state-change rows cannot be emitted without an available DB
  mutation port
- test/comment wording and order labels from SSE/broadcast language to
  in-process notification language

## Parity Evidence

Source existence check passed for:

- `vendor/do-what-new-snapshot/packages/core/src/memory-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/memory-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/mock-types.ts`

The target implementation follows the vendor implementation after applying the
package alias rewrite, the task-card SSE-to-runtime-notifier adapter point, and
the explicit Alaya invariant repair listed in §2.3. The source test file remains
the base test port and now includes two review-fix regression tests for the
Alaya invariant repair.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/memory-service.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/memory-service.test.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/mock-types.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- Focused source-fidelity check for `assertStringArray` helper naming - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "MemoryService"` - passed; 1 file / 19 tests passed
- `rtk git diff --check` - passed

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of memory entry, transition, and
  EventLog protocol types.
- EventLog append and repository mutation ordering is preserved from the source.
- Upstream SSE terminology is removed. Memory notification is represented as an
  in-process `runtimeNotifier.notifyEntry` port only.
- No daemon, MCP, CLI, GUI, TUI, or live SSE surface was introduced.
- Review Blocking finding B1 is fixed: missing optional lifecycle / tombstone
  delete repo ports now fail before EventLog append or runtime notification,
  preserving the Alaya state-change durability invariant.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because the
  upstream source contains an SSE broadcaster dependency, and invariant §11
  requires stripping SSE transport while preserving in-process notification
  semantics.
- The direct vendor test helper `mock-types.ts` was added to the card because
  `memory-service.test.ts` imports it.
- `P2-svc-signal` was added as a prerequisite because the signal card blocks
  memory service dispatch.
- The optional `transitionLifecycle` and `hardDeleteTombstoned` repo-port checks
  intentionally run before EventLog append in Alaya. The source performs those
  checks after append; the target order is required by invariant §7 so an
  unavailable DB mutation port cannot leave a durable state-change event behind.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the memory
service behavior and tests, but does not wire the service into daemon, MCP, CLI,
or any live event path.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-memory):` commit per Anti-Tail Rule R4.
