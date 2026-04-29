# Implementation Brief: Task P2-barrel-soul — Export Phase 2 Garden roles

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-barrel-soul
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/soul/src/index.ts`, `vendor/do-what-new-snapshot/packages/soul/src/garden/index.ts`
> - **Target**: `packages/soul/src/index.ts`, `packages/soul/src/garden/index.ts`
> - **Size**: S
> - **Prerequisite**: P2-garden-batch-1, P2-garden-batch-2, P2-garden-batch-3, P2-garden-batch-4
> - **Blocks**: Gate-2
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-barrel-soul";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver export Phase 2 Garden roles.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/soul/src/index.ts` | `packages/soul/src/index.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/garden/index.ts` | `packages/soul/src/garden/index.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| Source construct | Alaya construct | Reason |
|---|---|---|
| Graph helper re-export from `@do-what/protocol` | Graph helper re-export from `@do-soul/alaya-protocol` | Preserve upstream public graph constants/parsers using the Alaya protocol package name. |
| `SoulGraphAggregator` export from `./graph/graph-aggregator.js` | Omit only this file export | The aggregator implementation is not present in the Alaya Phase 2 source set. |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/soul/src/index.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-soul` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-barrel-soul.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/soul/src/index.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/soul`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-soul`

## 6. Shared File Hazards & Dependencies

- Owns `packages/soul/src/index.ts` and `packages/soul/src/garden/index.ts` after P1-soul-skeleton.

**Prerequisite**: P2-garden-batch-1, P2-garden-batch-2, P2-garden-batch-3, P2-garden-batch-4.
**Blocks**: Gate-2.
