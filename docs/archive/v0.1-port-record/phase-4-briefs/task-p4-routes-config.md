# Implementation Brief: Task P4-routes-config — Port daemon config route batch

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-routes-config
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/config.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/project-mapping.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/shared.ts`
> - **Target**: `apps/core-daemon/src/routes/config.ts`, `apps/core-daemon/src/routes/project-mapping.ts`, `apps/core-daemon/src/routes/shared.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel
> - **Blocks**: P4-daemon-routes-register, P4-inspector-server
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-routes-config";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon config route batch.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/config.ts` | `apps/core-daemon/src/routes/config.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/project-mapping.ts` | `apps/core-daemon/src/routes/project-mapping.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/shared.ts` | `apps/core-daemon/src/routes/shared.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Route Adapter Matrix And Recovery Guardrails

| Adapter point | Vendor before | Alaya after | Reviewer witness |
|---|---|---|---|
| Route registration | Vendor exports Hono `register*Routes(app, services)` functions | Preserve Hono route modules and the small shared helper seam; P4-daemon-routes-register owns final registration | `rg -n "export function register|parseJsonBody|Hono" apps/core-daemon/src/routes/config.ts apps/core-daemon/src/routes/project-mapping.ts apps/core-daemon/src/routes/shared.ts` |
| Service dependencies | Vendor config/project-mapping routes receive narrow config/workspace services | Preserve typed service bags; do not replace with a daemon-wide facade | no `context.daemon`, `DaemonRouteHandler`, or `AlayaDaemonHandle` in these route files |
| Inspector contract | Vendor config patch fields are adapted for Alaya's Inspector server | Preserve `provider_url`, `secret_ref`, `model_id`, and `embedding_enabled` pass-through so the Inspector toggle is not silently dropped | route tests assert `embedding_enabled` reaches the config service or persisted envelope |
| Product pruning | Slash/worker-dispatch/surface routes are explicitly pruned by this card | Keep those routes absent; do not replace them with orphan stubs or backlog deferrals | `test ! -f apps/core-daemon/src/routes/slash-commands.ts` and same for pruned routes |

Forbidden in this card: replacing `routes/shared.ts` with a custom route framework, orphan `routes/status.ts`/`routes/health.ts`/`routes/mcp.ts`/`routes/memory.ts`, `DaemonRouteHandler`, `context.daemon`, `daemon-handle.ts`, `daemon-service-graph.ts`, and silently dropping `embedding_enabled`.

## 3. Pruned

- `routes/slash-commands.ts` is product-scope pruned. Alaya does not expose
  upstream agent-local slash metadata or dispatch.
- `routes/worker-dispatch.ts` is product-scope pruned. Alaya v0.1 exposes
  memory through MCP and plain CLI, not upstream chat worker dispatch routes.
- `routes/surfaces.ts` is product-scope pruned. Upstream surfaces are
  GUI panel abstractions; per the 2026-04-29 narrowing of invariant
  §21 Alaya allows only memory-tooling surfaces (Memory Inspector +
  daemon-config panel), and those have no need for the upstream surface
  routing concept. The Inspector talks to daemon HTTP routes directly.
- `routes/surface-bindings.ts` is product-scope pruned. Same rationale:
  surface-bindings are cross-cutting permission + event routing for
  upstream GUI panels. Alaya has no upstream-shaped GUI panels.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/config.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/project-mapping.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/shared.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon config project-mapping shared` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and prune decisions | `docs/v0.1/phase-4-briefs/reports/task-p4-routes-config.md` exists and does not defer product-pruned slash, chat-worker dispatch, or surfaces / surface-bindings routes |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Config routes preserve typed service-bag registration, pruned routes remain absent, and Inspector `embedding_enabled` is forwarded | `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph" apps/core-daemon/src/routes apps/core-daemon/src` returns zero hits; config tests cover `embedding_enabled` |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/config.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/project-mapping.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/shared.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon config project-mapping shared`
6. `rtk rg -n "DaemonRouteHandler|context\\.daemon|AlayaDaemonHandle|daemon-handle|daemon-service-graph" apps/core-daemon/src/routes apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

- Does not edit `apps/core-daemon/src/app.ts`; P4-daemon-routes-register owns registration.

**Prerequisite**: P4-daemon-startup-ordering, P4-sse-strip, P3-core-barrel.
**Blocks**: P4-daemon-routes-register.
