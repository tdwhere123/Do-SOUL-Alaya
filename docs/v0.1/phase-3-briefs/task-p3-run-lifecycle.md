# Implementation Brief: Task P3-run-lifecycle — Port run lifecycle and serial delegation services

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-run-lifecycle
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/worker-run-lifecycle-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/worker-run-state-machine.ts`, `vendor/do-what-new-snapshot/packages/core/src/run-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/run-hot-state-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-event-intake.ts`, `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-recovery.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-lifecycle-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-state-machine.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/run-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/run-hot-state-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-event-intake.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-recovery.test.ts`
> - **Target**: `packages/core/src/`, `packages/core/src/__tests__/`
> - **Size**: L
> - **Prerequisite**: P2-svc-task-surface-builder-prelude, P2-repos-batch-4, P2-repos-batch-6, P2-security-2
> - **Blocks**: P3-conversation, P4-routes-workspace, P3-core-barrel
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-run-lifecycle";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port run lifecycle and serial delegation services.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/worker-run-lifecycle-service.ts` | `packages/core/src/worker-run-lifecycle-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/worker-run-state-machine.ts` | `packages/core/src/worker-run-state-machine.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/run-service.ts` | `packages/core/src/run-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/run-hot-state-service.ts` | `packages/core/src/run-hot-state-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-service.ts` | `packages/core/src/serial-delegation-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-event-intake.ts` | `packages/core/src/serial-delegation-event-intake.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/serial-delegation-recovery.ts` | `packages/core/src/serial-delegation-recovery.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-lifecycle-service.test.ts` | `packages/core/src/__tests__/worker-run-lifecycle-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-state-machine.test.ts` | `packages/core/src/__tests__/worker-run-state-machine.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/run-service.test.ts` | `packages/core/src/__tests__/run-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/run-hot-state-service.test.ts` | `packages/core/src/__tests__/run-hot-state-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-service.test.ts` | `packages/core/src/__tests__/serial-delegation-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-event-intake.test.ts` | `packages/core/src/__tests__/serial-delegation-event-intake.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-recovery.test.ts` | `packages/core/src/__tests__/serial-delegation-recovery.test.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

## 3. Deferred

- Chat worker dispatch runtime behavior — deferred to backlog #BL-004.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/worker-run-lifecycle-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/worker-run-state-machine.ts\",\"vendor/do-what-new-snapshot/packages/core/src/run-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/run-hot-state-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/serial-delegation-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/serial-delegation-event-intake.ts\",\"vendor/do-what-new-snapshot/packages/core/src/serial-delegation-recovery.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-lifecycle-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-state-machine.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/run-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/run-hot-state-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-event-intake.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-recovery.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core run-service worker-run serial-delegation task-surface` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-3-briefs/reports/task-p3-run-lifecycle.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/worker-run-lifecycle-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/worker-run-state-machine.ts\",\"vendor/do-what-new-snapshot/packages/core/src/run-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/run-hot-state-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/serial-delegation-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/serial-delegation-event-intake.ts\",\"vendor/do-what-new-snapshot/packages/core/src/serial-delegation-recovery.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-lifecycle-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-run-state-machine.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/run-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/run-hot-state-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-event-intake.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/serial-delegation-recovery.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core run-service worker-run serial-delegation task-surface`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel owns exports.
- Does not own `packages/core/src/task-surface-builder.ts` or its test; those
  files are owned by P2-svc-task-surface-builder-prelude.

**Prerequisite**: P2-svc-task-surface-builder-prelude, P2-repos-batch-4, P2-repos-batch-6, P2-security-2.
**Blocks**: P3-conversation, P4-routes-workspace, P3-core-barrel.
