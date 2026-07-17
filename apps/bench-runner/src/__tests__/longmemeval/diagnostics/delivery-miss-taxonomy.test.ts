import { describe, expect, it } from "vitest";
import {
  classifyDeliveryMissTaxonomy,
  type DeliveryMissCandidateInput
} from "../../../longmemeval/diagnostics/miss/delivery-miss-taxonomy.js";

function candidate(
  overrides: Partial<DeliveryMissCandidateInput> = {}
): DeliveryMissCandidateInput {
  return {
    objectKind: "memory_entry",
    preBudgetRank: 4,
    fusedRank: 4,
    finalRank: null,
    droppedReason: null,
    rankAfterFusion: 4,
    rankAfterFeatureRerank: 4,
    rankAfterCoverageSelector: 4,
    coverageSelectorAction: "kept",
    ...overrides
  };
}

describe("classifyDeliveryMissTaxonomy", () => {
  it("returns null when gold is delivered within top-5", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: 3,
        candidate: candidate({ finalRank: 3 }),
        anyObjectCandidate: undefined,
        fineAssessmentPruned: false,
        anyObjectFineAssessmentPruned: false,
        diagnosticsAvailable: true
      })
    ).toBeNull();
  });

  it("classifies candidate_absent when the gold never entered the pool", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: null,
        candidate: undefined,
        anyObjectCandidate: undefined,
        fineAssessmentPruned: false,
        anyObjectFineAssessmentPruned: false,
        diagnosticsAvailable: true
      })
    ).toBe("candidate_absent");
  });

  it("classifies materialization_drop when only a non-memory_entry row exists", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: null,
        candidate: undefined,
        anyObjectCandidate: candidate({ objectKind: "synthesis_capsule" }),
        fineAssessmentPruned: false,
        anyObjectFineAssessmentPruned: false,
        diagnosticsAvailable: true
      })
    ).toBe("materialization_drop");
  });

  it("classifies an exact fine-waist prune before candidate absence", () => {
    expect(classifyDeliveryMissTaxonomy({
      deliveredRank: null,
      candidate: undefined,
      anyObjectCandidate: undefined,
      fineAssessmentPruned: true,
      anyObjectFineAssessmentPruned: true,
      diagnosticsAvailable: true
    })).toBe("fine_assessment_drop");
  });

  it("classifies budget_drop when a pool candidate is cut by max_entries inside the delivery window", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: null,
        candidate: candidate({
          preBudgetRank: 4,
          fusedRank: 4,
          finalRank: null,
          droppedReason: "max_entries"
        }),
        anyObjectCandidate: undefined,
        diagnosticsAvailable: true
      })
    ).toBe("budget_drop");
  });

  it("classifies embedding-head dominance as an explicit delivery admission drop", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: null,
        candidate: candidate({
          preBudgetRank: 2,
          droppedReason: "embedding_head_dominance"
        }),
        anyObjectCandidate: undefined,
        diagnosticsAvailable: true
      })
    ).toBe("budget_drop");
  });

  it("does not blame coverage when the feature head already moved fused top-5 gold out", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: 8,
        candidate: candidate({
          finalRank: 8,
          rankAfterFusion: 3,
          rankAfterFeatureRerank: 8,
          rankAfterCoverageSelector: 9,
          coverageSelectorAction: "displaced"
        }),
        anyObjectCandidate: undefined,
        diagnosticsAvailable: true
      })
    ).toBe("delivery_order_drop");
  });

  it("classifies coverage only when the feature head enters top-5 before coverage removes it", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: 8,
        candidate: candidate({
          finalRank: 8,
          rankAfterFusion: 8,
          rankAfterFeatureRerank: 3,
          rankAfterCoverageSelector: 8,
          coverageSelectorAction: "displaced"
        }),
        anyObjectCandidate: undefined,
        diagnosticsAvailable: true
      })
    ).toBe("answer_set_coverage_drop");
  });

  it("classifies delivery_order_drop when gold stays in pool but lands outside top-5 without budget or coverage loss", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: 8,
        candidate: candidate({
          finalRank: 8,
          rankAfterFusion: 8,
          rankAfterFeatureRerank: 8,
          rankAfterCoverageSelector: 8,
          coverageSelectorAction: "kept"
        }),
        anyObjectCandidate: undefined,
        diagnosticsAvailable: true
      })
    ).toBe("delivery_order_drop");
  });

  it("returns null when recall diagnostics are unavailable", () => {
    expect(
      classifyDeliveryMissTaxonomy({
        deliveredRank: null,
        candidate: undefined,
        anyObjectCandidate: undefined,
        diagnosticsAvailable: false
      })
    ).toBeNull();
  });
});
