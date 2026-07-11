# S1 — Byte-Equivalent Edge Transfer Trace

> - **Card ID:** `2026-07-10-s1-edge-transfer-trace`
> - **Source/Background:** concept F1 and Phase-1 object-only diagnostics
> - **Target:** core inflow/score diagnostics and strict bench consumers
> - **Size:** M
> - **Tier:** Heavy child slice; AFK
> - **Prerequisite:** E2 baseline and S0 docs lock
> - **Blocks:** E3, S2-S5
> - **Owner:** TypeScript worker; parent integrates
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

`PathInflowEdge` currently loses path identity and object diagnostics expose only an aggregate. **Goal:** preserve path provenance and emit a bounded `RecallFloodEdgeTraceV1` through core and bench while keeping every score byte-equivalent.

Failure-Mode Forecast: live-path gap, contract drift, synthetic proof, payload growth, evidence drift.
Path Map: PathRelation -> inflow contract -> pure transfer calculation -> core diagnostics -> strict harness schema -> LongMemEval sidecar. Readiness: `live-event-ready`; Truth Plane: `task-worktree`.

## 2. Allowed Scope

- `packages/core/src/recall/runtime/recall-service-results.ts`
- `packages/core/src/recall/expansion/path-relations.ts`
- `packages/core/src/recall/scoring/conformant-fusion-scoring.ts`
- `packages/core/src/recall/flood/edge-transfer.ts` (new)
- `packages/core/src/recall/runtime/recall-service-diagnostics.ts`
- `packages/core/src/recall/runtime/diagnostics.ts`
- `packages/core/src/__tests__/recall/path-inflow-adjacency.test.ts`
- `packages/core/src/__tests__/recall/conformant-axis-math.test.ts`
- `packages/core/src/__tests__/recall/recall-diagnostics.test.ts`
- `packages/core/src/__tests__/recall/flood-edge-transfer.test.ts` (new)
- `apps/bench-runner/src/harness/recall-diagnostics-schema.ts`
- `apps/bench-runner/src/longmemeval/diagnostics-schema.ts`
- `apps/bench-runner/src/longmemeval/diagnostics-types.ts`
- `apps/bench-runner/src/longmemeval/diagnostics-candidate-readers.ts`
- `apps/bench-runner/src/longmemeval/diagnostics-question.ts`
- `apps/bench-runner/src/__tests__/longmemeval/longmemeval-diagnostics.test.ts`
- `apps/bench-runner/src/__tests__/longmemeval/longmemeval-diagnostics.part2.test.ts`

Any extra file requires `NEEDS_CONTEXT` and parent amendment.

## 3. Deferred

- Slice compatibility and remoteness behavior: S3/S4.
- Public MCP/protocol exposure: not required; no real consumer.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| S1-AC1 | Inflow retains path id, relation kind, directed endpoints, and weight | adjacency tests |
| S1-AC2 | Trace records input, conductance, capped transfer, decision/reason, schema version | pure module tests |
| S1-AC3 | Existing score output is byte-equivalent | paired regression fixtures |
| S1-AC4 | Optional trace crosses both strict schemas and old artifacts still parse | core-to-bench contract tests |
| S1-AC5 | At most 16 traces per candidate are emitted, deterministically ordered; truncation count is retained | bounds/order tests |
| S1-AC6 | Real SQLite PathRelation reaches RecallService diagnostics and bench parser | integration test |

## 5. Verification

- `rtk pnpm build`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/recall/path-inflow-adjacency.test.ts packages/core/src/__tests__/recall/conformant-axis-math.test.ts packages/core/src/__tests__/recall/recall-diagnostics.test.ts packages/core/src/__tests__/recall/flood-edge-transfer.test.ts`
- `rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner apps/bench-runner/src/__tests__/longmemeval/longmemeval-diagnostics.test.ts apps/bench-runner/src/__tests__/longmemeval/longmemeval-diagnostics.part2.test.ts`

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | live-event-ready | task-worktree | core-to-bench trace | per-edge legacy NOR restored; trace priority fixed; targeted 53/53; Heavy core re-review CLEAN | INTEGRATED | 2026-07-10 | TypeScript worker + parent | payload performance waits for a valid future S5/E4 |

## 6. Shared File Hazards & Dependencies

This lane has exclusive write ownership of all listed scoring/diagnostics files.
The parent accepted the contract and fresh targeted evidence for downstream
dependencies. Per the user's sequencing instruction, independent review and the
fix-loop run once after all implementation code is complete.
