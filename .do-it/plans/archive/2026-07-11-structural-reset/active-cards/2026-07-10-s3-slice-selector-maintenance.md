# S3 — Slice Selector and Projection Lifecycle

> - **Card ID:** `2026-07-10-s3-slice-selector-maintenance`
> - **Source/Background:** S2 contract
> - **Target:** query/source/target key derivation and selector
> - **Size:** M
> - **Tier:** Heavy child slice; AFK
> - **Prerequisite:** S2 integrated
> - **Blocks:** S4/S5
> - **Owner:** TypeScript worker; parent integrates
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

**Goal:** derive SliceKeys at read time from existing query probes and MemoryEntry/PathRelation projections, then return deterministic edge compatibility without changing scoring defaults.

Failure-Mode Forecast: stale projection, workspace leakage, delete/reconciliation drift, no-key fallback drift.
Path Map: query probes + persisted projections + Path anchors -> selector -> compatibility/reason -> S4 transfer. Readiness: `live-event-ready`; Truth Plane: `task-worktree`.

## 2. Allowed Scope

- `packages/core/src/recall/flood/slice-key-contract.ts`
- `packages/core/src/recall/flood/slice-key-selector.ts` (new)
- `packages/core/src/recall/query/recall-query-probes.ts`
- `packages/core/src/recall/supplements/supplementary-data.ts`
- `packages/core/src/recall/runtime/recall-service-results.ts`
- `packages/core/src/__tests__/recall/slice-key-selector.test.ts` (new)
- `packages/core/src/__tests__/governance/reconciliation-facet-tags.test.ts`
- `packages/storage/src/__tests__/repos/memory-entry/memory-entry-repo-projection.test.ts`
- `packages/storage/src/__tests__/repos/path/path-topology-cascade.test.ts`

No protocol schema, migration, or storage implementation file may change.

## 3. Deferred

- Materialized key storage/backfill: `BL-069`.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| S3-AC1 | No query key returns pass-through fallback | selector tests |
| S3-AC2 | Query/source/target intersection accepts an edge; query keys with no intersection reject with `no_slice_match` | selector tests |
| S3-AC3 | Workspace id participates in identity and cross-workspace keys never match | isolation tests |
| S3-AC4 | Update, clear, delete, and reconciliation rebuild from current projections without stale state | existing real-repo lifecycle tests |
| S3-AC5 | Selector output is deterministic under input permutation | property-style unit test |

## 5. Verification

- `rtk pnpm build`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/recall/slice-key-selector.test.ts packages/core/src/__tests__/governance/reconciliation-facet-tags.test.ts`
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage packages/storage/src/__tests__/repos/memory-entry/memory-entry-repo-projection.test.ts packages/storage/src/__tests__/repos/path/path-topology-cascade.test.ts`

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S3 | live-event-ready | task-worktree | `recall/flood/slice-key-selector.ts` | three-state endpoint projection + fresh tie; typed-anchor SQLite path; Heavy re-review CLEAN | INTEGRATED | 2026-07-10 | TypeScript worker + parent | object-anchor taxonomy and representative coverage remain evidence-gated |

## 6. Shared File Hazards & Dependencies

`recall-service-results.ts` is shared with S1 and must not be edited until S1 integrates. S4 waits for S3.
S3 needed only new selector/test files. The post-code Heavy review/fix-loop is
complete and clean for this selector.
