# Implementation Brief: Task P4-routes-governance — Port daemon governance route batch

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-routes-governance
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/governance.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/green-status.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/overrides.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/security-status.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/conflict-matrix.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/budget.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/health-journal.ts`
> - **Target**: `apps/core-daemon/src/routes/governance.ts`, `apps/core-daemon/src/routes/green-status.ts`, `apps/core-daemon/src/routes/overrides.ts`, `apps/core-daemon/src/routes/security-status.ts`, `apps/core-daemon/src/routes/conflict-matrix.ts`, `apps/core-daemon/src/routes/budget.ts`, `apps/core-daemon/src/routes/health-journal.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel
> - **Blocks**: P4-daemon-routes-register
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-routes-governance";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon governance route batch.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/governance.ts` | `apps/core-daemon/src/routes/governance.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/green-status.ts` | `apps/core-daemon/src/routes/green-status.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/overrides.ts` | `apps/core-daemon/src/routes/overrides.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/security-status.ts` | `apps/core-daemon/src/routes/security-status.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/conflict-matrix.ts` | `apps/core-daemon/src/routes/conflict-matrix.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/budget.ts` | `apps/core-daemon/src/routes/budget.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/health-journal.ts` | `apps/core-daemon/src/routes/health-journal.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Route Adapter Matrix And Recovery Guardrails

| Adapter point | Vendor before | Alaya after | Reviewer witness |
|---|---|---|---|
| Route registration | Vendor exports `register*Routes(app, services)` functions against Hono | Preserve route registration functions and Hono handler shape; P4-daemon-routes-register owns only the final `app.ts` call list | `rg -n "export function register|Hono" apps/core-daemon/src/routes/governance.ts apps/core-daemon/src/routes/green-status.ts apps/core-daemon/src/routes/overrides.ts apps/core-daemon/src/routes/security-status.ts apps/core-daemon/src/routes/conflict-matrix.ts apps/core-daemon/src/routes/budget.ts apps/core-daemon/src/routes/health-journal.ts` |
| Service dependencies | Vendor governance routes receive narrow policy, security, green, budget, and health-journal services | Preserve narrow typed service bags; do not replace them with an all-purpose daemon facade | no `context.daemon`, `DaemonRouteHandler`, or `AlayaDaemonHandle` in these route files |
| Runtime event/audit order | Vendor routes delegate durable changes to services that own event/audit sequencing | Keep durable mutations inside service methods; routes may validate/translate HTTP payloads only | tests assert service calls and failure envelopes, not direct repo writes from route handlers |
| Contract preservation | Vendor validators/caps are part of the HTTP contract | Preserve validation behavior such as health-journal schema parsing and result caps unless a listed Alaya invariant forces a prune | reviewer compares target route bodies against cited vendor sources |

Forbidden in this card: orphan route barrels, custom URL-loop frameworks, `DaemonRouteHandler`, `context.daemon`, `daemon-handle.ts`, `daemon-service-graph.ts`, direct repo mutation from route handlers, and weakening vendor validators/caps without an explicit adapter row.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/governance.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/green-status.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/overrides.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/security-status.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/conflict-matrix.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/budget.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/health-journal.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon governance green-status overrides security-status conflict-matrix budget health-journal` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-routes-governance.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Route files preserve typed service-bag registration and avoid recovery-forbidden artifacts | `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph" apps/core-daemon/src/routes apps/core-daemon/src` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/governance.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/green-status.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/overrides.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/security-status.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/conflict-matrix.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/budget.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/health-journal.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon governance green-status overrides security-status conflict-matrix budget health-journal`
6. `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph" apps/core-daemon/src/routes apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

- Does not edit `apps/core-daemon/src/app.ts`; P4-daemon-routes-register owns registration.

**Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel.
**Blocks**: P4-daemon-routes-register.
