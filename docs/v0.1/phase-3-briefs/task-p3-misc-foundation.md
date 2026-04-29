# Implementation Brief: Task P3-misc-foundation — Port Phase 3 support helpers

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-misc-foundation
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/tool-spec-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/strong-ref-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/dirty-state-panic-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/file-path.ts`, `vendor/do-what-new-snapshot/packages/core/src/message-history.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-spec-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/strong-ref-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/dirty-state-panic-service.test.ts`
> - **Target**: `packages/core/src/`, `packages/core/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: Gate-2, P2-security-2
> - **Blocks**: P3-mcp-discovery, P3-run-lifecycle, P3-conversation, P3-misc-services, P3-core-barrel
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-misc-foundation";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` §11.

## 1. Background & Goal

**Background**: Phase 3 cards depend on five small helpers that were
previously buried in `P3-misc-services`. Dispatching those helpers first
keeps later workers from racing on shared prerequisites.

**Goal**: Port tool specs, strong refs, DirtyState panic, stored-file path
resolution, and message-history reconstruction before MCP discovery, run
lifecycle, or ConversationService starts.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/tool-spec-service.ts` | `packages/core/src/tool-spec-service.ts` | Copy first; namespace rewrites only. |
| `vendor/do-what-new-snapshot/packages/core/src/strong-ref-service.ts` | `packages/core/src/strong-ref-service.ts` | Copy first; namespace rewrites only. |
| `vendor/do-what-new-snapshot/packages/core/src/dirty-state-panic-service.ts` | `packages/core/src/dirty-state-panic-service.ts` | Copy first; use Alaya `EventPublisher` semantics, which already notify through `RuntimeNotifier` instead of SSE. |
| `vendor/do-what-new-snapshot/packages/core/src/file-path.ts` | `packages/core/src/file-path.ts` | Copy first; no behavior changes. |
| `vendor/do-what-new-snapshot/packages/core/src/message-history.ts` | `packages/core/src/message-history.ts` | Copy first; namespace rewrites only. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-spec-service.test.ts` | `packages/core/src/__tests__/tool-spec-service.test.ts` | Port source tests; namespace rewrites only. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/strong-ref-service.test.ts` | `packages/core/src/__tests__/strong-ref-service.test.ts` | Port source tests; namespace rewrites only. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/dirty-state-panic-service.test.ts` | `packages/core/src/__tests__/dirty-state-panic-service.test.ts` | Port source tests; adapt only EventPublisher notifier naming if needed. |

### 2.2 Adapter Points

| Source point | Upstream behavior | Alaya behavior | Reason |
|---|---|---|---|
| `dirty-state-panic-service.ts` `EventPublisher` dependency | Uses upstream `EventPublisher` broadcaster chain | Use the already-ported Alaya `EventPublisher`, whose broadcast leg is `RuntimeNotifier.notifyEntry` | Alaya invariant §11 forbids SSE |
| `dirty-state-panic-service.ts` `WorkerRunLifecycleService` type import | Source imports the concrete lifecycle service type only to type the `freeze(...)` dependency | Replace with structural `DirtyStatePanicWorkerRunLifecyclePort` exposing `freeze(...)` so this foundation helper does not import the later `P3-run-lifecycle` implementation | Preserves behavior while keeping foundation dependency order |
| DirtyState tests | May name the mock as broadcast/SSE in upstream assertions | Rename mocks to runtime notifier terms without changing call ordering expectations | Vocabulary must match Alaya runtime notifier |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per the listed adapter points | Reviewer compares target files against cited vendor paths |
| AC2 | Every source path cited by this card exists before dispatch | Source existence command exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core tool-spec strong-ref dirty-state` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-3-briefs/reports/task-p3-misc-foundation.md` exists |
| AC6 | Closing readiness label is `implementation-ready` | Docs status updates avoid `live-event-ready` wording |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/tool-spec-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/strong-ref-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/dirty-state-panic-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/file-path.ts\",\"vendor/do-what-new-snapshot/packages/core/src/message-history.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-spec-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/strong-ref-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/dirty-state-panic-service.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm build`
3. `rtk pnpm exec tsc --noEmit -p packages/core`
4. `rtk pnpm exec vitest run --project @do-soul/alaya-core tool-spec strong-ref dirty-state`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel owns exports.
- Does not port surface, workspace, policy, claim, slash, runtime-adapter,
  tool-substrate, or ConversationService files.

**Prerequisite**: Gate-2, P2-security-2.
**Blocks**: P3-mcp-discovery, P3-run-lifecycle, P3-conversation, P3-misc-services, P3-core-barrel.
