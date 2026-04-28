# Implementation Brief: Task P1-engine-gateway-mcp — Port engine gateway MCP bridge and provider registry skeleton

> - **Phase**: 1
> - **Wave**: 1
> - **Card ID**: P1-engine-gateway-mcp
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/engine-gateway/package.json`, `vendor/do-what-new-snapshot/packages/engine-gateway/tsconfig.json`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/index.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/mcp-bridge.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-registry.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-types.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/soul-tool-specs.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/mcp-bridge.test.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/provider-registry.test.ts`
> - **Target**: `packages/engine-gateway/package.json`, `packages/engine-gateway/tsconfig.json`, `packages/engine-gateway/src/index.ts`, `packages/engine-gateway/src/mcp-bridge.ts`, `packages/engine-gateway/src/provider/provider-registry.ts`, `packages/engine-gateway/src/provider/provider-types.ts`, `packages/engine-gateway/src/provider/soul-tool-specs.ts`, `packages/engine-gateway/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P1-protocol
> - **Blocks**: P4-mcp-server
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-1-briefs/README.md` row "P1-engine-gateway-mcp";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port engine gateway MCP bridge and provider registry skeleton.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/engine-gateway/package.json` | `packages/engine-gateway/package.json` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/tsconfig.json` | `packages/engine-gateway/tsconfig.json` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/src/index.ts` | `packages/engine-gateway/src/index.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/src/mcp-bridge.ts` | `packages/engine-gateway/src/mcp-bridge.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-registry.ts` | `packages/engine-gateway/src/provider/provider-registry.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-types.ts` | `packages/engine-gateway/src/provider/provider-types.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/soul-tool-specs.ts` | `packages/engine-gateway/src/provider/soul-tool-specs.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/mcp-bridge.test.ts` | `packages/engine-gateway/src/__tests__/mcp-bridge.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/provider-registry.test.ts` | `packages/engine-gateway/src/__tests__/provider-registry.test.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| Source area | Change | Justification |
|---|---|---|
| `src/provider/provider-registry.ts` AI SDK adapter imports | Replace with a fail-closed registry skeleton | Provider adapters are deferred to #BL-008 |
| `src/index.ts` exports | Export only the MCP bridge, provider registry skeleton, provider types, and soul tool specs | Avoid false availability for deferred provider/tool paths |

## 3. Deferred

- Full AI SDK provider adapters, `api-conversation-engine.ts`, and `tools/` subdir — deferred to backlog #BL-008.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/engine-gateway/package.json\",\"vendor/do-what-new-snapshot/packages/engine-gateway/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/index.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/mcp-bridge.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-registry.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-types.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/soul-tool-specs.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/mcp-bridge.test.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/provider-registry.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-engine-gateway mcp-bridge provider-registry` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-1-briefs/reports/task-p1-engine-gateway-mcp.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/engine-gateway/package.json\",\"vendor/do-what-new-snapshot/packages/engine-gateway/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/index.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/mcp-bridge.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-registry.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-types.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/soul-tool-specs.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/mcp-bridge.test.ts\",\"vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/provider-registry.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/engine-gateway`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-engine-gateway mcp-bridge provider-registry`

## 6. Shared File Hazards & Dependencies

- Writes `packages/engine-gateway/src/index.ts`; no other Phase 1 card touches engine-gateway exports.

**Prerequisite**: P1-protocol.
**Blocks**: P4-mcp-server.
