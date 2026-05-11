# Implementation Brief: Task P2-repos-batch-2 — Port recall and path storage repos

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-repos-batch-2
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-recall-cache-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/memory-embedding-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/memory-graph-edge-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/orphan-radar-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/global-memory-repos.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-embedding-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-graph-edge-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-relation-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-graph-snapshot-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/orphan-radar-repo.test.ts`
> - **Target**: `packages/storage/src/repos/`, `packages/storage/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-protocol
> - **Blocks**: P2-svc-*, P2-barrel-storage
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-repos-batch-2";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port recall and path storage repos.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-repo.ts` | `packages/storage/src/repos/global-memory-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-recall-cache-repo.ts` | `packages/storage/src/repos/global-memory-recall-cache-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/memory-embedding-repo.ts` | `packages/storage/src/repos/memory-embedding-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/memory-graph-edge-repo.ts` | `packages/storage/src/repos/memory-graph-edge-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts` | `packages/storage/src/repos/path-relation-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts` | `packages/storage/src/repos/path-graph-snapshot-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/orphan-radar-repo.ts` | `packages/storage/src/repos/orphan-radar-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/global-memory-repos.test.ts` | `packages/storage/src/__tests__/global-memory-repos.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-embedding-repo.test.ts` | `packages/storage/src/__tests__/memory-embedding-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-graph-edge-repo.test.ts` | `packages/storage/src/__tests__/memory-graph-edge-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-relation-repo.test.ts` | `packages/storage/src/__tests__/path-relation-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-graph-snapshot-repo.test.ts` | `packages/storage/src/__tests__/path-graph-snapshot-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/orphan-radar-repo.test.ts` | `packages/storage/src/__tests__/orphan-radar-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-recall-cache-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/memory-embedding-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/memory-graph-edge-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/orphan-radar-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/global-memory-repos.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-embedding-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-graph-edge-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-relation-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-graph-snapshot-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/orphan-radar-repo.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-storage global-memory-repo global-memory-recall-cache-repo memory-embedding-repo memory-graph-edge-repo path-relation-repo path-graph-snapshot-repo orphan-radar-repo` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-repos-batch-2.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/global-memory-recall-cache-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/memory-embedding-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/memory-graph-edge-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/orphan-radar-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/global-memory-repos.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-embedding-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/memory-graph-edge-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-relation-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/path-graph-snapshot-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/orphan-radar-repo.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/storage`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-storage global-memory-repo global-memory-recall-cache-repo memory-embedding-repo memory-graph-edge-repo path-relation-repo path-graph-snapshot-repo orphan-radar-repo`

## 6. Shared File Hazards & Dependencies

- Does not touch `packages/storage/src/index.ts`; P2-barrel-storage serializes exports after every repo batch closes.

**Prerequisite**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-protocol.
**Blocks**: P2-svc-*, P2-barrel-storage.
