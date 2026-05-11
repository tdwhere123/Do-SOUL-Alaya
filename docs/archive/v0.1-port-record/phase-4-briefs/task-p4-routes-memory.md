# Implementation Brief: Task P4-routes-memory — Port daemon memory route batch

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-routes-memory
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/memories.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/recall.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/evidence.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/claims.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/syntheses.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/proposals.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/global-memory.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/signals.ts`
> - **Target**: `apps/core-daemon/src/routes/memories.ts`, `apps/core-daemon/src/routes/recall.ts`, `apps/core-daemon/src/routes/evidence.ts`, `apps/core-daemon/src/routes/claims.ts`, `apps/core-daemon/src/routes/syntheses.ts`, `apps/core-daemon/src/routes/proposals.ts`, `apps/core-daemon/src/routes/global-memory.ts`, `apps/core-daemon/src/routes/signals.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel
> - **Blocks**: P4-daemon-routes-register
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-routes-memory";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon memory route batch.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/memories.ts` | `apps/core-daemon/src/routes/memories.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/recall.ts` | `apps/core-daemon/src/routes/recall.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/evidence.ts` | `apps/core-daemon/src/routes/evidence.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/claims.ts` | `apps/core-daemon/src/routes/claims.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/syntheses.ts` | `apps/core-daemon/src/routes/syntheses.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/proposals.ts` | `apps/core-daemon/src/routes/proposals.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/global-memory.ts` | `apps/core-daemon/src/routes/global-memory.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/signals.ts` | `apps/core-daemon/src/routes/signals.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Route Adapter Matrix And Recovery Guardrails

| Adapter point | Vendor before | Alaya after | Reviewer witness |
|---|---|---|---|
| Route registration | Vendor exports `register*Routes(app, services)` functions and receives typed route service bags | Preserve that shape; only package names and Alaya-pruned forbidden surfaces may change | `rg -n "export function register|Hono" apps/core-daemon/src/routes` finds route registration functions |
| Service dependencies | Vendor route files import narrow service interfaces from core/storage/protocol | Preserve narrow typed dependencies; do not route through daemon-wide handles | no `context.daemon`, `DaemonRouteHandler`, or `AlayaDaemonHandle` in route files |
| Product pruning | Vendor GUI/TUI/chat-only or SSE-only paths may exist | Prune only paths forbidden by invariants §11 and §21, with a short comment and report note | completion report lists every pruned branch and source line group |
| Memory mutation | Vendor proposal/governance routes keep durable changes behind service/proposal boundaries | Durable memory writes still go through proposal/governance services; no direct route-to-repo mutation | route tests exercise service calls and validation, not repo writes from handlers |

Forbidden in this card: orphan `routes/memory.ts`, route barrels, custom URL-loop frameworks, `DaemonRouteHandler`, `context.daemon`, `daemon-handle.ts`, and `daemon-service-graph.ts`.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/memories.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/recall.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/evidence.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/claims.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/syntheses.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/proposals.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/global-memory.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/signals.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon memories recall evidence claims syntheses proposals global-memory signals` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-routes-memory.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Route files preserve typed service-bag registration and avoid recovery-forbidden artifacts | `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph" apps/core-daemon/src/routes apps/core-daemon/src` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/memories.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/recall.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/evidence.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/claims.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/syntheses.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/proposals.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/global-memory.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/signals.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon memories recall evidence claims syntheses proposals global-memory signals`
6. `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph" apps/core-daemon/src/routes apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

- Does not edit `apps/core-daemon/src/app.ts`; P4-daemon-routes-register owns registration.

**Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel.
**Blocks**: P4-daemon-routes-register.
