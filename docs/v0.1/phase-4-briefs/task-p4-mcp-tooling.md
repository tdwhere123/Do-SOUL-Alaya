# Implementation Brief: Task P4-mcp-tooling — Port daemon MCP catalog and runtime registry

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-mcp-tooling
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/mcp-runtime-registry.test.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime.test.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime-bootstrap.test.ts`
> - **Target**: `apps/core-daemon/src/daemon-mcp-tooling.ts`, `apps/core-daemon/src/mcp-runtime-registry.ts`, `apps/core-daemon/src/mcp-catalog.ts`, `apps/core-daemon/src/__tests__/`
> - **Size**: L
> - **Prerequisite**: P3-mcp-discovery, P4-daemon-glue, P4-daemon-services
> - **Blocks**: P4-mcp-memory-tools
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-mcp-tooling";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon MCP catalog and runtime registry as an
implementation prerequisite for Alaya's first-party memory tool
surface. This card does not by itself close `mcp-consumable`.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts` | `apps/core-daemon/src/daemon-mcp-tooling.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts` | `apps/core-daemon/src/mcp-runtime-registry.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts` | `apps/core-daemon/src/mcp-catalog.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/mcp-runtime-registry.test.ts` | `apps/core-daemon/src/__tests__/mcp-runtime-registry.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime.test.ts` | `apps/core-daemon/src/__tests__/tool-runtime.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime-bootstrap.test.ts` | `apps/core-daemon/src/__tests__/tool-runtime-bootstrap.test.ts` | Port source behavior and apply only the adapter points listed below. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/mcp-runtime-registry.test.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime.test.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime-bootstrap.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon mcp-runtime tool-runtime` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-mcp-tooling.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready`; `mcp-consumable` waits for P4-mcp-memory-tools, P4-mcp-server, and attached-agent proof | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` do not mark this card alone as `mcp-consumable` |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/mcp-runtime-registry.test.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime.test.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/__tests__/tool-runtime-bootstrap.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon mcp-runtime tool-runtime`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P3-mcp-discovery, P4-daemon-glue, P4-daemon-services.
**Blocks**: P4-mcp-memory-tools.
