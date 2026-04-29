# Implementation Brief: Task P2-svc-event-publisher — Redesign EventPublisher without SSE transport

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-svc-event-publisher
> - **Port mode**: requires-redesign
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/event-publisher.ts`, `vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer.ts`, `vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer-state.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/event-publisher.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/runtime-event-normalizer.test.ts`
> - **Target**: `packages/core/src/`, `packages/core/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P1-protocol, P1-core-skeleton, P2-repos-batch-1
> - **Blocks**: P2-svc-memory, P3-conversation, P4-daemon-startup-ordering
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-svc-event-publisher";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §11` forbids SSE transport while preserving EventLog -> DB -> audit -> in-process notification ordering.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver redesign EventPublisher without SSE transport.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/event-publisher.ts` | `packages/core/src/event-publisher.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer.ts` | `packages/core/src/runtime-event-normalizer.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer-state.ts` | `packages/core/src/runtime-event-normalizer-state.ts` | Copy first; no SSE dependency. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/event-publisher.test.ts` | `packages/core/src/__tests__/event-publisher.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/runtime-event-normalizer.test.ts` | `packages/core/src/__tests__/runtime-event-normalizer.test.ts` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Redesign

| Source area | Required change | Justification |
|---|---|---|
| `sseBroadcaster` dependencies | Replace with Alaya in-process runtime listener port | Invariant §11 forbids SSE |
| `RunHotStateService` concrete import | Replace with a narrow `apply(Phase0Event)` port until P3-run-lifecycle ports the concrete service | Phase 3 owns run-hot-state implementation |
| reconnect/SSE rollback comments | Retain false-history protection but remove SSE client wording | Same semantics, different consumer model |

### 2.4 Post-Landing Review-Fix Outcomes

These outcomes were added by post-landing review-fix work and must remain part
of the card truth:

- Batch propagation failure exposes the full durable batch through
  `EventPublisherPropagationError.entries`, with evidence for mutation rollback,
  partial append rollback, and post-mutation propagation failure.
- `RuntimeEventNormalizer` notify failure after durable append throws
  `RuntimeEventNormalizerPropagationError` with the appended entry attached,
  and retry re-notifies the pending durable entry instead of appending a
  duplicate or suppressing notification.
- Pending-notification retry is single-flight per runtime-event key, so
  concurrent retry callers share one in-process `notifyEntry` attempt.
- Failed pending retry recovery leaves the durable entry pending and later
  retryable, including when `notifyEntry` throws synchronously.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/event-publisher.ts\",\"vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer.ts\",\"vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer-state.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/event-publisher.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/runtime-event-normalizer.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "EventPublisher|RuntimeEventNormalizer"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-svc-event-publisher.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Post-landing review-fix outcomes in §2.4 remain reflected by the report and tests | Completion report records the same batch propagation, pending retry, single-flight retry, and failed-retry recovery outcomes |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/event-publisher.ts\",\"vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer.ts\",\"vendor/do-what-new-snapshot/packages/core/src/runtime-event-normalizer-state.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/event-publisher.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/runtime-event-normalizer.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "EventPublisher|RuntimeEventNormalizer"`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel serializes service exports after Phase 3.

**Prerequisite**: P1-protocol, P1-core-skeleton, P2-repos-batch-1.
**Blocks**: P2-svc-memory, P3-conversation, P4-daemon-startup-ordering.
