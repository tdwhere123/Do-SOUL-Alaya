# Implementation Brief: Task P2-barrel-storage — Export Phase 2 storage repos

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-barrel-storage
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/storage/src/index.ts`
> - **Target**: `packages/storage/src/index.ts`
> - **Size**: S
> - **Prerequisite**: P2-repos-batch-1, P2-repos-batch-2, P2-repos-batch-3, P2-repos-batch-4, P2-repos-batch-5, P2-repos-batch-6
> - **Blocks**: Gate-2
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-barrel-storage";
`docs/handbook/port-protocol.md §1 trivial-copy`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver export Phase 2 storage repos.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/storage/src/index.ts` | `packages/storage/src/index.ts` | Copy first; no code-level deviations expected. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-storage` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-barrel-storage.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/storage`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-storage`

## 6. Shared File Hazards & Dependencies

- Owns `packages/storage/src/index.ts` after P1-storage-skeleton. No repo batch may edit this file.

**Prerequisite**: P2-repos-batch-1, P2-repos-batch-2, P2-repos-batch-3, P2-repos-batch-4, P2-repos-batch-5, P2-repos-batch-6.
**Blocks**: Gate-2.
