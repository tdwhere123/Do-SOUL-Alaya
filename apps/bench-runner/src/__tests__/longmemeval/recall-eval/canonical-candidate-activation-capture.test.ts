import { describe, expect, it } from "vitest";
import { createCandidateActivationCapture } from
  "../../../runs/lifecycle/recall-eval/recall-eval-candidate-activation.js";
import { CanonicalSelectionReceiptSchema } from
  "../../../harness/recall/capture/capture-receipt-schema.js";

describe("canonical candidate activation capture", () => {
  it("keeps the sidecar field missing when the observer never fired", () => {
    const capture = createCandidateActivationCapture(true);
    const attached = capture.attach({ diagnostics: {} } as never) as Readonly<{
      diagnostics: Readonly<Record<string, unknown>>;
    }>;
    expect(attached.diagnostics)
      .not.toHaveProperty("open_semantic_factor_candidate_activations");
  });

  it("records an observed empty list for a valid pure control", () => {
    const capture = createCandidateActivationCapture(true);
    capture.observer?.({
      supplementaryData: {},
      result: { ranking_authority: "prefix_sk" }
    } as never);

    const attached = capture.attach({ diagnostics: {} } as never) as Readonly<{
      diagnostics: Readonly<{
        open_semantic_factor_candidate_activations: readonly unknown[];
      }>;
    }>;

    expect(attached.diagnostics.open_semantic_factor_candidate_activations).toEqual([]);
  });

  it("roundtrips a nonempty attributed observation", () => {
    const capture = createCandidateActivationCapture(true);
    const receipt = { state: "direct", score: 0.7 };
    capture.observer?.({
      supplementaryData: {
        openSemanticFactorCandidateActivationsByCandidateKey: new Map([
          ["candidate:b", receipt]
        ])
      },
      result: { ranking_authority: "prefix_sk" }
    } as never);
    const attached = capture.attach({ diagnostics: {} } as never) as Readonly<{
      diagnostics: Readonly<{ open_semantic_factor_candidate_activations: readonly unknown[] }>;
    }>;
    expect(attached.diagnostics.open_semantic_factor_candidate_activations).toEqual([{
      candidate_key: "candidate:b", receipt
    }]);
  });

  it("accepts the shared membership failure reason with empty delivery", () => {
    const receipt = createCanonicalSelectionReceipt({
      schema_version: 1,
      ranking_authority: "prefix_sk",
      identity: {
        algorithm_id: "alaya.recall.shadow.safe-dominance-capture.v1",
        version: "safe-dominance-capture.v1.0.1",
        digest: "384af589ca9be6791147016463a44519aa9405a70d694cf38a1db9b8991913cd"
      },
      execution: { status: "fail_closed", reason: "membership_shrink" },
      field_membership: {
        e0_keys: ["candidate:a"], e1_keys: [], eligible_keys: []
      },
      observations_by_candidate_key: null,
      frontiers: null,
      gamma: { set_utilities: [], decisions: [], rejects: [] },
      dispositions: [],
      delivery: []
    }, (preimage) => createHash("sha256").update(preimage, "utf8").digest("hex"));
    const parsed = CanonicalSelectionReceiptSchema.parse(receipt);

    expect(parsed.execution.reason).toBe("membership_shrink");
    expect(parsed.delivery).toEqual([]);
  });
});
import { createHash } from "node:crypto";
import { createCanonicalSelectionReceipt } from "@do-soul/alaya-protocol";
