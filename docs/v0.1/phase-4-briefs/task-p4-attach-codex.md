# Implementation Brief: Task P4-attach-codex — Implement alaya attach codex

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-attach-codex
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/cli/attach-codex.ts`, `apps/core-daemon/src/__tests__/attach-codex.test.ts`
> - **Size**: M
> - **Prerequisite**: P4-cli-bridge, P4-profile-mutation, P4-mcp-server
> - **Blocks**: Gate-4 demo
> - **Closing readiness label**: cli-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-attach-codex";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §21-§24` and `docs/handbook/architecture.md §Surface Shape`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver implement alaya attach codex.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/cli/attach-codex.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `apps/core-daemon/src/__tests__/attach-codex.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "attach codex"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-attach-codex.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `cli-consumable` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "attach codex"`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-cli-bridge, P4-profile-mutation, P4-mcp-server.
**Blocks**: Gate-4 demo.
