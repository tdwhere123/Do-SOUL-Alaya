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

  it("creates and reviews memory proposals through EventLog and ProposalRepo", async () => {
    const events: EventLogEntry[] = [];
    const proposals = new Map<
      string,
      {
        proposal: Proposal;
        workspace_id: string;
        run_id: string | null;
        proposed_changes: Readonly<MemoryEntryMutableFields> | null;
      }
    >();
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
            revision:
              events.filter(
                (existingEvent) =>
                  existingEvent.entity_type === input.entity_type &&
                  existingEvent.entity_id === input.entity_id
              ).length + 1,
            ...input
          } satisfies EventLogEntry;
          events.push(entry);
          return entry;
        },
        queryByEntity: async (entityType, entityId) =>
          events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      },
      proposalRepo: {
        create: async ({ proposal, workspace_id, run_id, proposed_changes }) => {
          order.push("repo:create");
          proposals.set(proposal.proposal_id, {
            proposal,
            workspace_id,
            run_id,
            proposed_changes: proposed_changes ?? null
          });
          return proposal;
        },
        createProposalWithEvents: async ({ proposal, workspace_id, run_id, proposed_changes }, creationEvents) => {
          order.push("repo:createProposalWithEvents");
          proposals.set(proposal.proposal_id, {
            proposal,
            workspace_id,
            run_id,
            proposed_changes: proposed_changes ?? null
          });
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
        findPendingSummaries: async () => [],
        acceptPendingMemoryUpdateWithEvents: async (proposalId, updatedAt, resolutionEvents, _memoryUpdate, options) => {
          order.push("repo:acceptPendingMemoryUpdateWithEvents");
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
            resolution_state: ProposalResolutionState.ACCEPTED,
            last_updated_at: updatedAt
          } satisfies Proposal;
          proposals.set(proposalId, { ...existing, proposal: updated });
          return { proposal: updated, events: storedEvents };
        },
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
      },
      memoryService: createMemoryApplyPort()
    });

    const created = await workflow.proposeMemoryUpdate(
      {
        target_object_id: "mem1",
        proposed_changes: { content: "corrected" },
        reason: "operator correction"
      },
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex", sessionId: "session-1" }
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
      { workspaceId: "ws1", runId: "run1", agentTarget: "cli", sessionId: "session-1" }
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
    expect(order.indexOf("repo:acceptPendingMemoryUpdateWithEvents")).toBeLessThan(
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
            revision:
              events.filter(
                (existingEvent) =>
                  existingEvent.entity_type === input.entity_type &&
                  existingEvent.entity_id === input.entity_id
              ).length + 1,
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
          run_id: "run1",
          proposed_changes: { content: "corrected" }
        }),
        findPendingSummaries: async () => [],
        acceptPendingMemoryUpdateWithEvents: async (_proposalId, updatedAt, resolutionEvents) => {
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
            resolution_state: ProposalResolutionState.ACCEPTED,
            last_updated_at: updatedAt
          };
          return { proposal: storedProposal, events: storedEvents };
        },
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
      },
      memoryService: createMemoryApplyPort()
    });

    const results = await Promise.allSettled([
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "accept",
          reason: "first reviewer",
          reviewer_identity: "user:first"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "cli", sessionId: "session-1" }
      ),
      workflow.reviewMemoryProposal(
        {
          proposal_id: proposal.proposal_id,
          verdict: "reject",
          reason: "duplicate reviewer",
          reviewer_identity: "user:second"
        },
        { workspaceId: "ws1", runId: "run1", agentTarget: "cli", sessionId: "session-1" }
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
    const fulfilled = results.find((result) => result.status === "fulfilled");
    expect(storedProposal.resolution_state).toBe(fulfilled?.value.resolution_state);
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
      { workspaceId: "ws1", runId: "run1", agentTarget: "codex", sessionId: "session-1" }
    );

    expect(capturedAssignment).toEqual({
      proposal_id: proposalId,
      reviewer_identity: "user:server-reviewer",
      assigned_at: "2026-04-30T00:00:00.000Z",
      deadline_at: null,
      escalation_after_ms: null
    });
  });
});
