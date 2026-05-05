import { describe, expect, it, vi } from "vitest";
import {
  MemoryGovernanceEventType,
  ProposalResolutionState,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import { createMcpMemoryProposalWorkflow } from "../mcp-memory-proposal-workflow.js";

describe("mcp memory governance", () => {
  it("creates and reviews memory proposals through EventLog and ProposalRepo", async () => {
    const events: EventLogEntry[] = [];
    const proposals = new Map<string, { proposal: Proposal; workspace_id: string; run_id: string | null }>();
    const order: string[] = [];
    let eventCounter = 0;
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => "00000000-0000-4000-8000-000000000001",
      eventLogRepo: {
        append: async (input) => {
          order.push(`event:${input.event_type}`);
          const entry = {
            event_id: `event-${++eventCounter}`,
            created_at: "2026-04-30T00:00:00.000Z",
            ...input
          } satisfies EventLogEntry;
          events.push(entry);
          return entry;
        },
        queryByEntity: async (entityType, entityId) =>
          events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      },
      proposalRepo: {
        create: async ({ proposal, workspace_id, run_id }) => {
          order.push("repo:create");
          proposals.set(proposal.proposal_id, { proposal, workspace_id, run_id });
          return proposal;
        },
        createProposalWithEvents: async ({ proposal, workspace_id, run_id }, creationEvents) => {
          order.push("repo:createProposalWithEvents");
          proposals.set(proposal.proposal_id, { proposal, workspace_id, run_id });
          const storedEvents = creationEvents.map((event) => {
            order.push(`event:${event.event_type}`);
            const entry = {
              event_id: `event-${++eventCounter}`,
              created_at: "2026-04-30T00:00:00.000Z",
              revision: events.filter(
                (existingEvent) =>
                  existingEvent.entity_type === event.entity_type &&
                  existingEvent.entity_id === event.entity_id
              ).length + 1,
              ...event
            } satisfies EventLogEntry;
            events.push(entry);
            return entry;
          });
          return { proposal, events: storedEvents };
        },
        findById: async (proposalId) => proposals.get(proposalId)?.proposal ?? null,
        findScopedById: async (proposalId) => proposals.get(proposalId) ?? null,
        updatePendingResolutionWithEvents: async (proposalId, state, updatedAt, resolutionEvents) => {
          order.push("repo:updatePendingResolutionWithEvents");
          const existing = proposals.get(proposalId);
          if (existing === undefined) {
            throw new Error("missing proposal");
          }
          const storedEvents = resolutionEvents.map((event) => {
            order.push(`event:${event.event_type}`);
            const entry = {
              event_id: `event-${++eventCounter}`,
              created_at: "2026-04-30T00:00:00.000Z",
              revision: events.filter(
                (existingEvent) =>
                  existingEvent.entity_type === event.entity_type &&
                  existingEvent.entity_id === event.entity_id
              ).length,
              ...event
            } satisfies EventLogEntry;
            events.push(entry);
            return entry;
          });
          const updated = {
            ...existing.proposal,
            resolution_state: state,
            last_updated_at: updatedAt
          } satisfies Proposal;
          proposals.set(proposalId, { ...existing, proposal: updated });
          return { proposal: updated, events: storedEvents };
        }
      },
      runtimeNotifier: {
        notifyEntry: async (entry) => {
          order.push(`notify:${entry.event_type}`);
        }
      }
    });

    const created = await workflow.proposeMemoryUpdate(
      {
        target_object_id: "mem1",
        proposed_changes: { content: "corrected" },
        reason: "operator correction"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
    );

    expect(created).toEqual({
      proposal_id: "00000000-0000-4000-8000-000000000001",
      status: "created"
    });
    expect(order.slice(0, 3)).toEqual([
      "repo:createProposalWithEvents",
      `event:${MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED}`,
      `notify:${MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED}`
    ]);
    expect(proposals.get(created.proposal_id)?.proposal.resolution_state).toBe(ProposalResolutionState.PENDING);

    const reviewed = await workflow.reviewMemoryProposal(
      {
        proposal_id: created.proposal_id,
        verdict: "accept",
        reason: "confirmed",
        reviewer_identity: "user:reviewer-1"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
    );

    expect(reviewed).toEqual({
      proposal_id: created.proposal_id,
      resolution_state: ProposalResolutionState.ACCEPTED
    });
    expect(events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(proposals.get(created.proposal_id)?.proposal.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
    expect(order.indexOf("repo:updatePendingResolutionWithEvents")).toBeLessThan(
      order.indexOf(`notify:${MemoryGovernanceEventType.SOUL_REVIEW_CREATED}`)
    );
  });

  it("prevents duplicate durable review events when concurrent review loses pending-state CAS", async () => {
    const events: EventLogEntry[] = [];
    const proposal = createProposal();
    let storedProposal = proposal;
    let eventCounter = 0;
    const notifyEntry = vi.fn(async () => {});
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposal.proposal_id,
      eventLogRepo: {
        append: async (input) => {
          const entry = {
            event_id: `event-${++eventCounter}`,
            created_at: "2026-04-30T00:00:00.000Z",
            ...input
          } satisfies EventLogEntry;
          events.push(entry);
          return entry;
        },
        queryByEntity: async (entityType, entityId) =>
          events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      },
      proposalRepo: {
        create: async () => proposal,
        createProposalWithEvents: async (input, creationEvents) => {
          const storedEvents = creationEvents.map((event) => {
            const entry = {
              event_id: `event-${++eventCounter}`,
              created_at: "2026-04-30T00:00:00.000Z",
              revision: events.filter(
                (existingEvent) =>
                  existingEvent.entity_type === event.entity_type &&
                  existingEvent.entity_id === event.entity_id
              ).length + 1,
              ...event
            } satisfies EventLogEntry;
            events.push(entry);
            return entry;
          });
          return { proposal: input.proposal, events: storedEvents };
        },
        findById: async () => storedProposal,
        findScopedById: async () => ({
          proposal: storedProposal,
          workspace_id: "ws1",
          run_id: "run1"
        }),
        updatePendingResolutionWithEvents: async (_proposalId, state, updatedAt, resolutionEvents) => {
          if (storedProposal.resolution_state !== ProposalResolutionState.PENDING) {
            throw Object.assign(new Error(`Proposal is already ${storedProposal.resolution_state}.`), {
              code: "CONFLICT"
            });
          }
          const storedEvents = resolutionEvents.map((event) => {
            const entry = {
              event_id: `event-${++eventCounter}`,
              created_at: "2026-04-30T00:00:00.000Z",
              revision: events.filter(
                (existingEvent) =>
                  existingEvent.entity_type === event.entity_type &&
                  existingEvent.entity_id === event.entity_id
              ).length,
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
      runtimeNotifier: {
        notifyEntry
      }
    });

    const results = await Promise.allSettled([
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "first reviewer",
          reviewer_identity: "user:first"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
      ),
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "reject",
          reason: "duplicate reviewer",
          reviewer_identity: "user:second"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
      )
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "VALIDATION" }
    });
    expect(events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(notifyEntry).toHaveBeenCalledTimes(3);
    expect(storedProposal.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
  });

  it("assigns new local proposals to the configured single reviewer", async () => {
    const proposalId = "00000000-0000-4000-8000-000000000001";
    let capturedAssignment: unknown;
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposalId,
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
        create: async ({ proposal }) => proposal,
        createProposalWithEvents: async ({ proposal }, _creationEvents, options) => {
          capturedAssignment = options?.reviewerAssignment;
          return { proposal, events: [] };
        },
        findById: async () => null,
        findScopedById: async () => null,
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async () => {
          throw new Error("updatePendingResolutionWithEvents must not be called");
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    await workflow.proposeMemoryUpdate(
      {
        target_object_id: "mem1",
        proposed_changes: { content: "corrected" },
        reason: "operator correction"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
    );

    expect(capturedAssignment).toEqual({
      proposal_id: proposalId,
      reviewer_identity: "user:server-reviewer",
      assigned_at: "2026-04-30T00:00:00.000Z",
      deadline_at: null,
      escalation_after_ms: null
    });
  });

  it("allows human reviewer (runId: null) to review a proposal stored with a non-null run_id (A1 finding-1)", async () => {
    // A1 fix-loop (finding-1): the Inspector POST and `alaya review`
    // CLI always pass runId: null. Before the fix, assertProposalContext
    // rejected this with NOT_FOUND because the stored proposal carried
    // the agent's run_id (e.g. "run-1") and strict equality required
    // null === "run-1" → false. Locking the loosened semantics here so
    // a regression of the strict check fails this assertion.
    const events: EventLogEntry[] = [];
    const proposal = createProposal();
    let storedProposal = proposal;
    let eventCounter = 0;
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => proposal.proposal_id,
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
          run_id: "run-agent"
        }),
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
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    const reviewed = await workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "human reviewer in Inspector",
        reviewer_identity: "user:alice"
      },
      // Human-reviewer surface: runId === null. Workspace matches.
      { workspaceId: "ws1", runId: null, agentTarget: "inspector" }
    );

    expect(reviewed.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
    expect(events).toHaveLength(3);
  });

  it("still rejects human reviewer when workspace does not match (finding-1 — workspace check stays strict)", async () => {
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
        { workspaceId: "ws1", runId: null, agentTarget: "inspector" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("still requires run match when call context carries a non-null runId (finding-1 — agent context stays strict)", async () => {
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
        { workspaceId: "ws1", runId: "run-other", agentTarget: "codex" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(events).toEqual([]);
  });
});

describe("mcp memory governance — soul.list_pending_proposals (A1)", () => {
  it("forwards since/limit through to the proposalRepo summary projection", async () => {
    const findPendingSummaries = vi.fn(async () => [
      {
        proposal_id: "prop-1",
        target_object_id: "mem-1",
        target_object_kind: "memory_entry",
        created_at: "2026-04-30T00:00:00.000Z",
        proposed_change_summary: "Switch to pnpm",
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
      // A1 fix-loop (finding-2): workspace_id no longer in the request
      // payload; sourced from the trusted MCP call context.
      { since: "2026-04-30T00:00:00.000Z", limit: 10 },
      { workspaceId: "ws1", runId: null, agentTarget: "cli" }
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
          run_id: "run1"
        }),
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async (_proposalId, state, updatedAt, events, options) => {
          captureReviewerIdentity = options?.reviewerIdentity;
          for (const event of events) {
            if (event.caused_by !== null) {
              eventCausedBy.push(event.caused_by);
            }
          }
          storedProposal = {
            ...storedProposal,
            resolution_state: state,
            last_updated_at: updatedAt
          };
          return { proposal: storedProposal, events: [] };
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    await workflow.reviewMemoryProposal(
      {
        proposal_id: proposal.proposal_id,
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:alice"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
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
          reviewer_assignment: { reviewer_identity: "user:server-reviewer" }
        }),
        findPendingSummaries: async () => [],
        updatePendingResolutionWithEvents: async (_proposalId, state, updatedAt, events, options) => {
          updateCalls += 1;
          captureReviewerIdentity = options?.reviewerIdentity;
          for (const event of events) {
            if (event.caused_by !== null) {
              eventCausedBy.push(event.caused_by);
            }
          }
          storedProposal = {
            ...storedProposal,
            resolution_state: state,
            last_updated_at: updatedAt
          };
          return { proposal: storedProposal, events: [] };
        }
      },
      runtimeNotifier: { notifyEntry: async () => {} }
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
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
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
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
    );

    expect(captureReviewerIdentity).toBe("user:server-reviewer");
    expect(eventCausedBy).toEqual([
      "user:server-reviewer",
      "user:server-reviewer",
      "user:server-reviewer"
    ]);
  });
});

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
