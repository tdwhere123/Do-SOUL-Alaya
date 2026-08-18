import { describe, expect, it } from "vitest";

import { materializeConfiguredCoverageSelection } from
  "../../../recall/field/facility/selection-objective.js";

import {
  createRecallFieldRefinementStopCertificate,
  RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
  verifyRecallFieldRefinementStopCertificate
} from "../../../recall/field/refinement/field-refinement-stop-certificate.js";
import { createRecallRetrievalFieldRefinementReceipt } from
  "../../../recall/field/refinement/field-refinement-receipt.js";
import { createRecallFiniteFieldSeal } from
  "../../../recall/field/finite-field-seal.js";
import { createRecallRelevanceUpperBoundReceipt } from
  "../../../recall/rerank/relevance-upper-bound-receipt.js";
import {
  createRankedCandidate,
  createSupplementaryData
} from "../fine-assessment-selection-fixtures.js";

describe("field refinement stop certificate", () => {
  it("certifies a dominated one-exchange bound for a unit relevance objective", () => {
    const fixture = createFixture([1, 1, 1, 1, 1]);
    const receipt = createRecallFieldRefinementStopCertificate(fixture);

    expect(receipt.status).toBe("certified");
    expect(receipt.reason).toBe("exchange_dominated");
    expect(receipt.operator_id).toBe(RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID);
    expect(receipt.activation_mode).toBe("live");
    expect(receipt.candidate_membership_changed).toBe(false);
    expect(receipt.maximum_exchange_improvement_upper_bound).toBe(0);
    expect(receipt.exchange_bounds).toHaveLength(5);
    expect(receipt.exchange_bounds.every((bound) =>
      bound.incumbent_loss === 1 &&
      bound.unseen_gain_upper_bound === 1 &&
      bound.improvement_upper_bound === 0
    )).toBe(true);
    expect(() => verifyRecallFieldRefinementStopCertificate(receipt))
      .not.toThrow();
  });

  it("keeps refinement open when an unseen candidate can improve the packet", () => {
    const receipt = createRecallFieldRefinementStopCertificate(
      createFixture([0.9, 0.9, 0.9, 0.9, 0.9])
    );

    expect(receipt.status).toBe("uncertified");
    expect(receipt.reason).toBe("exchange_not_dominated");
    expect(receipt.maximum_exchange_improvement_upper_bound)
      .toBeCloseTo(0.1, 12);
  });

  it("witnesses the complete selected packet beyond five entries", () => {
    const receipt = createRecallFieldRefinementStopCertificate(
      createFixture([1, 1, 1, 1, 1, 1, 1])
    );

    expect(receipt.selection_capacity).toBe(7);
    expect(receipt.selected_candidate_keys).toHaveLength(7);
    expect(receipt.exchange_bounds).toHaveLength(7);
    expect(() => verifyRecallFieldRefinementStopCertificate(receipt))
      .not.toThrow();
  });

  it("fails closed when the configured objective has no admissible bound", () => {
    const fixture = createFixture([1, 1, 1, 1, 1], false);
    const receipt = createRecallFieldRefinementStopCertificate(fixture);

    expect(receipt.status).toBe("uncertified");
    expect(receipt.reason).toBe("objective_bound_unavailable");
    expect(receipt.exchange_bounds).toEqual([]);
  });
});

function createFixture(
  relevanceScores: readonly number[],
  facility = true
) {
  const candidates = relevanceScores.map((score, index) =>
    createRankedCandidate(`candidate-${index + 1}`, index + 1, score)
  );
  const supplementaryData = createSupplementaryData();
  const relevanceByCandidateKey = new Map(candidates.map((candidate, index) => [
    candidate.fusion.candidate_key,
    relevanceScores[index]!
  ]));
  const preparedSelection = materializeConfiguredCoverageSelection({
    candidates,
    relevanceByCandidateKey,
    supplementaryData,
    ...(facility ? { config: facilityConfig() } : {})
  });
  const refinementReceipt = createRefinementReceipt();
  return {
    fieldSeal: createTruncatedFieldSeal(),
    refinementReceipts: [refinementReceipt],
    preparedSelection,
    selectionCapacity: candidates.length,
    selectedCandidateKeys: candidates.map(({ fusion }) => fusion.candidate_key),
    supplementaryData,
    relevanceUpperBound: createRecallRelevanceUpperBoundReceipt(
      "unit_test_score_v1",
      relevanceByCandidateKey
    )
  } as const;
}

function facilityConfig() {
  return {
    operator_id: "attributed_facility_location_v1" as const,
    base_relevance_weight: 1,
    demand_weights: {
      entity: 0,
      relation: 0,
      time: 0,
      logical_object: 0,
      independent_evidence: 0
    }
  } as const;
}

function createTruncatedFieldSeal() {
  return createRecallFiniteFieldSeal({
    upstream_snapshot_digest: `sha256:${"a".repeat(64)}`,
    channel_catalog: ["test_channel"],
    channels: [{
      channel_id: "test_channel",
      status: "truncated",
      depth: 1,
      observations: [{
        observation_id: "test:1",
        candidate_key: "workspace_local:memory_entry:candidate-1",
        rank: 1
      }],
      unseen_upper_bound: 1
    }]
  });
}

function createRefinementReceipt() {
  const receipt = createRecallRetrievalFieldRefinementReceipt({
    request_digest: `sha256:${"b".repeat(64)}`,
    requested_depth: 1,
    object_kind: "memory_entry",
    result: {
      matches: [{ object_id: "candidate-1", normalized_rank: 1 }],
      lanes: [{
        lane: "exact",
        status: "truncated",
        depth: 1,
        observations: [{ object_id: "candidate-1", rank: 1, normalized_rank: 1 }],
        unseen_upper_bound: 1
      }, emptyLane("porter"), emptyLane("trigram")]
    }
  });
  if (receipt === null) throw new Error("refinement receipt was not created");
  return receipt;
}

function emptyLane(lane: "porter" | "trigram") {
  return {
    lane,
    status: "ineligible" as const,
    depth: 0,
    observations: [],
    unseen_upper_bound: null
  };
}
