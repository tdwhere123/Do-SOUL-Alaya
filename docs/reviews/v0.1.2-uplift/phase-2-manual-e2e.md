# Phase 2 Manual E2E Procedure

Status: procedure tracked; live browser execution is **NOT_VERIFIED** in the
Phase 2 fix-loop.

## Preconditions

- A workspace with at least one active memory entry visible in the Inspector
  graph.
- Built packages: `rtk pnpm build`.
- Managed daemon + Inspector launched through `rtk pnpm exec alaya inspect --open`
  (or equivalent daemon plus Inspector dev servers from `apps/inspector/README.md`).

## Click-Through

1. Open the Inspector URL that includes `token` and `workspaceId`.
2. Navigate to Graph.
3. Select an active `memory` node.
4. Click `Rewrite`, enter a visible content change, and submit.
5. Confirm the toast says the proposal was created or already pending.
6. Follow the toast action or open Pending Proposals.
7. Confirm the target proposal row is focused/highlighted and displays the exact
   `proposed_changes` payload before `Accept` is enabled.
8. Enter a reviewer identity and optional reason.
9. Click `Accept`.
10. Confirm the proposal leaves the pending list.
11. Re-open the memory through Graph or `soul.open_pointer` and confirm the
    accepted content change is visible.

## Expected Audit Boundary

- Graph action buttons must call proposal endpoints only.
- No memory row changes before `soul.review_memory_proposal` accepts the pending
  proposal.
- Accepted apply writes review events and one `SOUL_MEMORY_UPDATED` event through
  the storage transaction.
