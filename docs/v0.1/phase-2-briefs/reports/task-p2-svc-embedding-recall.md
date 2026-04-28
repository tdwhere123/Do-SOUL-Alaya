# Task P2-svc-embedding-recall Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-svc-embedding-recall.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/core/src/embedding-recall-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/embedding-recall-service.test.ts`
- Targets:
  - `packages/core/src/embedding-recall-service.ts`
  - `packages/core/src/__tests__/embedding-recall-service.test.ts`
- Existing helper dependency:
  - `packages/core/src/__tests__/mock-types.ts` is already present from
    `P2-svc-memory` and satisfies the copied test import.
- Owned docs changed:
  - `docs/v0.1/phase-2-briefs/reports/task-p2-svc-embedding-recall.md`
  - `docs/v0.1/INDEX.md`
  - `docs/handbook/runtime-status.md`
  - `docs/handbook/code-map.md`

No shared barrels, root config, storage repos, daemon files, MCP, CLI, GUI, TUI,
or Phase 3+ surfaces were edited.

## Port Mode

Port mode: `adapt-and-port`.

The target implementation and source test were copied from the cited vendor
paths. The permitted adaptations are:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`
- test-only `MemoryEmbeddingRecord` import from `@do-what/storage` ->
  test-only `EmbeddingVectorRecord` import from `../embedding-recall-service.js`

## Parity Evidence

Source existence check passed for:

- `vendor/do-what-new-snapshot/packages/core/src/embedding-recall-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/embedding-recall-service.test.ts`

The target files match the vendor files after applying only the package alias
rewrite and the task-card core/storage test-boundary adapter point.

## Verification

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/core/src/embedding-recall-service.ts','vendor/do-what-new-snapshot/packages/core/src/__tests__/embedding-recall-service.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}console.log('ok source paths exist');"` - passed
- Normalized vendor parity check - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "EmbeddingRecallService"` - passed; 1 file / 7 tests passed
- `rtk git diff --check` - passed
- Post-review closeout repair: `docs/v0.1/INDEX.md` now includes the
  `P2-svc-embedding-recall` implementation-ready row required by AC6.

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of recall embedding supplement,
  health journal, memory, and EventLog protocol types.
- The service is recall-side query support only; it does not wire daemon-side
  embedding backfill triggers.
- No SSE, daemon, MCP, CLI, GUI, TUI, or live surface was introduced.

## Intentional Deviations

- Port mode was corrected from `trivial-copy` to `adapt-and-port` because the
  copied vendor test imports a storage package type. In Alaya's current core
  TypeScript project, importing the storage source package from a core test
  pulls storage files outside the core `rootDir`; the target test uses the
  service-local structural vector record type instead.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports the
EmbeddingRecallService implementation and tests, but does not wire daemon-side
producer triggers, MCP, CLI, or any live event path.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-svc-embedding-recall):` commit per Anti-Tail Rule R4.
