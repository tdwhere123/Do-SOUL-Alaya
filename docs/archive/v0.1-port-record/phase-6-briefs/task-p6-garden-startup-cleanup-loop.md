# Implementation Brief: P6-garden-startup-cleanup-loop — Attach-Path Garden Lifecycle

> - **Card ID**: p6-garden-startup-cleanup-loop
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-garden-startup-cleanup-loop`; delivered commit `592a7a5`
> - **Target**: `apps/core-daemon/src/daemon-runtime-lifecycle.ts`, `apps/core-daemon/src/garden-runtime.ts`, `apps/core-daemon/src/index.ts`, `apps/core-daemon/src/__tests__/daemon-runtime-lifecycle.test.ts`, `apps/core-daemon/src/__tests__/garden-runtime.test.ts`, `apps/core-daemon/src/__tests__/cli-register.test.ts`
> - **Size**: M
> - **Prerequisite**: none
> - **Blocks**: p6-live-agent-proof
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 startup acceptance requires that the normal attach path starts Garden maintenance without separate manual runtime boot steps. Delivered lifecycle changes start background services once and run one initial cleanup pass.

Goal: wire attach/runtime startup so Garden background manager and startup cleanup pass are launched once per daemon lifecycle and stop with daemon shutdown.

## 2. Allowed Scope

- **Target**: `apps/core-daemon/src/daemon-runtime-lifecycle.ts`
- **Change**: add `startBackgroundServices` guard and startup cleanup invocation.

- **Target**: `apps/core-daemon/src/garden-runtime.ts`, `apps/core-daemon/src/index.ts`
- **Change**: expose and wire background pass/start-stop lifecycle hooks.

- **Target**: lifecycle tests
- **Change**: assert one-time startup behavior and startup pass trigger.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Daemon lifecycle exposes `startBackgroundServices` and prevents duplicate starts. | `apps/core-daemon/src/daemon-runtime-lifecycle.ts` plus `apps/core-daemon/src/__tests__/daemon-runtime-lifecycle.test.ts`. |
| AC2 | Startup triggers one Garden background pass. | `runBackgroundPass` assertion in `apps/core-daemon/src/__tests__/daemon-runtime-lifecycle.test.ts`. |
| AC3 | Attach path invokes startup services in command flow. | `apps/core-daemon/src/cli/register.ts` and `apps/core-daemon/src/__tests__/cli-register.test.ts`. |
| AC4 | Background runtime still exposes explicit stop/teardown path through lifecycle controls. | lifecycle controls in `apps/core-daemon/src/daemon-runtime-lifecycle.ts` and runtime wiring in `apps/core-daemon/src/index.ts`. |

## 5. Verification

```bash
rtk rg -n "startBackgroundServices|runBackgroundPass" apps/core-daemon/src/daemon-runtime-lifecycle.ts apps/core-daemon/src/index.ts apps/core-daemon/src/garden-runtime.ts
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/daemon-runtime-lifecycle.test.ts apps/core-daemon/src/__tests__/garden-runtime.test.ts apps/core-daemon/src/__tests__/cli-register.test.ts
```

## 6. Shared File Hazards & Dependencies

- Shared with `P6-cwd-workspace-startup`: `cli/register.ts` startup path.
- Shared with `P6-live-agent-proof`: runtime lifecycle and test harness boot semantics.

**Prerequisite**: none.
**Blocks**: p6-live-agent-proof.
