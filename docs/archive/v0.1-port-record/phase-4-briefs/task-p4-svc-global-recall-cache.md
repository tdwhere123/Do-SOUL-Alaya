# Implementation Brief: Task P4-svc-global-recall-cache — Cross-workspace cache invalidation for GlobalMemoryRecallService

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-svc-global-recall-cache
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/global-memory-recall-service.ts`
> - **Target**: `packages/core/src/global-memory-recall-service.ts`, `packages/core/src/__tests__/global-memory-recall-service.cross-workspace.test.ts`
> - **Size**: S
> - **Prerequisite**: P3-core-barrel, P4-daemon-startup-ordering
> - **Blocks**: Gate-4 demo
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-svc-global-recall-cache";
`docs/handbook/port-protocol.md §2 adapt-and-port`;
`docs/handbook/invariants.md §10` (audit precedes broadcast) and
`docs/handbook/invariants.md §11` (RuntimeNotifier in-process delivery
is the post-audit broadcast channel for v0.1).

## 1. Background & Goal

**Background**: `GlobalMemoryRecallService` was ported in
P2-svc-global-recall and serves cross-workspace recall queries with
an in-process cache keyed by memory id. The cache currently does not
invalidate across workspace boundaries: a memory mutated in workspace
A leaves stale entries in workspace B's cached recall results.
Originally accepted as a v0.1 limitation; brought back into scope on
2026-04-29 because cross-workspace memory access is part of Alaya's
core "memory plugin" identity, not a multi-tenant edge case. Closes
backlog #BL-011.

**Goal**: A `memory.created`, `memory.updated`, or `memory.deleted`
event fired in workspace A drives a `RuntimeNotifier` callback that
invalidates the corresponding cache entries in every other
workspace's `GlobalMemoryRecallService` view within one notifier
delivery, with an integration test that exercises the full
EventLog → audit → notifier → cache-invalidate chain.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/global-memory-recall-service.ts` | `packages/core/src/global-memory-recall-service.ts` | adapt-and-port: extend the existing service with the cross-workspace invalidation hook. Do NOT redesign the cache shape; only add the listener registration and the invalidation method. |
| `n/a` | `packages/core/src/__tests__/global-memory-recall-service.cross-workspace.test.ts` | New integration test that builds a real EventLog + EventPublisher + two GlobalMemoryRecallService instances (one per workspace) and proves invalidation. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md §2`.
- Adapter point list (the only allowed deviations from upstream):
  1. Add `subscribeToInvalidations(notifier: RuntimeNotifier): Disposable` (or whatever name matches the existing service style) that registers a listener for `memory.created` / `memory.updated` / `memory.deleted` events.
  2. Add a private `invalidateForMemory(memoryId, sourceWorkspaceId)` method that scans the cache and drops every entry whose recall result references that memory id, regardless of which workspace produced the cache entry.
  3. No changes to the public recall query API or the cache key structure.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If the upstream service file diverges from what this card assumes (e.g. the cache shape changed since P2-svc-global-recall close), return `BLOCKED` instead of expanding scope.

### 2.3 Required Behavior

**Listener registration.** Daemon startup ordering wires the
notifier into the service exactly once, after the EventLog and
EventPublisher are constructed. The Disposable returned by
`subscribeToInvalidations` is held for the daemon's lifetime.

**Invalidation rule.** A `memory.{created,updated,deleted}` event
with payload `{ workspace_id: A, memory_id: M }` invalidates every
cache entry that references `M`, in every workspace's view, NOT
only workspace A's view. Tests prove the cross-workspace path.

**Audit ordering.** The cache invalidation runs *after* the audit
row is written, per invariant §10. The notifier interface guarantees
this; this card MUST NOT add a second listener path that fires
before audit.

**Idempotency.** Multiple concurrent events for the same memory id
must not double-invalidate or leave the cache in a torn state.
Standard Map-based delete is idempotent; tests assert this.

**Performance budget.** Invalidation is O(cache-size) in the worst
case (cache scan). Acceptable for v0.1 because the cache is
process-local and capped by memory id count. If profiling shows this
is a hotspot, follow up with a memory-id reverse index — out of
scope for this card.

### 2.4 Out of Scope

- Persistent cache across daemon restarts (cache is process-local).
- Reverse-index optimization for large caches (follow-up).
- Cache invalidation for memory edits originating from outside the
  daemon (e.g. direct SQLite writes by a developer). The notifier
  guarantee is "all writes go through EventPublisher", which the
  invariants already require; this card does not police the rule.

## 3. Deferred

Nothing deferred. Closes #BL-011 in full.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the adapt-and-port spec states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/global-memory-recall-service.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Targeted unit and cross-workspace integration tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core global-memory-recall` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and the adapter point list | `docs/v0.1/phase-4-briefs/reports/task-p4-svc-global-recall-cache.md` exists and cites #BL-011 as closed by this card |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Cross-workspace invalidation is exercised end-to-end via real EventLog + RuntimeNotifier | The new `cross-workspace.test.ts` builds two service instances, mutates a memory in workspace A, and asserts workspace B's cache no longer contains the stale entry |
| AC8 | Audit-before-broadcast ordering preserved | Test asserts the audit row exists in EventLog before the listener callback fires |
| AC9 | Backlog #BL-011 status flips to Resolved on close | `docs/handbook/backlog.md` updated in the same PR / commit window |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/global-memory-recall-service.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core global-memory-recall`

## 6. Shared File Hazards & Dependencies

- Touches `packages/core/src/global-memory-recall-service.ts` (file
  was created by P2-svc-global-recall and barrel-exposed by
  P3-core-barrel). The barrel does not change; only the service
  internals do.
- Depends on `RuntimeNotifier` interface from
  `packages/core/src/event-publisher.ts`; do not redefine.

**Prerequisite**: P3-core-barrel, P4-daemon-startup-ordering.
**Blocks**: Gate-4 demo (step 12).
