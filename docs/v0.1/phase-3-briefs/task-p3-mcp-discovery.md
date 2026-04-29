# Implementation Brief: Task P3-mcp-discovery — Port MCP tool discovery services

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-mcp-discovery
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts`
> - **Target**: `packages/core/src/mcp-tool-discovery-service.ts`, `packages/core/src/extension-registry-service.ts`, `packages/core/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P3-misc-foundation, P2-repos-batch-3, P2-repos-batch-4, P2-security-1
> - **Blocks**: P4-mcp-tooling, P3-core-barrel
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-mcp-discovery";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` §11.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port MCP tool discovery services.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts` | `packages/core/src/mcp-tool-discovery-service.ts` | Port source behavior and apply only adapter points below. |
| `vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts` | `packages/core/src/extension-registry-service.ts` | Port source behavior and apply only adapter points below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts` | `packages/core/src/__tests__/mcp-tool-discovery-service.test.ts` | Port source tests; adapt only notifier naming/expectations. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts` | `packages/core/src/__tests__/extension-registry-service.test.ts` | Port source tests; adapt only notifier naming/expectations. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| Source point | Upstream behavior | Alaya behavior | Reason |
|---|---|---|---|
| `mcp-tool-discovery-service.ts` dependency `sseBroadcaster?.broadcastEntry` | Optional SSE broadcaster receives discovery events | Rename the dependency to `runtimeNotifier?: { notifyEntry(entry) }` and call `notifyEntry` after EventLog append | Alaya invariant §11 forbids SSE transport but keeps in-process notification |
| `extension-registry-service.ts` dependency `sseBroadcaster?.broadcastEntry` | Optional SSE broadcaster receives descriptor registration events | Rename the dependency to `runtimeNotifier?: { notifyEntry(entry) }` and call `notifyEntry` after EventLog append | Alaya invariant §11 |
| MCP discovery tests | Mock and assert `broadcastEntry` | Mock and assert `notifyEntry` with the same call counts and ordering expectations | Tests must prove audit-before-notify without SSE vocabulary |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core mcp-tool-discovery extension-registry` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-3-briefs/reports/task-p3-mcp-discovery.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core mcp-tool-discovery extension-registry`

## 6. Shared File Hazards & Dependencies

- Does not touch daemon-side MCP files; P4-mcp-tooling owns those.

**Prerequisite**: P3-misc-foundation, P2-repos-batch-3, P2-repos-batch-4, P2-security-1.
**Blocks**: P4-mcp-tooling, P3-core-barrel.
