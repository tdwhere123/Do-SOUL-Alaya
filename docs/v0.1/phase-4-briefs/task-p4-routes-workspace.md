# Implementation Brief: Task P4-routes-workspace — Port daemon workspace route batch

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-routes-workspace
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspaces.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspace-files.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/files.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/e2e-event-triggers.ts`
> - **Target**: `apps/core-daemon/src/routes/workspaces.ts`, `apps/core-daemon/src/routes/workspace-files.ts`, `apps/core-daemon/src/routes/runs.ts`, `apps/core-daemon/src/routes/files.ts`, `apps/core-daemon/src/routes/e2e-event-triggers.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel
> - **Blocks**: P4-daemon-routes-register
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-routes-workspace";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon workspace route batch.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspaces.ts` | `apps/core-daemon/src/routes/workspaces.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspace-files.ts` | `apps/core-daemon/src/routes/workspace-files.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts` | `apps/core-daemon/src/routes/runs.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/files.ts` | `apps/core-daemon/src/routes/files.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/e2e-event-triggers.ts` | `apps/core-daemon/src/routes/e2e-event-triggers.ts` | Port source behavior and apply only the adapter points listed below. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspaces.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspace-files.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/files.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/e2e-event-triggers.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon workspaces workspace-files runs files e2e-event-triggers` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-routes-workspace.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspaces.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/workspace-files.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/files.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/e2e-event-triggers.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon workspaces workspace-files runs files e2e-event-triggers`

## 6. Shared File Hazards & Dependencies

- Does not edit `apps/core-daemon/src/app.ts`; P4-daemon-routes-register owns registration.

**Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel.
**Blocks**: P4-daemon-routes-register.
