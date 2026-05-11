# Implementation Brief: Task P4-daemon-routes-register — Register Phase 4 daemon routes

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-daemon-routes-register
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts`
> - **Target**: `apps/core-daemon/src/app.ts`
> - **Size**: S
> - **Prerequisite**: P4-routes-memory, P4-routes-governance, P4-routes-soul, P4-routes-workspace, P4-routes-config, P4-daemon-middleware
> - **Blocks**: Gate-4 demo
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-daemon-routes-register";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver register Phase 4 daemon routes.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts` | `apps/core-daemon/src/app.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 App Registration Adapter Matrix And Recovery Guardrails

| Adapter point | Vendor before | Alaya after | Reviewer witness |
|---|---|---|---|
| HTTP framework | Vendor `app.ts` builds a Hono app with `cors`, `bodyLimit`, and middleware composition | Preserve Hono and middleware composition; only package names, pruned routes, and Alaya service type names may change | `rg -n "from \"hono\"|cors\\(|bodyLimit\\(|onError|timingSafeEqual" apps/core-daemon/src/app.ts` |
| Token gate | Vendor uses timing-safe request token comparison | Preserve timing-safe token gate for daemon HTTP; route-level ad hoc auth is not a substitute | app tests cover missing/invalid token and code inspection finds `timingSafeEqual` |
| Route registration | Vendor registers typed `register*Routes(app, services)` calls | Register every Phase 4 route file closed by P4-routes-* and no orphan route files | `rg -n "register.*Routes\\(" apps/core-daemon/src/app.ts` matches the route-card union |
| Service dependencies | Vendor `CoreDaemonServices` exposes typed domain services | Preserve typed service bags; no monolithic `daemon` facade, no `unknown` service getters | no `DaemonRouteHandler`, `context.daemon`, `daemon-handle`, `daemon-service-graph`, or `Promise<unknown>` in daemon source |
| Product pruning | Vendor routes outside Alaya scope are omitted | Omit only routes explicitly pruned by route cards; do not add orphan `routes/index.ts`, `routes/memory.ts`, `routes/workspace.ts`, `routes/status.ts`, `routes/health.ts`, or `routes/mcp.ts` | `test ! -f` checks for orphan route files |

Forbidden in this card: replacing Hono with a custom dispatcher or for-loop URL router, adding `DaemonRouteHandler`, routing through `context.daemon`, introducing `daemon-handle.ts`/`daemon-service-graph.ts`, and registering orphan routes not owned by a Phase 4 route card.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon routes app` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-daemon-routes-register.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | `app.ts` preserves Hono middleware/token-gate registration and no forbidden facade/orphan route artifact exists | `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph|Promise<unknown>" apps/core-daemon/src` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon routes app`
6. `rtk rg -n "from \"hono\"|cors\\(|bodyLimit\\(|timingSafeEqual|register.*Routes\\(" apps/core-daemon/src/app.ts`
7. `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph|Promise<unknown>" apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

- Owns `apps/core-daemon/src/app.ts` final route registration.

**Prerequisite**: P4-routes-memory, P4-routes-governance, P4-routes-soul, P4-routes-workspace, P4-routes-config, P4-daemon-middleware.
**Blocks**: Gate-4 demo.
