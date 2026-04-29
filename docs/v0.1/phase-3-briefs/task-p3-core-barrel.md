# Implementation Brief: Task P3-core-barrel — Export Phase 2 and Phase 3 core services

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-core-barrel
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/index.ts`
> - **Target**: `packages/core/src/index.ts`
> - **Size**: S
> - **Prerequisite**: P2-svc-*, P2-security-*, P3-conversation, P3-mcp-discovery, P3-run-lifecycle, P3-misc-services
> - **Blocks**: Gate-3, P4-daemon-startup-ordering, P4-routes-*
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-core-barrel";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver export Phase 2 and Phase 3 core services, including
ConversationService and ContextLensAssembler for the P4 daemon memory
tool handler.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/index.ts` | `packages/core/src/index.ts` | Port source behavior and apply only the adapter points listed below. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-3-briefs/reports/task-p3-core-barrel.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Barrel exports the recall-to-model producer needed by P4-mcp-memory-tools | P4 daemon imports `ContextLensAssembler` and `ConversationContextLensAssemblerPort` from `@do-soul/alaya-core` without private path imports |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core`

## 6. Shared File Hazards & Dependencies

- Owns `packages/core/src/index.ts` after P1-core-skeleton.

**Prerequisite**: P2-svc-*, P2-security-*, P3-conversation, P3-mcp-discovery, P3-run-lifecycle, P3-misc-services.
**Blocks**: Gate-3, P4-daemon-startup-ordering, P4-routes-*.
