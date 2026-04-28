# Implementation Brief: Task P2-repos-batch-6 — Port worker, garden adapter, cascade, signal, and proposal repos

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-repos-batch-6
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/storage/src/repos/worker-run-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/handoff-gap-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/bootstrapping-record-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/cascade-delete.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/garden-data-ports.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/signal-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/proposal-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/worker-run-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/handoff-gap-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/bootstrapping-record-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/garden-data-ports.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/signal-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/proposal-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/storage-flow.test.ts`
> - **Target**: `packages/storage/src/repos/`, `packages/storage/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-protocol
> - **Blocks**: P2-garden-batch-*, P2-barrel-storage
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-repos-batch-6";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port worker, garden adapter, cascade, signal, and proposal repos.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/storage/src/repos/worker-run-repo.ts` | `packages/storage/src/repos/worker-run-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/handoff-gap-repo.ts` | `packages/storage/src/repos/handoff-gap-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/bootstrapping-record-repo.ts` | `packages/storage/src/repos/bootstrapping-record-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/cascade-delete.ts` | `packages/storage/src/repos/cascade-delete.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/garden-data-ports.ts` | `packages/storage/src/repos/garden-data-ports.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/signal-repo.ts` | `packages/storage/src/repos/signal-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/proposal-repo.ts` | `packages/storage/src/repos/proposal-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/worker-run-repo.test.ts` | `packages/storage/src/__tests__/worker-run-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/handoff-gap-repo.test.ts` | `packages/storage/src/__tests__/handoff-gap-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/bootstrapping-record-repo.test.ts` | `packages/storage/src/__tests__/bootstrapping-record-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/garden-data-ports.test.ts` | `packages/storage/src/__tests__/garden-data-ports.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/signal-repo.test.ts` | `packages/storage/src/__tests__/signal-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/proposal-repo.test.ts` | `packages/storage/src/__tests__/proposal-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/storage-flow.test.ts` | `packages/storage/src/__tests__/storage-flow.test.ts` | Copy first; only package-name/path rewrites are allowed. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/repos/worker-run-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/handoff-gap-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/bootstrapping-record-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/cascade-delete.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/garden-data-ports.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/signal-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/proposal-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/worker-run-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/handoff-gap-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/bootstrapping-record-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/garden-data-ports.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/signal-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/proposal-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/storage-flow.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-storage worker-run-repo handoff-gap-repo bootstrapping-record-repo cascade-delete garden-data-ports signal-repo proposal-repo` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-repos-batch-6.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/repos/worker-run-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/handoff-gap-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/bootstrapping-record-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/cascade-delete.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/garden-data-ports.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/signal-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/proposal-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/worker-run-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/handoff-gap-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/bootstrapping-record-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/garden-data-ports.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/signal-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/proposal-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/storage-flow.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/storage`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-storage worker-run-repo handoff-gap-repo bootstrapping-record-repo cascade-delete garden-data-ports signal-repo proposal-repo`

## 6. Shared File Hazards & Dependencies

- Does not touch `packages/storage/src/index.ts`; P2-barrel-storage serializes exports after every repo batch closes.

**Prerequisite**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-protocol.
**Blocks**: P2-garden-batch-*, P2-barrel-storage.
