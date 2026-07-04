import { describe, expect, it, vi } from "vitest";
import {
  ProposalResolutionState,
  RetentionPolicy,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import { ProposalService, type ProposalServiceDependencies } from "../../governance/proposals/proposal-service.js";

function createProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    dossier_ref: null,
    recommended_option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    proposal_options: [
      {
        option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: "2026-03-21T00:00:00.000Z",
    ...overrides
  };
}

function createDependencies(
  overrides: Partial<ProposalServiceDependencies> = {}
): ProposalServiceDependencies {
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-21T00:00:00.000Z",
    revision: 0,
    ...event
  }));
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);
  const notifySpy = vi.fn(async () => {});

  return {
    proposalRepo: {
      findById: vi.fn(async () => createProposal()),
      findByWorkspaceId: vi.fn(async () => [createProposal()]),
      findPending: vi.fn(async () => [createProposal()])
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    runtimeNotifier: {
      notifyEntry: notifySpy
    },
    ...overrides
  };
}

describe("ProposalService", () => {
  it("findById returns the proposal record from the repo", async () => {
    const expected = createProposal({ proposal_id: "prop-found" });
    const dependencies = createDependencies({
      proposalRepo: {
        findById: vi.fn(async () => expected),
        findByWorkspaceId: vi.fn(async () => []),
        findPending: vi.fn(async () => [])
      }
    });

    const service = new ProposalService(dependencies);
    const result = await service.findById("prop-found");

    expect(result).toBe(expected);
    expect(dependencies.proposalRepo.findById).toHaveBeenCalledWith("prop-found");
  });

  it("findById returns null when the repo has no matching proposal", async () => {
    const dependencies = createDependencies({
      proposalRepo: {
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findPending: vi.fn(async () => [])
      }
    });

    const service = new ProposalService(dependencies);
    await expect(service.findById("missing")).resolves.toBeNull();
  });

  it("findByWorkspaceId proxies to the repo with the workspace id", async () => {
    const proposals = [createProposal({ proposal_id: "p1" }), createProposal({ proposal_id: "p2" })];
    const dependencies = createDependencies({
      proposalRepo: {
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => proposals),
        findPending: vi.fn(async () => [])
      }
    });

    const service = new ProposalService(dependencies);
    const result = await service.findByWorkspaceId("workspace-1");

    expect(result).toEqual(proposals);
    expect(dependencies.proposalRepo.findByWorkspaceId).toHaveBeenCalledWith("workspace-1");
  });

  it("findPending returns only pending proposals from the repo", async () => {
    const pending = [createProposal({ proposal_id: "pending-1" })];
    const dependencies = createDependencies({
      proposalRepo: {
        findById: vi.fn(async () => null),
        findByWorkspaceId: vi.fn(async () => []),
        findPending: vi.fn(async () => pending)
      }
    });

    const service = new ProposalService(dependencies);
    const result = await service.findPending("workspace-1");

    expect(result).toEqual(pending);
    expect(dependencies.proposalRepo.findPending).toHaveBeenCalledWith("workspace-1");
  });
});
