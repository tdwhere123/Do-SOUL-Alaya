# Implementation Brief: P6-agent-use-protocol — MCP/CLI Agent Memory Loop Contract

> - **Card ID**: p6-agent-use-protocol
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-agent-use-protocol`; delivered commit `b443c89`
> - **Target**: `apps/core-daemon/src/__tests__/agent-use-protocol.test.ts`, `apps/core-daemon/src/__tests__/e2e/release-loop.test.ts`, `apps/core-daemon/src/mcp-memory-tool-catalog.ts`, `apps/core-daemon/src/profile-mutation.ts`, `README.md`, `README.zh-CN.md`
> - **Size**: M
> - **Prerequisite**: none
> - **Blocks**: p6-live-agent-proof
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 acceptance requires an operator protocol that attached agents can follow without hidden contract steps. The delivered change set added a deterministic proof test and synchronized tool-catalog/operator guidance.

Goal: define and verify one end-to-end MCP/CLI memory loop contract (attach, discover, recall, usage receipt, proposal, review, and pending-queue parity) that is consumable by attached agents.

## 2. Allowed Scope

- **Target**: `apps/core-daemon/src/__tests__/agent-use-protocol.test.ts`
- **Change**: add an integration-style proof transcript in one daemon lifetime that enforces ordered MCP calls and CLI parity checks.

- **Target**: `apps/core-daemon/src/__tests__/e2e/release-loop.test.ts`
- **Change**: keep release-loop E2E aligned with the same protocol sequence.

- **Target**: `apps/core-daemon/src/mcp-memory-tool-catalog.ts`
- **Change**: align descriptions and read/write annotations with the explicit loop semantics.

- **Target**: `apps/core-daemon/src/profile-mutation.ts`
- **Change**: attach-profile operator instructions reflect the memory loop ordering.

- **Target**: `README.md`, `README.zh-CN.md`
- **Change**: publish the same sequence to operator-facing docs.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | MCP/CLI loop sequence is explicit and ordered (recall -> usage receipt -> proposal -> review). | `apps/core-daemon/src/__tests__/agent-use-protocol.test.ts` transcript assertions and step order checks. |
| AC2 | CLI fallback tool discovery matches MCP tool discovery. | `apps/core-daemon/src/__tests__/agent-use-protocol.test.ts` (`alaya tools list --json` equals MCP `tools/list`). |
| AC3 | Pending-proposal visibility is consistent before and after review. | `apps/core-daemon/src/__tests__/agent-use-protocol.test.ts` assertions over `soul.list_pending_proposals` and `alaya review pending --json`. |
| AC4 | Public operator docs reflect protocol language and do not use benchmark acceptance gates. | `README.md` / `README.zh-CN.md` tool-loop sections in commit `b443c89`. |

## 5. Verification

```bash
rtk rg -n "Phase-6 MCP agent-use protocol proof|soul.report_context_usage|soul.list_pending_proposals|soul.review_memory_proposal" apps/core-daemon/src/__tests__/agent-use-protocol.test.ts
rtk rg -n "tools list --json|tools call|review pending\|accept\|reject" README.md README.zh-CN.md
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/agent-use-protocol.test.ts
```

## 6. Shared File Hazards & Dependencies

- Shared with `P6-live-agent-proof`: `apps/core-daemon/src/__tests__/agent-use-protocol.test.ts`.
- Shared with `P6-operator-control`: `README.md`, `README.zh-CN.md`, `apps/core-daemon/src/mcp-memory-tool-catalog.ts`.

**Prerequisite**: none.
**Blocks**: p6-live-agent-proof.
