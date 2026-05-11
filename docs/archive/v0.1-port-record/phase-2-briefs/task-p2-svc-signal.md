# Implementation Brief: Task P2-svc-signal — Port SignalService

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-svc-signal
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/signal-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/signal-service.test.ts`
> - **Target**: `packages/core/src/`, `packages/core/src/__tests__/`
> - **Size**: S
> - **Prerequisite**: P2-svc-output-shaping, P2-svc-narrative-budget, P2-svc-health-journal, P2-svc-event-publisher, P2-repos-batch-6, P2-svc-evidence
> - **Blocks**: P2-svc-memory, P2-garden-batch-3
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-svc-signal";
`docs/handbook/port-protocol.md §2 adapt-and-port`;
`docs/handbook/invariants.md §11` forbids SSE transport.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port SignalService.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/signal-service.ts` | `packages/core/src/signal-service.ts` | Copy first; package-name rewrite plus the SSE-to-runtime-notifier adapter point in §2.3. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/signal-service.test.ts` | `packages/core/src/__tests__/signal-service.test.ts` | Copy first; package-name rewrite plus the SSE-to-runtime-notifier adapter point in §2.3. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Adapter Points

| Source construct | Target construct | Reason |
|---|---|---|
| `SignalSseBroadcaster` with `broadcastEntry(entry)` | `SignalRuntimeNotifier` with `notifyEntry(entry)` | Invariant §11 forbids SSE transport; Phase 2 may preserve only in-process notification semantics. |
| Dependency property `sseBroadcaster` | Dependency property `runtimeNotifier` | Keeps source ordering while removing GUI/TUI SSE terminology. |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/signal-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/signal-service.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "SignalService"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-svc-signal.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/signal-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/signal-service.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "SignalService"`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel serializes service exports after Phase 3.

**Prerequisite**: P2-svc-output-shaping, P2-svc-narrative-budget, P2-svc-health-journal, P2-svc-event-publisher, P2-repos-batch-6, P2-svc-evidence.
**Blocks**: P2-svc-memory, P2-garden-batch-3.
