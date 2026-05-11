# Implementation Brief: P6-cwd-workspace-startup — CWD-First Workspace Resolution

> - **Card ID**: p6-cwd-workspace-startup
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-cwd-workspace-startup`; delivered commit `592a7a5`
> - **Target**: `apps/core-daemon/src/cli/workspace-context.ts`, `apps/core-daemon/src/cli/register.ts`, `apps/core-daemon/src/cli/tools.ts`, `apps/core-daemon/src/cli/review.ts`, `apps/core-daemon/src/cli/doctor.ts`, `packages/core/src/workspace-service.ts`, `apps/core-daemon/src/__tests__/cli-tools.test.ts`, `apps/core-daemon/src/__tests__/cli-register.test.ts`, `packages/core/src/__tests__/workspace-service.test.ts`
> - **Size**: M
> - **Prerequisite**: none
> - **Blocks**: none
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 requires current-directory startup semantics for attached MCP and CLI fallback surfaces, with explicit overrides still supported. Delivered changes introduced a shared workspace-context resolver and implicit local workspace registration path.

Goal: default workspace selection to launch cwd when no explicit workspace override exists, while preserving `--workspace` and `ALAYA_WORKSPACE_ID` precedence.

## 2. Allowed Scope

- **Target**: `apps/core-daemon/src/cli/workspace-context.ts`
- **Change**: central resolver for explicit/default/env/cwd precedence and stable local workspace id derivation.

- **Target**: CLI commands (`register.ts`, `tools.ts`, `review.ts`, `doctor.ts`)
- **Change**: adopt shared resolver and ensure implicit local workspace registration before tool flow.

- **Target**: `packages/core/src/workspace-service.ts`
- **Change**: support local workspace lookup/registration expectations used by startup flow.

- **Target**: tests
- **Change**: assert local workspace id format, override precedence, and workspace registration behavior.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Workspace resolution precedence is explicit: `--workspace` > dependency default > `ALAYA_WORKSPACE_ID` > cwd-derived local id. | `apps/core-daemon/src/cli/workspace-context.ts`. |
| AC2 | CWD fallback creates deterministic `local_<hash>` workspace id and registration payload. | `apps/core-daemon/src/cli/workspace-context.ts`, `apps/core-daemon/src/__tests__/cli-register.test.ts`, `apps/core-daemon/src/__tests__/cli-tools.test.ts`. |
| AC3 | CLI fallback commands use shared resolver instead of per-command ad hoc defaults. | imports/usages across `register.ts`, `tools.ts`, `review.ts`, `doctor.ts`. |
| AC4 | Core workspace service supports the local workspace startup behavior. | `packages/core/src/workspace-service.ts` and `packages/core/src/__tests__/workspace-service.test.ts`. |

## 5. Verification

```bash
rtk rg -n "resolveCliWorkspaceContext|ALAYA_WORKSPACE_ID|local_" apps/core-daemon/src/cli apps/core-daemon/src/__tests__/cli-tools.test.ts apps/core-daemon/src/__tests__/cli-register.test.ts
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/cli-tools.test.ts apps/core-daemon/src/__tests__/cli-register.test.ts
rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/workspace-service.test.ts
```

## 6. Shared File Hazards & Dependencies

- Shared with `P6-garden-startup-cleanup-loop`: attach/register flow.
- Shared with `P6-live-agent-proof`: workspace-scoped MCP/CLI path assumptions.

**Prerequisite**: none.
**Blocks**: none.
