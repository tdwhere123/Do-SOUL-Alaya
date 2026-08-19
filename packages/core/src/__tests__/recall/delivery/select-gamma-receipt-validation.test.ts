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
    ["version", { schema_version: 0 }],
    ["basis", { ordering_basis: "marginal_gain_per_token" }],
    ["K", { witness: selectionWitness({ k: 2 }) }],
    ["upper bound", {
      witness: selectionWitness({ top_k_token_cost_upper_bound: 4 })
    }],
    ["eligible count", {
      witness: selectionWitness({ eligible_candidate_count: 2 })
    }]
  ])("rejects a malformed selection receipt %s", (_name, patch) => {
    const { candidate, context, walk } = fixture();
    const malformed = {
      ...walk,
      selection_receipt: { ...walk.selection_receipt, ...patch }
    } as unknown as SelectGammaWalkResult;

    expect(() => materializeSelectGammaAccumulator(
      [candidate], malformed, context, false
    )).toThrow(/selection receipt/u);
  });

  it.each([
    ["top-level", { unexpected: true }],
    ["witness", { witness: { ...selectionWitness(), unexpected: true } }]
  ])("rejects selection receipt extra keys at the %s", (_name, patch) => {
    const { candidate, context, walk } = fixture();
    const malformed = {
      ...walk,
      selection_receipt: { ...walk.selection_receipt, ...patch }
    } as unknown as SelectGammaWalkResult;

    expect(() => materializeSelectGammaAccumulator(
      [candidate], malformed, context, false
    )).toThrow(/selection receipt/u);
  });

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
    selection_receipt: {
      schema_version: 1,
      ordering_basis: "raw_marginal_gain",
      witness: selectionWitness()
    },
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

function selectionWitness(
  patch: Readonly<Partial<{
    eligible_candidate_count: number;
    k: number;
    top_k_token_cost_upper_bound: number;
    token_budget: number;
  }>> = {}
) {
  return {
    kind: "static_top_k_token_bound" as const,
    eligible_candidate_count: 1,
    k: 1,
    top_k_token_cost_upper_bound: 5,
    token_budget: 100,
    ...patch
  };
}
