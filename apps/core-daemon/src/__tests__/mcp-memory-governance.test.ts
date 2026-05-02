import { describe, expect, it, vi } from "vitest";
import {
  Phase1BEventType,
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
        deleteById: async (eventId) => {
          const index = events.findIndex((event) => event.event_id === eventId);
          if (index >= 0) {
            events.splice(index, 1);
          }
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
        findById: async (proposalId) => proposals.get(proposalId)?.proposal ?? null,
        findScopedById: async (proposalId) => proposals.get(proposalId) ?? null,
        updatePendingResolution: async (proposalId, state, updatedAt) => {
          order.push("repo:updatePendingResolution");
          const existing = proposals.get(proposalId);
          if (existing === undefined) {
            throw new Error("missing proposal");
          }
          const updated = {
            ...existing.proposal,
            resolution_state: state,
            last_updated_at: updatedAt
          } satisfies Proposal;
          proposals.set(proposalId, { ...existing, proposal: updated });
          return updated;
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
      `event:${Phase1BEventType.SOUL_PROPOSAL_CREATED}`,
      "repo:create",
      `notify:${Phase1BEventType.SOUL_PROPOSAL_CREATED}`
    ]);
    expect(proposals.get(created.proposal_id)?.proposal.resolution_state).toBe(ProposalResolutionState.PENDING);

    const reviewed = await workflow.reviewMemoryProposal(
      {
        proposal_id: created.proposal_id,
        verdict: "accept",
        reason: "confirmed"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
    );

    expect(reviewed).toEqual({
      proposal_id: created.proposal_id,
      resolution_state: ProposalResolutionState.ACCEPTED
    });
    expect(events.map((event) => event.event_type)).toEqual([
      Phase1BEventType.SOUL_PROPOSAL_CREATED,
      Phase1BEventType.SOUL_REVIEW_CREATED,
      Phase1BEventType.SOUL_REVIEW_COMPLETED,
      Phase1BEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(proposals.get(created.proposal_id)?.proposal.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
    expect(order.indexOf(`event:${Phase1BEventType.SOUL_REVIEW_CREATED}`)).toBeLessThan(
      order.indexOf("repo:updatePendingResolution")
    );
  });

  it("rolls back duplicate review events when pending-state CAS loses", async () => {
    const events: EventLogEntry[] = [];
    const deletedEventIds: string[] = [];
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
        deleteById: async (eventId) => {
          deletedEventIds.push(eventId);
          const index = events.findIndex((event) => event.event_id === eventId);
          if (index >= 0) {
            events.splice(index, 1);
          }
        },
        queryByEntity: async (entityType, entityId) =>
          events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      },
      proposalRepo: {
        create: async () => proposal,
        findById: async () => storedProposal,
        findScopedById: async () => ({
          proposal: storedProposal,
          workspace_id: "ws1",
          run_id: "run1"
        }),
        updatePendingResolution: async (_proposalId, state, updatedAt) => {
          if (storedProposal.resolution_state !== ProposalResolutionState.PENDING) {
            throw Object.assign(new Error(`Proposal is already ${storedProposal.resolution_state}.`), {
              code: "CONFLICT"
            });
          }
          storedProposal = {
            ...storedProposal,
            resolution_state: state,
            last_updated_at: updatedAt
          };
          return storedProposal;
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
          reason: "first reviewer"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
      ),
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "reject",
          reason: "duplicate reviewer"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
      )
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "VALIDATION" }
    });
    expect(events.map((event) => event.event_type)).toEqual([
      Phase1BEventType.SOUL_REVIEW_CREATED,
      Phase1BEventType.SOUL_REVIEW_COMPLETED,
      Phase1BEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(deletedEventIds).toHaveLength(0);
    expect(notifyEntry).toHaveBeenCalledTimes(3);
    expect(storedProposal.resolution_state).toBe(ProposalResolutionState.ACCEPTED);
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
        deleteById: async () => {
          throw new Error("delete should not run for a scope mismatch");
        },
        queryByEntity: async () => events
      },
      proposalRepo: {
        create: async () => proposal,
        findById: async () => proposal,
        findScopedById: async () => ({
          proposal,
          workspace_id: "ws2",
          run_id: "run2"
        }),
        updatePendingResolution: async () => {
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
          reason: "wrong workspace"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "codex" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(events).toEqual([]);
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
