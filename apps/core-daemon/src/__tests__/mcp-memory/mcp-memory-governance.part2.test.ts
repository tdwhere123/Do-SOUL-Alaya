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

describe("mcp memory governance", () => {

  it("allows human reviewer (runId: null) to review a proposal stored with a non-null run_id", async () => {
    // invariant: the Inspector POST and `alaya review` CLI always pass
    // runId: null. assertProposalContext MUST accept the human-reviewer
    // (runId: null) case even when the stored proposal carries an
    // agent's run_id; otherwise the human reviewer surface cannot
    // review any agent-scoped proposal. Locking the loosened semantics
    // here so a regression to strict run_id equality fails this
    // assertion.
    const events: EventLogEntry[] = [];
    const proposal = createProposal();
    let storedProposal = proposal;
    let eventCounter = 0;
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposal.proposal_id,
      reviewerIdentityBinding: { token: "reviewer-token", identity: "user:alice" },
      eventLogRepo: {
        append: async () => {
          throw new Error("append must not be called from review path");
        },
        queryByEntity: async () => []
      },
      proposalRepo: {
        create: async () => proposal,
        createProposalWithEvents: async () => {
          throw new Error("create not exercised in this test");
        },
        findById: async () => storedProposal,
        // Stored proposal carries run_id "run-agent" (the agent run that
        // produced it via soul.propose_memory_update), workspace "ws1".
        findScopedById: async () => ({
          proposal: storedProposal,
          workspace_id: "ws1",
          run_id: "run-agent",
          proposed_changes: { content: "corrected" }
        }),
        findPendingSummaries: async () => [],
        acceptPendingMemoryUpdateWithEvents: async (_proposalId, updatedAt, resolutionEvents) => {
          const storedEvents = resolutionEvents.map((event) => {
            const entry = {
              event_id: `event-${++eventCounter}`,
              created_at: "2026-04-30T00:00:00.000Z",
              revision: 1,
              ...event
            } satisfies EventLogEntry;
            events.push(entry);
            return entry;
          });
          storedProposal = {
            ...storedProposal,
            resolution_state: ProposalResolutionState.ACCEPTED,
            last_updated_at: updatedAt
          };
          return { proposal: storedProposal, events: storedEvents };
        },
        updatePendingResolutionWithEvents: async (_proposalId, state, updatedAt, resolutionEvents) => {
          const storedEvents = resolutionEvents.map((event) => {
            const entry = {
              event_id: `event-${++eventCounter}`,
              created_at: "2026-04-30T00:00:00.000Z",
              revision: 1,
              ...event
            } satisfies EventLogEntry;
            events.push(entry);
            return entry;
          });
          storedProposal = {
            ...storedProposal,
            resolution_state: state,
            last_updated_at: updatedAt
          };
          return { proposal: storedProposal, events: storedEvents };
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} },
      memoryService: createMemoryApplyPort()
    });

    const reviewed = await workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "human reviewer in Inspector",
        reviewer_identity: "user:alice",
        reviewer_token: "reviewer-token"
      },
      // Human-reviewer surface: runId === null. Workspace matches.
      { workspaceId: "ws1", runId: null, agentTarget: "inspector", sessionId: "session-1" }
    );

    expect(reviewed.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
    expect(events).toHaveLength(3);
  });

  it("still rejects human reviewer when workspace does not match (workspace check stays strict)", async () => {
    const proposal = createProposal();
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
          throw new Error("create not exercised");
        },
        findById: async () => proposal,
        findScopedById: async () => ({
          proposal,
          workspace_id: "ws-other",
          run_id: "run-agent"
        }),
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async () => {
          throw new Error("update should not run for workspace mismatch");
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "wrong ws",
          reviewer_identity: "user:bob"
        },
        { workspaceId: "ws1", runId: null, agentTarget: "inspector", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("still requires run match when call context carries a non-null runId (agent context stays strict)", async () => {
    // When an attached agent itself drives the review call, runId is
    // non-null and strict equality must still hold so an agent in run A
    // cannot review a proposal scoped to run B.
    const proposal = createProposal();
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
          throw new Error("create not exercised");
        },
        findById: async () => proposal,
        findScopedById: async () => ({
          proposal,
          workspace_id: "ws1",
          run_id: "run-stored"
        }),
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async () => {
          throw new Error("update should not run for run mismatch");
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "wrong run",
          reviewer_identity: "user:agent"
        },
        { workspaceId: "ws1", runId: "run-other", agentTarget: "codex", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unbound attached-agent review even when workspace and run match", async () => {
    const proposal = createProposal();
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
          throw new Error("create not exercised");
        },
        findById: async () => proposal,
        findScopedById: async () => ({
          proposal,
          workspace_id: "ws1",
          run_id: "run1",
          proposed_changes: { content: "corrected" }
        }),
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async () => {
          throw new Error("update should not run for unbound attached agent");
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
          reason: "self accept",
          reviewer_identity: "user:agent"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("runs MemoryService update validation before atomic accept-as-apply", async () => {
    const proposal = createProposal();
    const acceptWrite = vi.fn();
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
          throw new Error("create not exercised");
        },
        findById: async () => proposal,
        findScopedById: async () => ({
          proposal,
          workspace_id: "ws1",
          run_id: "run1",
          proposed_changes: { evidence_refs: ["missing-evidence"] }
        }),
        findPendingSummaries: async () => [],
        acceptPendingMemoryUpdateWithEvents: acceptWrite,
        updatePendingResolutionWithEvents: async () => {
          throw new Error("reject path not exercised");
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} },
      memoryService: {
        findByIdScoped: async (objectId: string) => ({ object_id: objectId }),
        validateUpdate: async () => {
          throw Object.assign(new Error("Evidence reference not found: missing-evidence"), {
            code: "VALIDATION"
          });
        },
        update: async (objectId: string) => ({ object_id: objectId })
      }
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "bad evidence",
          reviewer_identity: "user:alice"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "cli", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(acceptWrite).not.toHaveBeenCalled();
  });

  it("rejects proposal reviews outside the stored workspace and run context", async () => {
    const events: EventLogEntry[] = [];
    const proposal = createProposal();
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposal.proposal_id,
      eventLogRepo: {
        append: async (input) => {
          const entry = {
            event_id: `event-${events.length + 1}`,
            created_at: "2026-04-30T00:00:00.000Z",
            revision: events.length + 1,
            ...input
          } satisfies EventLogEntry;
          events.push(entry);
          return entry;
        },
        queryByEntity: async () => events
      },
      proposalRepo: {
        create: async () => proposal,
        createProposalWithEvents: async () => {
          throw new Error("create should not run for a scope mismatch test");
        },
        findById: async () => proposal,
        findScopedById: async () => ({
          proposal,
          workspace_id: "ws2",
          run_id: "run2"
        }),
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async () => {
          throw new Error("update should not run for a scope mismatch");
        }
      },
      runtimeNotifier: {
        notifyEntry: async () => {
          throw new Error("notify should not run for a scope mismatch");
        }
      }
    });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "reject",
          reason: "wrong workspace",
          reviewer_identity: "user:wrong-ws"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(events).toEqual([]);
  });
});
