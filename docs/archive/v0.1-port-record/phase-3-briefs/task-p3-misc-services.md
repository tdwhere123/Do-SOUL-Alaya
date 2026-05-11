# Implementation Brief: Task P3-misc-services — Port remaining core support services

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-misc-services
> - **Port mode**: adapt-and-port
> - **Source**: See §2.1 File Ownership. Slash command execution and
>   local slash metadata discovery are pruned from Alaya scope because they
>   are not part of the v0.1 memory plugin core.
> - **Target**: `packages/core/src/`, `packages/core/src/__tests__/`
> - **Size**: XL
> - **Prerequisite**: Gate-2, P3-misc-foundation, P2-repos-batch-*, P2-security-*, P2-svc-*
> - **Blocks**: P3-core-barrel, P4-routes-*
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-misc-services";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port remaining core support services.

**Scope split**: `tool-spec-service.ts`, `strong-ref-service.ts`,
`dirty-state-panic-service.ts`, `file-path.ts`, and `message-history.ts`
are moved to `P3-misc-foundation`. They are forbidden in this card even if
older inventory text mentions them.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/canonical-alias-service.ts` | `packages/core/src/canonical-alias-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/constitutional-fragment-service.ts` | `packages/core/src/constitutional-fragment-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/project-mapping-service.ts` | `packages/core/src/project-mapping-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/engine-binding-service.ts` | `packages/core/src/engine-binding-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/workspace-service.ts` | `packages/core/src/workspace-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/slot-service.ts` | `packages/core/src/slot-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/graph-explore-service.ts` | `packages/core/src/graph-explore-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/surface-service.ts` | `packages/core/src/surface-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/surface-binding-service.ts` | `packages/core/src/surface-binding-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/surface-drift-service.ts` | `packages/core/src/surface-drift-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/target-revalidate-service.ts` | `packages/core/src/target-revalidate-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/deferred-obligation-service.ts` | `packages/core/src/deferred-obligation-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/budget-bankruptcy-service.ts` | `packages/core/src/budget-bankruptcy-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/arbitration-service.ts` | `packages/core/src/arbitration-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/claim-service.ts` | `packages/core/src/claim-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/dynamics-service.ts` | `packages/core/src/dynamics-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/prompt-asset-registry.ts` | `packages/core/src/prompt-asset-registry.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/node-template-resolver.ts` | `packages/core/src/node-template-resolver.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/security-status-service.ts` | `packages/core/src/security-status-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/canonical-alias-service.test.ts` | `packages/core/src/__tests__/canonical-alias-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/constitutional-fragment-service.test.ts` | `packages/core/src/__tests__/constitutional-fragment-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/project-mapping-service.test.ts` | `packages/core/src/__tests__/project-mapping-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/engine-binding-service.test.ts` | `packages/core/src/__tests__/engine-binding-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/workspace-service.test.ts` | `packages/core/src/__tests__/workspace-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/slot-service.test.ts` | `packages/core/src/__tests__/slot-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/graph-explore-service.test.ts` | `packages/core/src/__tests__/graph-explore-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/surface-service.test.ts` | `packages/core/src/__tests__/surface-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/surface-binding-service.test.ts` | `packages/core/src/__tests__/surface-binding-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/surface-drift-service.test.ts` | `packages/core/src/__tests__/surface-drift-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/target-revalidate-service.test.ts` | `packages/core/src/__tests__/target-revalidate-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/deferred-obligation-service.test.ts` | `packages/core/src/__tests__/deferred-obligation-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/budget-bankruptcy-service.test.ts` | `packages/core/src/__tests__/budget-bankruptcy-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/arbitration-service.test.ts` | `packages/core/src/__tests__/arbitration-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/claim-service.test.ts` | `packages/core/src/__tests__/claim-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/dynamics-service.test.ts` | `packages/core/src/__tests__/dynamics-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/prompt-asset-registry.test.ts` | `packages/core/src/__tests__/prompt-asset-registry.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/node-template-resolver.test.ts` | `packages/core/src/__tests__/node-template-resolver.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/security-status-service.test.ts` | `packages/core/src/__tests__/security-status-service.test.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- Do not edit files owned by `P3-misc-foundation`.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| Cluster | Source behavior | Alaya behavior | Reason |
|---|---|---|---|
| `constitutional-fragment-service.ts`, `engine-binding-service.ts`, `workspace-service.ts`, `surface-binding-service.ts`, `surface-drift-service.ts`, `deferred-obligation-service.ts`, `security-status-service.ts` EventPublisher dependencies | Source publishes events through upstream `EventPublisher`, whose broadcast leg is SSE-backed upstream | Use the already-ported Alaya `EventPublisher`, whose broadcast leg is `RuntimeNotifier.notifyEntry`; do not introduce direct `sseBroadcaster` fields | Invariant §11 |
| `project-mapping-service.ts` `ProjectMappingServiceSseBroadcaster` dependency | Source has an optional service-local `sseBroadcaster?.broadcastEntry` dependency for mapping events | Rename to optional `ProjectMappingServiceRuntimeNotifierPort` with `notifyEntry`, preserving optional notification semantics after EventLog append | Invariant §11 |
| `slot-service.ts` `SlotSseBroadcaster` dependency | Source has a service-local `sseBroadcaster.broadcastEntry` dependency for slot events | Rename to `SlotRuntimeNotifierPort` with `notifyEntry`, preserving EventLog append before notify and test call counts | Invariant §11 |
| `graph-explore-service.ts` `GraphExploreServiceSseBroadcaster` dependency | Source has a service-local `sseBroadcaster.broadcastEntry` dependency for graph exploration events | Rename to `GraphExploreServiceRuntimeNotifierPort` with `notifyEntry`, preserving EventLog append before notify and test call counts | Invariant §11 |
| `surface-service.ts` `SurfaceSseBroadcaster` dependency | Source has a service-local `sseBroadcaster.broadcastEntry` dependency for surface created, updated, bound, and deleted events | Rename to `SurfaceRuntimeNotifierPort` with `notifyEntry`, preserving EventLog append before notify and test call counts/order assertions | Invariant §11 |
| `surface-binding-service.ts` unused optional `SurfaceBindingSseBroadcaster` dependency | Source declares an optional `sseBroadcaster` dependency while event emission goes through `EventPublisher` | Remove the unused direct dependency or rename it to optional `SurfaceBindingRuntimeNotifierPort` only if target code still needs the constructor shape; do not call SSE directly | Invariant §11 |
| `budget-bankruptcy-service.ts` `BudgetBankruptcySseBroadcasterPort` dependency | Source has a service-local `sseBroadcaster.broadcastEntry` dependency | Rename to `BudgetBankruptcyRuntimeNotifierPort` with `notifyEntry`, preserving EventLog append before notify and test call counts | Invariant §11 |
| `arbitration-service.ts` `ArbitrationSseBroadcaster` dependency | Source has a service-local `sseBroadcaster.broadcastEntry` dependency for arbitration proposed and resolved events | Rename to `ArbitrationRuntimeNotifierPort` with `notifyEntry`, preserving EventLog append before notify and test call counts/order assertions | Invariant §11 |
| `claim-service.ts` `ClaimSseBroadcaster` dependency | Source has a service-local `sseBroadcaster.broadcastEntry` dependency for claim created, lifecycle changed, and contested events | Rename to `ClaimRuntimeNotifierPort` with `notifyEntry`, preserving EventLog append before notify and test call counts/order assertions | Invariant §11 |
| `dynamics-service.ts` inline `sseBroadcaster` dependency | Source has an inline service-local `sseBroadcaster.broadcastEntry` dependency for dynamics events | Rename to inline `runtimeNotifier.notifyEntry`, preserving EventLog append before notify and test call counts | Invariant §11 |
| Tests for EventPublisher-backed and service-local notifier services | Source tests may use upstream broadcaster naming | Rename mocks only where needed to Alaya runtime notifier vocabulary; preserve event ordering and call-count assertions | Invariant §11 and port parity |
| All files not named above in this table | Source logic is portable | Copy first with only package-name/path rewrites | Port protocol default |

## 3. Pruned

- `slash-command-service.ts`, `slash-local-skill-discovery.ts`, and their
  tests are pruned from Alaya scope. They discover or dispatch upstream
  Claude-local slash metadata and are not part of the v0.1 memory plugin core.
- Chat-only runtime surfaces not consumed by MCP/CLI stay outside this card;
  `P3-conversation` owns the separate ConversationService chat-path pruning.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | Source existence check over §2.1 File Ownership exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core canonical-alias constitutional project-mapping workspace surface slot graph-explore` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-3-briefs/reports/task-p3-misc-services.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. Run a source existence check over every `vendor/do-what-new-snapshot/packages/core/src/**` path listed in §2.1 File Ownership; it must exit 0.
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core canonical-alias constitutional project-mapping workspace surface slot graph-explore`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel owns exports.

**Prerequisite**: Gate-2, P3-misc-foundation, P2-repos-batch-*, P2-security-*, P2-svc-*.
**Blocks**: P3-core-barrel, P4-routes-*.
