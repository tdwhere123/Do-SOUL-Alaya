# Implementation Brief: Task P2-svc-recall — Port RecallService

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-svc-recall
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/recall-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-global-filter.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-8factor.test.ts`
> - **Target**: `packages/core/src/`, `packages/core/src/__tests__/`
> - **Size**: L
> - **Prerequisite**: P2-svc-task-surface-builder-prelude, P2-svc-memory, P2-svc-evidence, P2-repos-batch-2, P2-svc-global-recall, P2-svc-embedding-recall
> - **Blocks**: P2-svc-manifestation, P2-svc-synthesis, P3-conversation
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-svc-recall";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port RecallService.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/recall-service.ts` | `packages/core/src/recall-service.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-service.test.ts` | `packages/core/src/__tests__/recall-service.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-global-filter.test.ts` | `packages/core/src/__tests__/recall-global-filter.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-8factor.test.ts` | `packages/core/src/__tests__/recall-8factor.test.ts` | Copy first; only package-name/path rewrites are allowed. |

### 2.2 Port Rules

- Port mode is `trivial-copy`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per trivial-copy rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/recall-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-global-filter.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-8factor.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "RecallService"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-svc-recall.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/recall-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-global-filter.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/recall-8factor.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "RecallService"`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel serializes service exports after Phase 3.

**Prerequisite**: P2-svc-task-surface-builder-prelude, P2-svc-memory, P2-svc-evidence, P2-repos-batch-2, P2-svc-global-recall, P2-svc-embedding-recall.
**Blocks**: P2-svc-manifestation, P2-svc-synthesis, P3-conversation.
