# Implementation Brief: P6-governance-accept-apply — Proposal Accept-As-Apply Path

> - **Card ID**: p6-governance-accept-apply
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-governance-accept-apply`; delivered commit `b443c89`
> - **Target**: `packages/storage/src/migrations/063-proposal-memory-update-patch.sql`, `packages/storage/src/repos/proposal-repo.ts`, `apps/core-daemon/src/mcp-memory-proposal-workflow.ts`, `apps/core-daemon/src/__tests__/mcp-memory-governance.test.ts`, `apps/core-daemon/src/__tests__/proposal-review-parity.test.ts`
> - **Size**: M
> - **Prerequisite**: none
> - **Blocks**: p6-live-agent-proof
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 requires governance to remain explicit: proposals are reviewed by verdict, and accept must apply durable changes through auditable service flow. The delivered patch introduces proposal payload persistence and accept-path apply plumbing.

Goal: ensure `soul.review_memory_proposal(accept)` applies persisted `proposed_changes` through controlled durable memory update path with parity across MCP, Inspector, and CLI surfaces.

## 2. Allowed Scope

- **Target**: `packages/storage/src/migrations/063-proposal-memory-update-patch.sql`
- **Change**: add durable `proposed_changes` column for proposal payload retention.

- **Target**: `packages/storage/src/repos/proposal-repo.ts`
- **Change**: parse, validate, and transact accept-path memory updates from proposal payload.

- **Target**: `apps/core-daemon/src/mcp-memory-proposal-workflow.ts`
- **Change**: route accept verdict into repo-level accept/apply operation with reviewer identity checks.

- **Target**: `apps/core-daemon/src/__tests__/mcp-memory-governance.test.ts`, `apps/core-daemon/src/__tests__/proposal-review-parity.test.ts`
- **Change**: prove ordering, parity, and reviewer-token identity behavior.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Proposal payload changes are persisted durably. | `packages/storage/src/migrations/063-proposal-memory-update-patch.sql` and repo parse/validation in `packages/storage/src/repos/proposal-repo.ts`. |
| AC2 | Accept verdict uses proposal payload to apply durable update in one controlled path. | `apps/core-daemon/src/mcp-memory-proposal-workflow.ts` call to `acceptPendingMemoryUpdateWithEvents`; tests in `apps/core-daemon/src/__tests__/mcp-memory-governance.test.ts`. |
| AC3 | MCP/Inspector/CLI review output contracts remain identical. | `apps/core-daemon/src/__tests__/proposal-review-parity.test.ts`. |
| AC4 | Reject path keeps durable memory unchanged. | reject-path assertions in `apps/core-daemon/src/__tests__/mcp-memory-governance.test.ts`. |

## 5. Verification

```bash
rtk rg -n "proposed_changes|acceptPendingMemoryUpdateWithEvents|reviewer_identity|reviewer_token" packages/storage/src apps/core-daemon/src
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/mcp-memory-governance.test.ts apps/core-daemon/src/__tests__/proposal-review-parity.test.ts
rtk pnpm exec vitest run --project @do-soul/alaya-storage packages/storage/src/__tests__/proposal-repo.test.ts packages/storage/src/__tests__/proposal-repo-reviewer-identity.test.ts
```

## 6. Shared File Hazards & Dependencies

- Shared with `P6-operator-control`: `apps/core-daemon/src/cli/review.ts` behavior consumed by parity proofs.
- Shared with `P6-live-agent-proof`: review/apply path and proposal lifecycle tests.

**Prerequisite**: none.
**Blocks**: p6-live-agent-proof.
