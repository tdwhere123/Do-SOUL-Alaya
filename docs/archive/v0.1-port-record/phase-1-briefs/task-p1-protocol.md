# Implementation Brief: Task P1-protocol — Port @do-soul/alaya-protocol leaves

> - **Phase**: 1
> - **Wave**: 1
> - **Card ID**: P1-protocol
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/protocol/package.json`, `vendor/do-what-new-snapshot/packages/protocol/tsconfig.json`, `vendor/do-what-new-snapshot/packages/protocol/src/`
> - **Target**: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/`
> - **Size**: L
> - **Prerequisite**: none
> - **Blocks**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-config, P1-core-skeleton, P1-soul-skeleton, P1-topology, P1-engine-gateway-mcp, P2-repos-batch-*, P2-svc-*, P2-garden-batch-*
> - **Closing readiness label**: schema-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-1-briefs/README.md` row "P1-protocol";
`docs/handbook/port-protocol.md §2 adapt-and-port`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port @do-soul/alaya-protocol leaves.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/protocol/package.json` | `packages/protocol/package.json` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/protocol/tsconfig.json` | `packages/protocol/tsconfig.json` | Copy first; only BOM normalization is allowed. |
| `vendor/do-what-new-snapshot/packages/protocol/src/` | `packages/protocol/src/` | Copy first; apply only package-name/path rewrites and the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| Source area | Before | After | Justification |
|---|---|---|---|
| `src/run.ts` run mutation input schemas | Source has no production schema for run engine-binding updates. | Add `RunUpdateEngineBindingInputSchema` with `run_id` and `engine_binding_id`. | The frozen source test `src/__tests__/run-engine-binding-update.test.ts` imports and asserts this schema. |
| `src/event-log.ts` Phase 0 event names | Source has no `run.engine_binding.updated` event type in the production event list/map. | Add `run.engine_binding.updated` and `Phase0EventType.RUN_ENGINE_BINDING_UPDATED`. | Keeps the production event contract aligned with the copied frozen RED test. |
| `src/events/phase-0.ts` payload and event union | Source has no run engine-binding update payload, event object, exported schema, payload map entry, or union branch. | Add `RunEngineBindingUpdatedPayloadSchema`, `RunEngineBindingUpdatedEventSchema`, and the corresponding payload-map / union entries. | Makes the event parseable through the same Phase 0 schema path as the existing run events. |
| `src/__tests__/schemas.test.ts` schema coverage | Existing Phase 0 enum, payload parser, and union coverage do not include the new event. | Extend the existing assertions for `RUN_ENGINE_BINDING_UPDATED`. | Prevents future doc/code drift by exercising the adapter contract in the normal schema test suite. |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/protocol/package.json\",\"vendor/do-what-new-snapshot/packages/protocol/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/protocol/src/\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-protocol` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-1-briefs/reports/task-p1-protocol.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `schema-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/protocol/package.json\",\"vendor/do-what-new-snapshot/packages/protocol/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/protocol/src/\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/protocol`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-protocol`

## 6. Shared File Hazards & Dependencies

- Writes `packages/protocol/src/index.ts`; no other Phase 1+ card may edit protocol exports without a follow-up barrel card.

**Prerequisite**: none.
**Blocks**: P1-storage-skeleton, P1-storage-shared, P1-migrations, P1-config, P1-core-skeleton, P1-soul-skeleton, P1-topology, P1-engine-gateway-mcp, P2-repos-batch-*, P2-svc-*, P2-garden-batch-*.
