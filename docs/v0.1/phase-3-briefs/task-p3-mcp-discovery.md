# Implementation Brief: Task P3-mcp-discovery — Port MCP tool discovery services

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-mcp-discovery
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts`
> - **Target**: `packages/core/src/mcp-tool-discovery-service.ts`, `packages/core/src/extension-registry-service.ts`, `packages/core/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P2-repos-batch-3, P2-repos-batch-4, P2-security-1
> - **Blocks**: P4-mcp-tooling, P3-core-barrel
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-mcp-discovery";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port MCP tool discovery services.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/mcp-tool-discovery-service.ts` | `packages/core/src/mcp-tool-discovery-service.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/extension-registry-service.ts` | `packages/core/src/extension-registry-service.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/mcp-tool-discovery-service.test.ts` | `packages/core/src/__tests__/mcp-tool-discovery-service.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/extension-registry-service.test.ts` | `packages/core/src/__tests__/extension-registry-service.test.ts` | Copy first; only package-name/path rewrites are allowed. |

### 2.2 Port Rules

- Port mode is `trivial-copy`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per trivial-copy rules | Reviewer compares target files against the cited vendor source paths and adapter points |
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

**Prerequisite**: P2-repos-batch-3, P2-repos-batch-4, P2-security-1.
**Blocks**: P4-mcp-tooling, P3-core-barrel.
