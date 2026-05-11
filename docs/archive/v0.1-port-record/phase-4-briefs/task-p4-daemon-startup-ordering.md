# Implementation Brief: Task P4-daemon-startup-ordering — Port daemon startup ordering and Garden runtime wiring

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-daemon-startup-ordering
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/garden-runtime.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-runtime-helpers.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/worker-runtime-wiring.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts`
> - **Target**: `apps/core-daemon/src/garden-runtime.ts`, `apps/core-daemon/src/daemon-runtime-helpers.ts`, `apps/core-daemon/src/worker-runtime-wiring.ts`, `apps/core-daemon/src/background/bootstrap.ts`, `apps/core-daemon/src/index.ts`
> - **Size**: L
> - **Prerequisite**: P4-daemon-skeleton, P4-sse-strip, P3-core-barrel, P2-barrel-storage, P2-barrel-soul, P1-engine-gateway-mcp
> - **Blocks**: P4-routes-*, P4-daemon-services, P4-daemon-glue, P4-cli-bridge, P4-trust-state, P4-mcp-tooling, P4-mcp-memory-tools, P4-mcp-server
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-daemon-startup-ordering";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon startup ordering and Garden runtime wiring.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/garden-runtime.ts` | `apps/core-daemon/src/garden-runtime.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-runtime-helpers.ts` | `apps/core-daemon/src/daemon-runtime-helpers.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/worker-runtime-wiring.ts` | `apps/core-daemon/src/worker-runtime-wiring.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts` | `apps/core-daemon/src/background/bootstrap.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts` | `apps/core-daemon/src/index.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Matrix And Recovery Guardrails

| Adapter point | Vendor before | Alaya after | Reviewer witness |
|---|---|---|---|
| Startup sequencing | Vendor daemon builds DB, repos, services, Garden/runtime wiring, then server/MCP surfaces in explicit startup code | Preserve explicit order; Alaya may remove GUI/TUI/SSE startup legs only through `P4-sse-strip` | `rg -n "initialize|repo|Garden|MCP|start" apps/core-daemon/src/index.ts apps/core-daemon/src/garden-runtime.ts` shows staged wiring rather than hidden constructor work |
| SSE replacement | Vendor startup wires `SseManager` | `RuntimeNotifier` replaces only the in-process notification leg; no HTTP SSE transport | `rg -n "SseManager|sseManager|text/event-stream|EventSource|TransformStream" apps/core-daemon/src --glob '!__tests__/**'` returns zero |
| Garden runtime | Vendor `garden-runtime.ts` wires real Garden services/scheduler roles | Port real Garden runtime behavior; prune only GUI/TUI/SSE-only branches with explicit comments | targeted `garden-runtime` tests exercise real services, not `{ ready: true }` stubs |
| Worker runtime | Vendor `worker-runtime-wiring.ts` wires worker lifecycle, normalizer, delegation, trust/safety services | Port real wiring or return `BLOCKED` if a dependency is outside Phase 4 scope | `worker-runtime-wiring.ts` is not a placeholder and imports real services |

Forbidden in this card:

- Starting background work from a synchronous constructor or `void ...catch(() => undefined)`.
- Replacing startup ordering with a numeric `startupStep` facade.
- Creating `daemon-handle.ts`, `daemon-service-graph.ts`, `DaemonRouteHandler`, or `context.daemon`.
- Stubbing Garden or worker runtime services where vendor has real implementations.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/garden-runtime.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-runtime-helpers.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/worker-runtime-wiring.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon startup garden-runtime embedding-backfill` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-daemon-startup-ordering.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Startup has no forbidden rewrite artifacts or placeholder runtime stubs | `rtk rg -n "daemon-handle|daemon-service-graph|DaemonRouteHandler|context\\.daemon|ready: true|TODO\\(P4-daemon-startup-ordering\\)" apps/core-daemon/src` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/garden-runtime.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-runtime-helpers.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/worker-runtime-wiring.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon startup garden-runtime embedding-backfill`
6. `rtk rg -n "daemon-handle|daemon-service-graph|DaemonRouteHandler|context\\.daemon|ready: true|TODO\\(P4-daemon-startup-ordering\\)" apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

- Touches `apps/core-daemon/src/index.ts`; route registration still belongs to P4-daemon-routes-register.

**Prerequisite**: P4-daemon-skeleton, P4-sse-strip, P3-core-barrel, P2-barrel-storage, P2-barrel-soul, P1-engine-gateway-mcp.
**Blocks**: P4-routes-*, P4-daemon-services, P4-daemon-glue, P4-cli-bridge, P4-trust-state, P4-mcp-tooling, P4-mcp-memory-tools, P4-mcp-server.
