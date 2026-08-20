import { describe, expect, it } from "vitest";
import { createBenchSeedProposalReviewer } from "../../../harness/daemon/seed/daemon-seed-review.js";

describe("bench seed proposal reviewer", () => {
  it("preserves bounded CLI failure details", async () => {
    const review = createBenchSeedProposalReviewer({
      activeContext: { workspaceId: "ws-review", runId: "run-review" },
      dispatchCli: async () => ({
        exitCode: 65,
        json: {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Invalid reviewer token.",
            reviewer_token: "must-not-leak"
          }
        }
      }),
      reviewerIdentity: "user:reviewer"
    });

    await expect(
      review({ proposalId: "proposal-1", reason: "bench seed auto-accept" })
    ).rejects.toThrow(
      "alaya review accept failed with exitCode=65: VALIDATION: Invalid reviewer token."
    );
  });

  it("does not stringify unknown CLI failure payloads", async () => {
    const review = createBenchSeedProposalReviewer({
      activeContext: { workspaceId: "ws-review", runId: "run-review" },
      dispatchCli: async () => ({
        exitCode: 70,
        json: { reviewer_token: "must-not-leak" }
      }),
      reviewerIdentity: "user:reviewer"
    });

    await expect(
      review({ proposalId: "proposal-1", reason: "bench seed auto-accept" })
    ).rejects.toThrow("alaya review accept failed with exitCode=70");
    await expect(
      review({ proposalId: "proposal-1", reason: "bench seed auto-accept" })
    ).rejects.not.toThrow("must-not-leak");
  });
});
