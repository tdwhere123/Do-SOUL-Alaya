import { describe, expect, it } from "vitest";
import { materializeSelectGammaAccumulator } from
  "../../../recall/delivery/fine-assessment-selection/gamma-delivery.js";
import { createSelectionContext } from
  "../../../recall/delivery/fine-assessment-selection/coverage-order.js";
import type {
  SelectGammaDecisionReceipt,
  SelectGammaWalkResult
} from "../../../recall/delivery/select-gamma/types.js";
import {
  FIELD_PINS,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "../fine-assessment-selection-fixtures.js";

describe("Select_Gamma receipt validation", () => {
  it.each([
    ["selected counter", { selected_count_before: 1 }],
    ["token counter", { token_total_before: 1 }],
    ["token estimate", { token_estimate: 0 }],
    ["source identity", { source: { status: "available", key: "" } }],
    ["lineage identity", { lineage: { status: "unknown" } }]
  ])("rejects malformed retained %s without boundary capture", (_name, patch) => {
    const { candidate, context, walk } = fixture();
    const retained = walk.decisions[0]!.receipt;
    if (retained.kind !== "retained") throw new Error("expected retained receipt");
    const malformed: SelectGammaWalkResult = {
      ...walk,
      decisions: [{
        ...walk.decisions[0]!,
        receipt: { ...retained, ...patch } as SelectGammaDecisionReceipt
      }]
    };

    expect(() => materializeSelectGammaAccumulator(
      [candidate], malformed, context, false
    )).toThrow(/retained receipt is invalid/u);
  });

  it("materializes a valid receipt without boundary capture", () => {
    const { candidate, context, walk } = fixture();
    const result = materializeSelectGammaAccumulator(
      [candidate], walk, context, false
    );

    expect(result.selected.map(({ object_id }) => object_id)).toEqual(["receipt"]);
    expect(result.admissionReceipts).toBeUndefined();
  });
});

function fixture() {
  const candidate = createRankedCandidate("receipt", 1, 1);
  const params = {
    ...FIELD_PINS,
    orderedCandidates: [candidate],
    config: createConfig(),
    supplementaryData: createSupplementaryData(),
    tokenEstimator: { estimate: () => 5 },
    rankByCandidateKey: rankMap([candidate])
  };
  const walk: SelectGammaWalkResult = {
    selected_candidate_keys: [candidate.fusion.candidate_key],
    decisions: [{
      candidate_key: candidate.fusion.candidate_key,
      selection_order: 1,
      selected_rank: 1,
      marginal_gain: 1,
      receipt: {
        kind: "retained",
        selected_count_before: 0,
        token_total_before: 0,
        token_estimate: 5,
        source: { status: "unavailable" },
        lineage: { status: "unavailable" }
      }
    }]
  };
  return { candidate, context: createSelectionContext(params), walk };
}
