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

### 2.3 Service Adapter Matrix And Recovery Guardrails

| Adapter point | Vendor before | Alaya after | Reviewer witness |
|---|---|---|---|
| Service files | Vendor ships seven daemon service files under `apps/core-daemon/src/services/` | Port all seven files with package-name/path adaptations only unless a row below says otherwise | `find apps/core-daemon/src/services -maxdepth 1 -type f` includes every §2.1 service file |
| Runtime helper files | Vendor helper files are standalone modules used by startup/routes/MCP | Port helper modules as modules; do not inline their logic into startup, routes, or a service graph | `rg -n "from \"./(daemon-defaults|server-options|files-data-dir|zero-day-policies|security-status-bootstrap|budget-wiring|narrative-budget-repo|compute-routing-resolver)" apps/core-daemon/src` finds imports where wired |
| Evidence/dynamics services | Vendor provides real service behavior through P2/P3 core services and daemon service ports | Compose the real services; no `findById: async () => null`, hardcoded `activation_score`, `retention_score`, or `decay_profile` placeholders | `rtk rg -n "findById: async \\(\\) => null|activation_score: 0\\.9|retention_score: 0\\.9|decay_profile: \\\"stable\\\"" apps/core-daemon/src` returns zero hits |
| Engine config | Vendor has `WorkspaceEngineConfigRepo` | Port and use `services/workspace-engine-config-repo.ts`; do not hand-write partial adapters in startup/service composition | `rg -n "WorkspaceEngineConfigRepo|workspace-engine-config-repo" apps/core-daemon/src` finds the ported repo and its wiring |
| Service composition boundary | Vendor startup composes typed services directly | Keep typed services visible to routes/MCP; do not hide them behind `daemon-service-graph.ts` or `unknown` getters | no `daemon-service-graph`, `daemon-handle`, or `Promise<unknown>` in core-daemon source |

Forbidden in this card: service stubs, inline substitute implementations for cited vendor files, `daemon-service-graph.ts`, `daemon-handle.ts`, daemon-wide `unknown` getters, and moving proposal/review handlers into this card's helper files.

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
| AC7 | Every §2 service/helper file exists and no recovery-forbidden stub or service-graph artifact is introduced | `rtk rg -n "findById: async \\(\\) => null|activation_score: 0\\.9|retention_score: 0\\.9|decay_profile: \\\"stable\\\"|daemon-service-graph|daemon-handle|Promise<unknown>" apps/core-daemon/src` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/principal-coding-availability.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/environment-status-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/embedding-status-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-topology-audit-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/config-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/soul-approval-service.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/services/workspace-engine-config-repo.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-defaults.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/server-options.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/files-data-dir.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/zero-day-policies.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/security-status-bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/budget-wiring.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/narrative-budget-repo.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/compute-routing-resolver.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon services security-status embedding-status budget`
6. `rtk rg -n "findById: async \\(\\) => null|activation_score: 0\\.9|retention_score: 0\\.9|decay_profile: \\\"stable\\\"|daemon-service-graph|daemon-handle|Promise<unknown>" apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-daemon-startup-ordering.
**Blocks**: P4-mcp-memory-tools, P4-mcp-server, P4-daemon-routes-register.
