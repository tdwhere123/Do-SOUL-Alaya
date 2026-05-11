# Implementation Brief: Task P4-daemon-middleware — Port daemon middleware

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-daemon-middleware
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/middleware/error-handler.ts`
> - **Target**: `apps/core-daemon/src/middleware/error-handler.ts`
> - **Size**: S
> - **Prerequisite**: P4-daemon-skeleton
> - **Blocks**: P4-daemon-routes-register
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-daemon-middleware";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon middleware.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/middleware/error-handler.ts` | `apps/core-daemon/src/middleware/error-handler.ts` | Copy first; only package-name/path rewrites are allowed. |

### 2.2 Port Rules

- Port mode is `trivial-copy`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Middleware Recovery Guardrails

This is a `trivial-copy` card. The only allowed edits are package-name/path
rewrites required for Alaya. It must not become a custom framework,
request-dispatch, auth, CORS, or body-limit rewrite; those seams stay in
vendor-shaped `app.ts` and P4-daemon-routes-register.

Forbidden in this card: replacing Hono middleware composition, adding a route
dispatcher, introducing `DaemonRouteHandler`, or moving token/body/CORS behavior
out of `app.ts`.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per trivial-copy rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/middleware/error-handler.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon error-handler --passWithNoTests` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-daemon-middleware.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Middleware remains a trivial-copy port and no custom dispatcher artifact is introduced | `rtk rg -n "DaemonRouteHandler|context\\.daemon|daemon-handle|daemon-service-graph" apps/core-daemon/src` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/middleware/error-handler.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon error-handler --passWithNoTests`
6. `rtk rg -n "DaemonRouteHandler|context\\.daemon|daemon-handle|daemon-service-graph" apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-daemon-skeleton.
**Blocks**: P4-daemon-routes-register.
