# Implementation Brief: P6-operator-control — CLI/Status Surface Separation

> - **Card ID**: p6-operator-control
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-operator-control`; delivered commits `b443c89`, `592a7a5`
> - **Target**: `apps/core-daemon/src/cli/tools.ts`, `apps/core-daemon/src/cli/review.ts`, `apps/core-daemon/src/cli/status.ts`, `apps/core-daemon/src/mcp-memory-tool-catalog.ts`, `apps/core-daemon/src/__tests__/cli-tools.test.ts`, `apps/core-daemon/src/__tests__/cli-review.test.ts`, `README.md`, `README.zh-CN.md`
> - **Size**: M
> - **Prerequisite**: none
> - **Blocks**: none
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 requires operators to distinguish candidate signal, proposal queue, proposal resolution, durable apply, recall delivery, and usage receipt without control-plane ambiguity. Delivered changes tightened tool descriptions and CLI guardrails.

Goal: keep CLI/status/tool descriptions aligned with explicit governance boundaries and prevent generic tool surfaces from impersonating human review flows.

## 2. Allowed Scope

- **Target**: `apps/core-daemon/src/cli/tools.ts`, `apps/core-daemon/src/cli/review.ts`, `apps/core-daemon/src/cli/status.ts`
- **Change**: enforce command boundary semantics and review-surface exclusivity.

- **Target**: `apps/core-daemon/src/mcp-memory-tool-catalog.ts`
- **Change**: provide explicit per-tool intent/read-write annotations.

- **Target**: CLI tests
- **Change**: lock output/guardrail behavior.

- **Target**: `README.md`, `README.zh-CN.md`
- **Change**: mirror the same control-plane language for operators.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | CLI fallback supports list/call while preserving review boundary. | `apps/core-daemon/src/cli/tools.ts` and `apps/core-daemon/src/__tests__/cli-tools.test.ts`. |
| AC2 | Proposal triage/resolution remains explicit human-review surface. | `apps/core-daemon/src/cli/review.ts` + `apps/core-daemon/src/__tests__/cli-review.test.ts`. |
| AC3 | Tool catalog descriptions distinguish recall, usage receipt, candidate signal, and governance actions. | `apps/core-daemon/src/mcp-memory-tool-catalog.ts`. |
| AC4 | Operator docs use active Protocol/Memory Loop language, not benchmark acceptance. | `README.md` and `README.zh-CN.md` Phase 6 tool/loop sections. |

## 5. Verification

```bash
rtk rg -n "tools call cannot impersonate|soul.list_pending_proposals|soul.report_context_usage|review pending" apps/core-daemon/src/cli apps/core-daemon/src/mcp-memory-tool-catalog.ts
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/cli-tools.test.ts apps/core-daemon/src/__tests__/cli-review.test.ts
rtk rg -n "tools list|tools call|review pending\|accept\|reject|report_context_usage" README.md README.zh-CN.md
```

## 6. Shared File Hazards & Dependencies

- Shared with `P6-agent-use-protocol`: `mcp-memory-tool-catalog.ts`, README surfaces.
- Shared with `P6-contract-parity-reset`: README and handbook wording parity.

**Prerequisite**: none.
**Blocks**: none.
