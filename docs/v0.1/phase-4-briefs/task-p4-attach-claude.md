# Implementation Brief: Task P4-attach-claude — Implement alaya attach claude-code

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-attach-claude
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/cli/attach-claude.ts`, `apps/core-daemon/src/__tests__/attach-claude.test.ts`
> - **Size**: M
> - **Prerequisite**: P4-cli-bridge, P4-profile-mutation, P4-mcp-memory-tools, P4-mcp-server
> - **Blocks**: Gate-4 demo
> - **Closing readiness label**: cli-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-attach-claude";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21-§24` and `docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver implement alaya attach claude-code.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/cli/attach-claude.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/attach-claude.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

- Install profile writes explicit Claude Code operator instructions for
  the P4-mcp-memory-tools contract: call `soul.recall` before memory-
  sensitive work, use `soul.open_pointer` before citing recalled
  evidence, create new memory only through `soul.emit_candidate_signal`
  or `soul.propose_memory_update`, and report delivery usage with
  `soul.report_context_usage`.
- The profile must not mention `memory.*` aliases.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "attach claude"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-attach-claude.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `cli-consumable` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Claude Code profile instructions mention the exact public `soul.*` memory tools and exclude `memory.*` aliases | Targeted attach test asserts the rendered profile text |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "attach claude"`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-cli-bridge, P4-profile-mutation, P4-mcp-memory-tools, P4-mcp-server.
**Blocks**: Gate-4 demo.
