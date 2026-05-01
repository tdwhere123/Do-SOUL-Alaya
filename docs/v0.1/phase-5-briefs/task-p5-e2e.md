# Implementation Brief: Task P5-e2e — Implement v0.1 release end-to-end loop

> - **Phase**: 5
> - **Wave**: 5
> - **Card ID**: P5-e2e
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts`, `docs/v0.1/phase-5-briefs/reports/task-p5-e2e.md`
> - **Size**: M
> - **Prerequisite**: Gate-4 passed, P4-mcp-memory-tools, P5-benchmark, P5-graph-contract
> - **Blocks**: P5-final-review
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-5-briefs/README.md` row "P5-e2e";
`docs/handbook/port-protocol.md §3 requires-redesign`; `docs/handbook/invariants.md` and `docs/handbook/architecture.md §Surface Shape` when this is Alaya-original.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver implement v0.1 release end-to-end loop, including
attached-agent proof of the first-party MCP memory tools.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `docs/v0.1/phase-5-briefs/reports/task-p5-e2e.md` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

- E2E setup runs `alaya install` and `alaya attach codex` against a
  real daemon profile.
- MCP `tools/list` returns the complete P4-mcp-memory-tools `soul.*`
  catalog.
- The E2E chain calls `soul.recall`, opens a returned pointer with
  `soul.open_pointer`, then records `soul.report_context_usage` for
  the returned `delivery_id`.
- The chain emits a candidate signal, creates a proposal, rejects it
  through governance, and proves no direct durable write occurred.
- CLI fallback parity is covered by `alaya tools list` and
  `alaya tools call --json` against the same tool contract.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon e2e` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-5-briefs/reports/task-p5-e2e.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | E2E proves `tools/list -> soul.recall -> soul.open_pointer -> soul.report_context_usage` on real MCP wiring | E2E assertion records delivery id, opened pointer, and usage-proof state |
| AC8 | E2E proves candidate/proposal/governance reject without direct durable write | E2E assertion checks proposal state and memory-entry absence or unchanged durable state |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon e2e`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: Gate-4 passed, P4-mcp-memory-tools, P5-benchmark, P5-graph-contract.
**Blocks**: P5-final-review.
