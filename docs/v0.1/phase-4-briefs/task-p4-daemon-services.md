# Implementation Brief: Task P4-daemon-services — Port daemon services and runtime helper files

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-daemon-services
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/services/principal-coding-availability.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/services/environment-status-service.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/services/embedding-status-service.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-topology-audit-service.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/services/config-service.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-approval-service.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/services/workspace-engine-config-repo.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-defaults.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/server-options.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/files-data-dir.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/zero-day-policies.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/security-status-bootstrap.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/budget-wiring.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/narrative-budget-repo.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/compute-routing-resolver.ts`
> - **Target**: `apps/core-daemon/src/services/`, `apps/core-daemon/src/*.ts helpers`
> - **Size**: L
> - **Prerequisite**: P4-daemon-startup-ordering
> - **Blocks**: P4-mcp-memory-tools, P4-mcp-server, P4-daemon-routes-register
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-daemon-services";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon services and runtime helper files.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/services/principal-coding-availability.ts` | `apps/core-daemon/src/services/principal-coding-availability.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/services/environment-status-service.ts` | `apps/core-daemon/src/services/environment-status-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/services/embedding-status-service.ts` | `apps/core-daemon/src/services/embedding-status-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-topology-audit-service.ts` | `apps/core-daemon/src/services/soul-topology-audit-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/services/config-service.ts` | `apps/core-daemon/src/services/config-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-approval-service.ts` | `apps/core-daemon/src/services/soul-approval-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/services/workspace-engine-config-repo.ts` | `apps/core-daemon/src/services/workspace-engine-config-repo.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-defaults.ts` | `apps/core-daemon/src/daemon-defaults.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/server-options.ts` | `apps/core-daemon/src/server-options.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/files-data-dir.ts` | `apps/core-daemon/src/files-data-dir.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/zero-day-policies.ts` | `apps/core-daemon/src/zero-day-policies.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/security-status-bootstrap.ts` | `apps/core-daemon/src/security-status-bootstrap.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/budget-wiring.ts` | `apps/core-daemon/src/budget-wiring.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/narrative-budget-repo.ts` | `apps/core-daemon/src/narrative-budget-repo.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/compute-routing-resolver.ts` | `apps/core-daemon/src/compute-routing-resolver.ts` | Port source behavior and apply only the adapter points listed below. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/principal-coding-availability.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/environment-status-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/embedding-status-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-topology-audit-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/config-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-approval-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/workspace-engine-config-repo.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-defaults.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/server-options.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/files-data-dir.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/zero-day-policies.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/security-status-bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/budget-wiring.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/narrative-budget-repo.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/compute-routing-resolver.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon services security-status embedding-status budget` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-daemon-services.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/principal-coding-availability.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/environment-status-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/embedding-status-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-topology-audit-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/config-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-approval-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/workspace-engine-config-repo.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-defaults.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/server-options.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/files-data-dir.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/zero-day-policies.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/security-status-bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/budget-wiring.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/narrative-budget-repo.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/compute-routing-resolver.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon services security-status embedding-status budget`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-daemon-startup-ordering.
**Blocks**: P4-mcp-memory-tools, P4-mcp-server, P4-daemon-routes-register.
