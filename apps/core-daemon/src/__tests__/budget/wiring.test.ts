import { describe, expect, it, vi } from "vitest";
import { createBudgetProposalPort } from "../../budget/wiring.js";

describe("budget wiring", () => {
  it("uses the injected clock when creating bankruptcy proposals", async () => {
    const proposalRepo = {
      create: vi.fn(async (input) => input.proposal),
      updateResolution: vi.fn(),
      findById: vi.fn(),
      findPendingByRunId: vi.fn()
    };
    const now = () => "2026-03-26T00:00:00.000Z";
    const port = createBudgetProposalPort({
      proposalRepo: proposalRepo as never,
      now,
      generateProposalId: () => "00000000-0000-4000-8000-000000000123"
    });

    await port.create({
      workspaceId: "workspace-1",
      runId: "run-1",
      dossierRef: "dossier-1",
      options: [
        {
          option_id: "option-request_confirmation",
          option_kind: "request_confirmation",
          preserves_protected_constraints: true,
          dropped_candidates: [],
          unresolved_after_apply: [],
          requires_confirmation: true
        }
      ],
      recommendedOptionId: null,
      expiresAt: null
    });

    expect(proposalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({
          proposal_id: "00000000-0000-4000-8000-000000000123",
          last_updated_at: now()
        })
      })
    );
  });
});
