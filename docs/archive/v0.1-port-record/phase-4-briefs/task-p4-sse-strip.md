# Implementation Brief: Task P4-sse-strip — Strip upstream SSE transport from daemon paths

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-sse-strip
> - **Port mode**: requires-redesign
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/sse/`, `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts`
> - **Target**: `apps/core-daemon/src/runtime-notifier.ts`, `apps/core-daemon/src/sse/ (not present)`, `apps/core-daemon/src/routes/runs.ts`, `apps/core-daemon/src/background/bootstrap.ts`, `apps/core-daemon/src/index.ts`, `apps/core-daemon/src/app.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-skeleton, P2-svc-event-publisher
> - **Blocks**: P4-daemon-startup-ordering, P4-routes-workspace, P4-daemon-routes-register
> - **Closing readiness label**: implementation-ready
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
| `vendor/do-what-new-snapshot/apps/core-daemon/src/sse/sse-manager.ts` | `apps/core-daemon/src/runtime-notifier.ts`; `apps/core-daemon/src/sse/` must remain absent | Alaya-specific redesign: replace external EventSource/SSE fanout with a concrete in-process `RuntimeNotifier` listener dispatcher. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts` | `apps/core-daemon/src/routes/runs.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts` | `apps/core-daemon/src/background/bootstrap.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts` | `apps/core-daemon/src/index.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts` | `apps/core-daemon/src/app.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Strip Rules and RuntimeNotifier Wiring Contract

The replacement contract is **`RuntimeNotifier`** from `packages/core/src/event-publisher.ts`:

```ts
export interface RuntimeNotifier {
  notify(runId: string, event: Phase0Event): void | Promise<void>;
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}
```

Every SSE removal MUST replace the broadcast leg with real `RuntimeNotifier`
registration. `notifyEntry` runs after `EventLog.append` + DB mutate; it never
runs before. No external HTTP listener is exposed (per invariant §21 / §11).
This card may introduce the type seam, but it MUST NOT introduce a no-op
notifier implementation to keep the build green. If the real notifier cannot be
wired without P4-daemon-startup-ordering, coordinate the two cards in the same
wave or return `BLOCKED`.

#### File-by-file before/after table

| Source file | Before | After | Verification |
|---|---|---|---|
| `vendor/.../apps/core-daemon/src/sse/sse-manager.ts` (411 LOC) | upstream `SseManager` class implements per-run subscriber registry, EventSource framing, retry/backoff, and HTTP `text/event-stream` body writer | **replace with `runtime-notifier.ts`**: keep in-process listener registration/dispatch only; delete EventSource framing, retry/backoff, HTTP body writer, and `apps/core-daemon/src/sse/` | `test -f apps/core-daemon/src/runtime-notifier.ts`; `rtk find apps/core-daemon/src -type d -name sse \| rtk wc -l` outputs `0` |
| `vendor/.../apps/core-daemon/src/routes/runs.ts` line 1 `import { TransformStream } from "node:stream/web"` | streaming import | **delete** | `rg -n "TransformStream" apps/core-daemon/src/routes/runs.ts` finds 0 |
| `vendor/.../apps/core-daemon/src/routes/runs.ts` line 25 `import type { SseManager } from "../sse/sse-manager.js"` | sse type import | **delete** | `rg -n "SseManager" apps/core-daemon/src/routes/runs.ts` finds 0 |
| `vendor/.../apps/core-daemon/src/routes/runs.ts` line 130 `readonly sseManager: SseManager` field on `RunRouteDependencies` | required dep | **delete dependency field**; replace consumers with `runtimeNotifier: RuntimeNotifier` from `packages/core/src/event-publisher.ts` | targeted vitest run; type-check passes |
| `vendor/.../apps/core-daemon/src/routes/runs.ts` lines ~237 `new TransformStream<Uint8Array, Uint8Array>()` and ~277 `"Content-Type": "text/event-stream"` | SSE GET endpoint at `/runs/:id/events` returning streaming body | **delete the GET endpoint entirely.** Alaya has no SSE consumer (invariant §21). MCP `tools/call` is request/response; no client polls this route | `rg -n "text/event-stream\|TransformStream" apps/core-daemon/src` finds 0 |
| `vendor/.../apps/core-daemon/src/index.ts` line 177 `import { SseManager } from "./sse/sse-manager.js"` | startup import | **delete** | `rg -n "sse-manager\|SseManager" apps/core-daemon/src/index.ts` finds 0 |
| `vendor/.../apps/core-daemon/src/index.ts` line 260 `const sseManager = new SseManager(eventLogRepo)` | startup instantiation | **delete**; replace only with a real `RuntimeNotifier` created by startup-ordering wiring. A no-op `{ notify: async () => {}, notifyEntry: async () => {} }` substitute is forbidden. | `rg -n "RuntimeNotifier" apps/core-daemon/src/index.ts` finds real wiring and the no-op grep below returns zero |
| `vendor/.../apps/core-daemon/src/app.ts` line 49 `import type { SseManager } from "./sse/sse-manager.js"` | type import | **delete** | `rg -n "SseManager" apps/core-daemon/src/app.ts` finds 0 |
| `vendor/.../apps/core-daemon/src/app.ts` line 149 `readonly sseManager: SseManager` on `AppDependencies` | required dep | **delete dependency field**; downstream daemon-routes-register cards will not pass it | type-check passes; `rg -n "sseManager" apps/core-daemon/src` finds 0 |
| `vendor/.../apps/core-daemon/src/background/bootstrap.ts` (69 LOC) | upstream contains generic `BackgroundServiceManager` only; **no SSE refs** despite the §0 cite | **port as trivial-copy** (no strip needed). The card README's mention of "SSE pipeline in bootstrap.ts" is incorrect; document this deviation in the completion report | `diff vendor/.../background/bootstrap.ts apps/core-daemon/src/background/bootstrap.ts` shows only namespace rewrites |

#### Ordering invariant

The strip MUST preserve `EventLog.append → DB mutate → audit row → RuntimeNotifier.notifyEntry`. The relative order is enforced by `EventPublisher.publishWithMutation` and is not this card's responsibility to reimplement; this card only replaces the **broadcast leg** (SSE → in-process listener), not the producer.

#### Test scope clarification

Tests under `apps/core-daemon/src/__tests__/` that reference `SseManager` (e.g. `runs-rename-route.test.ts`, `embedding-backfill-runtime.test.ts`) are **owned by the corresponding P4-routes-* card**, not by this card. P4-sse-strip only updates production code under `apps/core-daemon/src/`; reviewers MUST NOT block this card on test-side leftovers, but P4-daemon-routes-register's gate MUST verify zero SSE strings across `apps/core-daemon/src/__tests__/` before final close.

#### Final residue gate

After this card lands, `rg -n "SseManager\|sseManager\|text/event-stream\|EventSource\|TransformStream" apps/core-daemon/src --glob '!__tests__/**'` MUST return zero hits. Verification step 6 enforces this. The no-op notifier grep in verification step 9 MUST also return zero hits.

#### Recovery guardrail

This card may redesign only the SSE transport removal. It MUST NOT use the
SSE rewrite as permission to replace Hono, replace route service bags, create a
daemon-wide facade, or inline service graph assembly. The following grep must
return zero hits after the card lands unless a later explicitly approved
`requires-redesign` card owns the symbol:

`rtk rg -n "daemon-handle|daemon-service-graph|DaemonRouteHandler|context\\.daemon" apps/core-daemon/src`

This card also MUST NOT produce synthetic live-event proof by adding a no-op
`RuntimeNotifier`. `live-event-ready` is earned only after
P4-daemon-startup-ordering wires the real notifier and the relevant route/app
tests prove the production call path.

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
| AC6 | Closing readiness label is `implementation-ready`; `live-event-ready` waits for P4-daemon-startup-ordering and route/app production wiring proof | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are not updated to claim this card alone is live-ready |
| AC7 | No non-SSE daemon rewrite artifacts are introduced | `rtk rg -n "daemon-handle|daemon-service-graph|DaemonRouteHandler|context\\.daemon" apps/core-daemon/src` returns zero hits |
| AC8 | `runtime-notifier.ts` exists as the concrete SseManager replacement and no no-op RuntimeNotifier substitute is introduced | `test -f apps/core-daemon/src/runtime-notifier.ts`; `rtk rg -n "notify\\([^)]*\\).*return;|notifyEntry\\([^)]*\\).*return;|notify: async \\(\\) => \\{\\}|notifyEntry: async \\(\\) => \\{\\}" apps/core-daemon/src/runtime-notifier.ts apps/core-daemon/src/index.ts` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/sse/\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/routes/runs.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/background/bootstrap.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/index.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "no SSE|runs"`
6. `rtk rg -n "SseManager|sseManager|text/event-stream|EventSource|TransformStream" apps/core-daemon/src`
7. `rtk rg -n "daemon-handle|daemon-service-graph|DaemonRouteHandler|context\\.daemon" apps/core-daemon/src`
8. `test -f apps/core-daemon/src/runtime-notifier.ts`
9. `rtk rg -n "notify\\([^)]*\\).*return;|notifyEntry\\([^)]*\\).*return;|notify: async \\(\\) => \\{\\}|notifyEntry: async \\(\\) => \\{\\}" apps/core-daemon/src/runtime-notifier.ts apps/core-daemon/src/index.ts`

## 6. Shared File Hazards & Dependencies

- Must land before any P4 route card touches `routes/runs.ts` or daemon startup wiring.

**Prerequisite**: P4-daemon-skeleton, P2-svc-event-publisher.
**Blocks**: P4-daemon-startup-ordering, P4-routes-workspace, P4-daemon-routes-register.
