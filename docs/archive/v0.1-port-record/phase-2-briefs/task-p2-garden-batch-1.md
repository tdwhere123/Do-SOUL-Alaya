# Implementation Brief: Task P2-garden-batch-1 — Port Auditor, scheduler, and local heuristic Garden leaves

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-garden-batch-1
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/soul/src/garden/auditor.ts`, `vendor/do-what-new-snapshot/packages/soul/src/garden/scheduler.ts`, `vendor/do-what-new-snapshot/packages/soul/src/garden/compute-provider.ts`, `vendor/do-what-new-snapshot/packages/soul/src/garden/compute-routing-service.ts`, `vendor/do-what-new-snapshot/packages/soul/src/garden/local-heuristics.ts`, `vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor.test.ts`, `vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor-4b.test.ts`, `vendor/do-what-new-snapshot/packages/soul/src/__tests__/garden-scheduler.test.ts`, `vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-provider.test.ts`, `vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-routing-service.test.ts`, `vendor/do-what-new-snapshot/packages/soul/src/__tests__/local-heuristics.test.ts`
> - **Target**: `packages/soul/src/garden/`, `packages/soul/src/__tests__/`
> - **Size**: L
> - **Prerequisite**: P2-repos-batch-6, P2-svc-memory, P2-svc-green, P2-svc-health-journal
> - **Blocks**: P2-barrel-soul
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-garden-batch-1";
`docs/handbook/port-protocol.md §2 adapt-and-port`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port Auditor, scheduler, and local heuristic Garden leaves.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/soul/src/garden/auditor.ts` | `packages/soul/src/garden/auditor.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/garden/scheduler.ts` | `packages/soul/src/garden/scheduler.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/garden/compute-provider.ts` | `packages/soul/src/garden/compute-provider.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/garden/compute-routing-service.ts` | `packages/soul/src/garden/compute-routing-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/garden/local-heuristics.ts` | `packages/soul/src/garden/local-heuristics.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor.test.ts` | `packages/soul/src/__tests__/auditor.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor-4b.test.ts` | `packages/soul/src/__tests__/auditor-repair-orphan-detection.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/__tests__/garden-scheduler.test.ts` | `packages/soul/src/__tests__/garden-scheduler.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-provider.test.ts` | `packages/soul/src/__tests__/compute-provider.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-routing-service.test.ts` | `packages/soul/src/__tests__/compute-routing-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/soul/src/__tests__/local-heuristics.test.ts` | `packages/soul/src/__tests__/local-heuristics.test.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| Source construct | Target construct | Reason |
|---|---|---|
| `compute-routing-service.test.ts` imports `ComputeRoutingService`, `GardenProviderKind`, `GardenCompileContext`, and `GardenComputeProvider` from `@do-what/soul` | Import `ComputeRoutingService` from `../garden/compute-routing-service.js` and provider types from `../garden/compute-provider.js` | `packages/soul/src/index.ts` and `packages/soul/src/garden/index.ts` are owned by P2-barrel-soul, so this card cannot test through the package barrel. |
| `local-heuristics.test.ts` imports `LocalHeuristics` and `GardenCompileContext` from `@do-what/soul` | Import `LocalHeuristics` from `../garden/local-heuristics.js` and `GardenCompileContext` from `../garden/compute-provider.js` | Same P2-barrel-soul boundary; the test still exercises the same implementation. |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/soul/src/garden/auditor.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/scheduler.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/compute-provider.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/compute-routing-service.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/local-heuristics.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor-4b.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/garden-scheduler.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-provider.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-routing-service.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/local-heuristics.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-soul auditor auditor-repair-orphan-detection garden-scheduler compute-provider compute-routing-service local-heuristics` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-garden-batch-1.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/soul/src/garden/auditor.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/scheduler.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/compute-provider.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/compute-routing-service.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/local-heuristics.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/auditor-4b.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/garden-scheduler.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-provider.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/compute-routing-service.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/local-heuristics.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/soul`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-soul auditor auditor-repair-orphan-detection garden-scheduler compute-provider compute-routing-service local-heuristics`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/soul/src/index.ts` or `packages/soul/src/garden/index.ts`; P2-barrel-soul owns exports.

**Prerequisite**: P2-repos-batch-6, P2-svc-memory, P2-svc-green, P2-svc-health-journal.
**Blocks**: P2-barrel-soul.
