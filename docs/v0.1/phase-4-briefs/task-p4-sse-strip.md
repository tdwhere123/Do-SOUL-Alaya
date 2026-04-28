# Implementation Brief: Task P4-sse-strip — Strip upstream SSE transport from daemon paths

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-sse-strip
> - **Port mode**: requires-redesign
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/sse/`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts`
> - **Target**: `apps/core-daemon/src/sse/ (not present)`, `apps/core-daemon/src/routes/runs.ts`, `apps/core-daemon/src/background/bootstrap.ts`, `apps/core-daemon/src/index.ts`, `apps/core-daemon/src/app.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-skeleton, P2-svc-event-publisher
> - **Blocks**: P4-daemon-startup-ordering, P4-routes-workspace, P4-daemon-routes-register
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-sse-strip";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §11` and `docs/handbook/architecture.md §Runtime Write Model`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver strip upstream SSE transport from daemon paths.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/sse/` | no target; `apps/core-daemon/src/sse/` must remain absent | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts` | `apps/core-daemon/src/routes/runs.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts` | `apps/core-daemon/src/background/bootstrap.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts` | `apps/core-daemon/src/index.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts` | `apps/core-daemon/src/app.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

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
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/sse/\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "no SSE|runs"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-sse-strip.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/sse/\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "no SSE|runs"`
6. `rtk rg -n "SseManager|sseManager|text/event-stream|EventSource|TransformStream" apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

- Must land before any P4 route card touches `routes/runs.ts` or daemon startup wiring.

**Prerequisite**: P4-daemon-skeleton, P2-svc-event-publisher.
**Blocks**: P4-daemon-startup-ordering, P4-routes-workspace, P4-daemon-routes-register.
