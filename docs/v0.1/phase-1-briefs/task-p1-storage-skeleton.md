# Implementation Brief: Task P1-storage-skeleton — Port @do-soul/alaya-storage skeleton

> - **Phase**: 1
> - **Wave**: 1
> - **Card ID**: P1-storage-skeleton
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/storage/package.json`, `vendor/do-what-new-snapshot/packages/storage/tsconfig.json`, `vendor/do-what-new-snapshot/packages/storage/src/db.ts`, `vendor/do-what-new-snapshot/packages/storage/src/errors.ts`, `vendor/do-what-new-snapshot/packages/storage/src/index.ts`
> - **Target**: `packages/storage/package.json`, `packages/storage/tsconfig.json`, `packages/storage/src/db.ts`, `packages/storage/src/errors.ts`, `packages/storage/src/index.ts`
> - **Size**: S
> - **Prerequisite**: P1-protocol
> - **Blocks**: P1-storage-shared, P1-migrations, P2-repos-batch-*
> - **Closing readiness label**: schema-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-1-briefs/README.md` row "P1-storage-skeleton";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port @do-soul/alaya-storage skeleton.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/storage/package.json` | `packages/storage/package.json` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/tsconfig.json` | `packages/storage/tsconfig.json` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/db.ts` | `packages/storage/src/db.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/errors.ts` | `packages/storage/src/errors.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/storage/src/index.ts` | `packages/storage/src/index.ts` | Copy first; only package-name/path rewrites are allowed. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/package.json\",\"vendor/do-what-new-snapshot/packages/storage/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/storage/src/db.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/errors.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant package tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-storage` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-1-briefs/reports/task-p1-storage-skeleton.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `schema-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/storage/package.json\",\"vendor/do-what-new-snapshot/packages/storage/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/storage/src/db.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/errors.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/storage`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-storage`

## 6. Shared File Hazards & Dependencies

- Writes `packages/storage/src/db.ts`, `errors.ts`, and initial `index.ts`; P2-barrel-storage owns later repo exports.

**Prerequisite**: P1-protocol.
**Blocks**: P1-storage-shared, P1-migrations, P2-repos-batch-*.
