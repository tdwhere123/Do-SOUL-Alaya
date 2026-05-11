# Implementation Brief: P6-live-agent-proof — Deterministic Live Path Harness

> - **Card ID**: p6-live-agent-proof
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-live-agent-proof`; delivered commit `b443c89` with supporting startup/runtime evidence in `592a7a5`
> - **Target**: `apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts`, `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts`, `apps/core-daemon/src/__tests__/gate4-attached-agent-mcp-proof.test.ts`, `apps/core-daemon/src/__tests__/mcp-server.test.ts`, `apps/core-daemon/src/__tests__/cli-tools.test.ts`
> - **Size**: M
> - **Prerequisite**: p6-agent-use-protocol, p6-governance-accept-apply, p6-recall-explainability, p6-garden-startup-cleanup-loop
> - **Blocks**: none
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 gate language requires one deterministic proof chain that runs through real daemon wiring and proves the Memory Loop beyond isolated units. Delivered tests build transcripted MCP and CLI parity evidence in one daemon lifetime.

Goal: provide reproducible integration proof for tool discovery, ordered MCP calls, usage receipt, proposal review/apply, and explainable recall.

## 2. Allowed Scope

- **Target**: `apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts`
- **Change**: end-to-end transcript and ordered-step assertions for the full loop.

- **Target**: `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts`
- **Change**: keep release-loop deterministic and enforce workspace scope/security checks.

- **Target**: `apps/core-daemon/src/__tests__/gate4-attached-agent-mcp-proof.test.ts`
- **Change**: retain attached-agent proof baseline compatibility with Phase 6 flow.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Integration test covers tool discovery and ordered loop calls in one runtime lifetime. | `apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts`. |
| AC2 | Proof includes usage receipt and governance review/apply path. | transcript steps/assertions in `phase6-agent-use-protocol.test.ts`; mirrored flow in `e2e/v0.1-release-loop.test.ts`. |
| AC3 | CLI fallback parity is asserted against MCP steps. | `phase6-agent-use-protocol.test.ts` (`tools list`, `review pending` parity checks). |
| AC4 | Proof remains workspace-scoped and rejects cross-workspace review misuse. | `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts` foreign-workspace review assertions. |

## 5. Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts
rtk rg -n "foreign workspace|soul.review_memory_proposal \(foreign workspace\)|soul.report_context_usage|tools/list" apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts
```

## 6. Shared File Hazards & Dependencies

- Shared with `P6-agent-use-protocol`, `P6-governance-accept-apply`, `P6-recall-explainability`, `P6-garden-startup-cleanup-loop` through common proof tests.

**Prerequisite**: p6-agent-use-protocol, p6-governance-accept-apply, p6-recall-explainability, p6-garden-startup-cleanup-loop.
**Blocks**: none.
