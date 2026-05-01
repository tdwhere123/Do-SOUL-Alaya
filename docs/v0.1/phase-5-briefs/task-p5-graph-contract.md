# Implementation Brief: Task P5-graph-contract — Derive graph inspector data contract from real path data

> - **Phase**: 5
> - **Wave**: 5
> - **Card ID**: P5-graph-contract
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/graph-explore-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/graph-explore-service.test.ts`, `vendor/do-what-new-snapshot/packages/soul/src/garden/path-graph-snapshotter.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts`, `vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts`
> - **Target**: `packages/core/src/graph-contract-service.ts`, `packages/core/src/__tests__/graph-contract-service.test.ts`, `docs/v0.1/phase-5-briefs/reports/task-p5-graph-contract.md`
> - **Size**: M
> - **Prerequisite**: P1-topology, P2-repos-batch-2, P2-garden-batch-3, Gate-4 passed
> - **Blocks**: P5-e2e, P5-final-review
> - **Closing readiness label**: schema-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-5-briefs/README.md` row "P5-graph-contract";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver derive graph inspector data contract from real path data.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/graph-explore-service.ts` | `packages/core/src/graph-contract-service.ts` | Port source behavior into the Alaya graph contract service and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/graph-explore-service.test.ts` | `packages/core/src/__tests__/graph-contract-service.test.ts` | Port source behavior into the Alaya graph contract test and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/garden/path-graph-snapshotter.ts` | read-only dependency; owned by `P2-garden-batch-3` | Use as behavior evidence only; do not write this file in P5. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts` | read-only dependency; owned by `P2-repos-batch-2` | Use as behavior evidence only; do not write this file in P5. |
| `vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts` | read-only dependency; owned by `P2-repos-batch-2` | Use as behavior evidence only; do not write this file in P5. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/graph-explore-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/graph-explore-service.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/path-graph-snapshotter.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core graph-contract` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-5-briefs/reports/task-p5-graph-contract.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `schema-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/graph-explore-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/graph-explore-service.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/path-graph-snapshotter.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts\",\"vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core graph-contract`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P1-topology, P2-repos-batch-2, P2-garden-batch-3, Gate-4 passed.
**Blocks**: P5-e2e, P5-final-review.
