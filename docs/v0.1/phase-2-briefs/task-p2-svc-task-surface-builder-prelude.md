# Implementation Brief: Task P2-svc-task-surface-builder-prelude — Port TaskSurfaceBuilder recall defaults

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-svc-task-surface-builder-prelude
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/task-surface-builder.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/task-surface-builder.test.ts`
> - **Target**: `packages/core/src/task-surface-builder.ts`, `packages/core/src/__tests__/task-surface-builder.test.ts`
> - **Size**: S
> - **Prerequisite**: P1-protocol, P1-core-skeleton
> - **Blocks**: P2-svc-recall, P3-run-lifecycle
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-svc-task-surface-builder-prelude";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: RecallService imports `STRATEGY_RECALL_DEFAULTS` and
`NodeStrategy` from TaskSurfaceBuilder. Leaving TaskSurfaceBuilder under
P3-run-lifecycle would force P2-svc-recall either to expand scope silently or
to stop on a dependency that is already source-backed.

**Goal**: Deliver the narrow TaskSurfaceBuilder port needed by Phase 2 recall
without starting the rest of Phase 3 run lifecycle work.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/task-surface-builder.ts` | `packages/core/src/task-surface-builder.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/task-surface-builder.test.ts` | `packages/core/src/__tests__/task-surface-builder.test.ts` | Copy first; only package-name/path rewrites are allowed. |

### 2.2 Port Rules

- Port mode is `trivial-copy`; implementation must follow
  `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit `packages/core/src/index.ts`; P3-core-barrel owns core exports.
- Do not port `worker-run-lifecycle-service.ts`, `worker-run-state-machine.ts`,
  `run-service.ts`, `run-hot-state-service.ts`, or serial-delegation files.
- If a cited source path is missing or a source dependency forces files outside
  §2, return `BLOCKED` instead of expanding scope.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per trivial-copy rules | Reviewer compares target files against the cited vendor source paths |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/task-surface-builder.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/task-surface-builder.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "TaskSurfaceBuilder"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-svc-task-surface-builder-prelude.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/task-surface-builder.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/task-surface-builder.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "TaskSurfaceBuilder"`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel serializes core
  service exports after Phase 3.
- Does not implement Phase 3 run lifecycle, ConversationService, daemon/MCP/CLI
  wiring, or any public core barrel export.

**Prerequisite**: P1-protocol, P1-core-skeleton.
**Blocks**: P2-svc-recall, P3-run-lifecycle.
