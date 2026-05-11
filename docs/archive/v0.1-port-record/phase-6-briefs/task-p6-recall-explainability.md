# Implementation Brief: P6-recall-explainability — Stable Recall Explanation Fields

> - **Card ID**: p6-recall-explainability
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-recall-explainability`; delivered commit `b443c89`
> - **Target**: `packages/protocol/src/soul/recall-candidate.ts`, `packages/protocol/src/soul/mcp-types.ts`, `packages/core/src/recall-service.ts`, `apps/core-daemon/src/mcp-memory-tool-handler.ts`, `packages/protocol/src/__tests__/recall-candidate.test.ts`, `packages/protocol/src/__tests__/dynamics-mcp-events.test.ts`
> - **Size**: M
> - **Prerequisite**: none
> - **Blocks**: p6-live-agent-proof
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 requires recall outputs that are explainable and stable for operators and reviewers. The delivered scope wires explanation fields through protocol, core recall computation, and MCP return shape.

Goal: keep recall candidate and response-level explainability fields stable and emitted on MCP recall responses.

## 2. Allowed Scope

- **Target**: `packages/protocol/src/soul/recall-candidate.ts`, `packages/protocol/src/soul/mcp-types.ts`
- **Change**: define `selection_reason`, `source_channels`, `score_factors`, `budget_state`, plus response-level `strategy_mix` and optional `degradation_reason`.

- **Target**: `packages/core/src/recall-service.ts`
- **Change**: compute candidate explainability values from ranking and budget pipeline.

- **Target**: `apps/core-daemon/src/mcp-memory-tool-handler.ts`
- **Change**: enforce/repair missing explainability values and return stable response shape.

- **Target**: protocol tests
- **Change**: lock schema and event payload shape for explainability fields.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Recall candidate schema includes all explainability fields. | `packages/protocol/src/soul/recall-candidate.ts` and protocol tests. |
| AC2 | MCP recall response includes response-level strategy mix and degradation reason contract. | `packages/protocol/src/soul/mcp-types.ts`; `packages/protocol/src/__tests__/dynamics-mcp-events.test.ts`. |
| AC3 | Daemon recall tool emits explainability values even when upstream candidates are partial. | `apps/core-daemon/src/mcp-memory-tool-handler.ts` fallback logic and explainability-partial branch. |
| AC4 | Core recall service computes per-candidate explainability/budget state. | `packages/core/src/recall-service.ts` scoring + budget assembly sections. |

## 5. Verification

```bash
rtk rg -n "selection_reason|source_channels|score_factors|budget_state|strategy_mix|degradation_reason" packages/protocol/src packages/core/src apps/core-daemon/src
rtk pnpm exec vitest run --project @do-soul/alaya-protocol packages/protocol/src/__tests__/recall-candidate.test.ts packages/protocol/src/__tests__/dynamics-mcp-events.test.ts
rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/recall-service.test.ts
```

## 6. Shared File Hazards & Dependencies

- Shared with `P6-live-agent-proof`: MCP recall output assertions in loop proof tests.

**Prerequisite**: none.
**Blocks**: p6-live-agent-proof.
