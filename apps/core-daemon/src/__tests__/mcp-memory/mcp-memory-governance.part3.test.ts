import { describe, expect, it, vi } from "vitest";

import {
  MemoryGovernanceEventType,
  ProposalResolutionState,
  type EventLogEntry,
  type MemoryEntryMutableFields,
  type Proposal
} from "@do-soul/alaya-protocol";

import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

function createProposal(): Proposal {
  return {
    runtime_id: "00000000-0000-4000-8000-000000000001",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: "mem1",
    retention_policy: "session_only",
    proposal_id: "00000000-0000-4000-8000-000000000001",
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [
      {
        option_id: "memory_update_00000000-0000-4000-8000-000000000001",
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: "2026-04-30T00:00:00.000Z"
  };
}

function createMemoryApplyPort() {
  return {
    findByIdScoped: async (objectId: string, _workspaceId: string) => ({ object_id: objectId }),
    validateUpdate: async () => {},
    update: async (
      objectId: string,
      _fields: MemoryEntryMutableFields,
      _reason: string
    ) => ({ object_id: objectId })
  };
}

describe("mcp memory governance — soul.list_pending_proposals (A1)", () => {
  it("forwards since/limit through to the proposalRepo summary projection", async () => {
    const findPendingSummaries = vi.fn(async () => [
      {
        proposal_id: "prop-1",
        target_object_id: "mem-1",
        target_object_kind: "memory_entry",
        created_at: "2026-04-30T00:00:00.000Z",
        proposed_change_summary: "Switch to pnpm",
        proposed_changes: { content: "Use pnpm for workspace commands." },
        assigned_reviewer_identity: "user:local-reviewer",
        assigned_at: "2026-04-30T00:00:00.000Z",
        deadline_at: null,
        is_overdue: false
      }
    ]);
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => "00000000-0000-4000-8000-000000000001",
      eventLogRepo: {
        append: async () => {
          throw new Error("append must not be called from listPendingProposals");
        },
        queryByEntity: async () => []
      },
      proposalRepo: {
        create: async () => {
          throw new Error("create must not be called from listPendingProposals");
        },
        createProposalWithEvents: async () => {
          throw new Error("createProposalWithEvents must not be called");
        },
        findById: async () => null,
        findScopedById: async () => null,
        findPendingSummaries,
        updatePendingResolutionWithEvents: async () => {
          throw new Error("updatePendingResolutionWithEvents must not be called");
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    const result = await workflow.listPendingProposals(
      // invariant: workspace_id MUST NOT be in the request payload;
      // it is sourced from the trusted MCP call context.
      { since: "2026-04-30T00:00:00.000Z", limit: 10 },
      { workspaceId: "ws1", runId: null, agentTarget: "cli", sessionId: "session-1" }
    );

    expect(result.total_count).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(findPendingSummaries).toHaveBeenCalledWith("ws1", {
      since: "2026-04-30T00:00:00.000Z",
      limit: 10,
      now: "2026-04-30T00:00:00.000Z"
    });
  });

  it("threads reviewer_identity into the resolution write and the audit caused_by", async () => {
    const proposal = createProposal();
    let storedProposal = proposal;
    const eventCausedBy: string[] = [];
    let captureReviewerIdentity: string | undefined;
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposal.proposal_id,
      eventLogRepo: {
        append: async () => {
          throw new Error("append must not be called");
        },
        queryByEntity: async () => []
      },
      proposalRepo: {
        create: async () => proposal,
        createProposalWithEvents: async () => {
          throw new Error("create not exercised in this test");
        },
        findById: async () => storedProposal,
        findScopedById: async () => ({
          proposal: storedProposal,
          workspace_id: "ws1",
          run_id: "run1",
          proposed_changes: { content: "corrected" }
        }),
        findPendingSummaries: async () => [],
        acceptPendingMemoryUpdateWithEvents: async (_proposalId, updatedAt, events, _memoryUpdate, options) => {
          captureReviewerIdentity = options?.reviewerIdentity;
          for (const event of events) {
            if (event.caused_by !== null) {
              eventCausedBy.push(event.caused_by);
            }
          }
          storedProposal = {
            ...storedProposal,
            resolution_state: ProposalResolutionState.ACCEPTED,
            last_updated_at: updatedAt
          };
          return { proposal: storedProposal, events: [] };
        },
        updatePendingResolutionWithEvents: async () => {
          throw new Error("reject path not exercised in this test");
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} },
      memoryService: createMemoryApplyPort()
    });

    await workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:alice"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "cli", sessionId: "session-1" }
    );

    expect(captureReviewerIdentity).toBe("user:alice");
    // All three review-related event_log rows record the reviewer identity
    // in caused_by so the audit trail names who approved/rejected.
    expect(eventCausedBy).toEqual(["user:alice", "user:alice", "user:alice"]);
  });

  it("binds configured reviewer identity from token and rejects payload identity override", async () => {
    const proposal = createProposal();
    let storedProposal = proposal;
    const eventCausedBy: string[] = [];
    let captureReviewerIdentity: string | undefined;
    let updateCalls = 0;
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposal.proposal_id,
      reviewerIdentityBinding: {
        token: "review-token",
        identity: "user:server-reviewer"
      },
      eventLogRepo: {
        append: async () => {
          throw new Error("append must not be called");
        },
        queryByEntity: async () => []
      },
      proposalRepo: {
        create: async () => proposal,
        createProposalWithEvents: async () => {
          throw new Error("create not exercised in this test");
        },
        findById: async () => storedProposal,
        findScopedById: async () => ({
          proposal: storedProposal,
          workspace_id: "ws1",
          run_id: "run1",
          reviewer_assignment: { reviewer_identity: "user:server-reviewer" },
          proposed_changes: { content: "corrected" }
        }),
        findPendingSummaries: async () => [],
        acceptPendingMemoryUpdateWithEvents: async (_proposalId, updatedAt, events, _memoryUpdate, options) => {
          updateCalls += 1;
          captureReviewerIdentity = options?.reviewerIdentity;
          for (const event of events) {
            if (event.caused_by !== null) {
              eventCausedBy.push(event.caused_by);
            }
          }
          storedProposal = {
            ...storedProposal,
            resolution_state: ProposalResolutionState.ACCEPTED,
            last_updated_at: updatedAt
          };
          return { proposal: storedProposal, events: [] };
        },
        updatePendingResolutionWithEvents: async () => {
          throw new Error("reject path not exercised in this test");
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} },
      memoryService: createMemoryApplyPort()
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "payload spoof",
          reviewer_identity: "user:payload",
          reviewer_token: "review-token"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(updateCalls).toBe(0);

    await workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "server-bound reviewer",
        reviewer_identity: "user:server-reviewer",
        reviewer_token: "review-token"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex", sessionId: "session-1" }
    );

    expect(captureReviewerIdentity).toBe("user:server-reviewer");
    expect(eventCausedBy).toEqual([
      "user:server-reviewer",
      "user:server-reviewer",
      "user:server-reviewer"
    ]);
  });
});
