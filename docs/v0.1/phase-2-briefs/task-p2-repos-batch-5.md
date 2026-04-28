# Implementation Brief: Task P2-repos-batch-5 — Port governance, drift, and defense repos

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-repos-batch-5
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/storage/src/repos/green-status-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/drift-lease-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/conflict-matrix-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/cross-cutting-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/strong-ref-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/deferred-obligation-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/dirty-state-dossier-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/green-status-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/drift-lease-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/conflict-matrix-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/cross-cutting-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/strong-ref-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/deferred-obligation-repo.test.ts`, `vendor/do-what-new-snapshot/packages/storage/src/__tests__/dirty-state-dossier-repo.test.ts`
> - **Target**: `packages/storage/src/repos/`, `packages/storage/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-protocol
> - **Blocks**: P2-svc-*, P2-barrel-storage
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-repos-batch-5";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port governance, drift, and defense repos.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/storage/src/repos/green-status-repo.ts` | `packages/storage/src/repos/green-status-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/drift-lease-repo.ts` | `packages/storage/src/repos/drift-lease-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/conflict-matrix-repo.ts` | `packages/storage/src/repos/conflict-matrix-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/cross-cutting-repo.ts` | `packages/storage/src/repos/cross-cutting-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/strong-ref-repo.ts` | `packages/storage/src/repos/strong-ref-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/deferred-obligation-repo.ts` | `packages/storage/src/repos/deferred-obligation-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/dirty-state-dossier-repo.ts` | `packages/storage/src/repos/dirty-state-dossier-repo.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/green-status-repo.test.ts` | `packages/storage/src/__tests__/green-status-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/drift-lease-repo.test.ts` | `packages/storage/src/__tests__/drift-lease-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/conflict-matrix-repo.test.ts` | `packages/storage/src/__tests__/conflict-matrix-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/cross-cutting-repo.test.ts` | `packages/storage/src/__tests__/cross-cutting-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/strong-ref-repo.test.ts` | `packages/storage/src/__tests__/strong-ref-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/deferred-obligation-repo.test.ts` | `packages/storage/src/__tests__/deferred-obligation-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/__tests__/dirty-state-dossier-repo.test.ts` | `packages/storage/src/__tests__/dirty-state-dossier-repo.test.ts` | Copy first; only package-name/path rewrites are allowed. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/repos/green-status-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/drift-lease-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/conflict-matrix-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/cross-cutting-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/strong-ref-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/deferred-obligation-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/dirty-state-dossier-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/green-status-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/drift-lease-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/conflict-matrix-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/cross-cutting-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/strong-ref-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/deferred-obligation-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/dirty-state-dossier-repo.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-storage green-status-repo drift-lease-repo conflict-matrix-repo cross-cutting-repo strong-ref-repo deferred-obligation-repo dirty-state-dossier-repo` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-repos-batch-5.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/src/repos/green-status-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/drift-lease-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/conflict-matrix-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/cross-cutting-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/strong-ref-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/deferred-obligation-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/dirty-state-dossier-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/green-status-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/drift-lease-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/conflict-matrix-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/cross-cutting-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/strong-ref-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/deferred-obligation-repo.test.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/__tests__/dirty-state-dossier-repo.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/storage`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-storage green-status-repo drift-lease-repo conflict-matrix-repo cross-cutting-repo strong-ref-repo deferred-obligation-repo dirty-state-dossier-repo`

## 6. Shared File Hazards & Dependencies

- Does not touch `packages/storage/src/index.ts`; P2-barrel-storage serializes exports after every repo batch closes.

**Prerequisite**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-protocol.
**Blocks**: P2-svc-*, P2-barrel-storage.
