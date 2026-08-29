import { describe, expect, it } from "vitest";
import { isPsiCycleFailure, peelUndominated } from
  "../../../../recall/shadow/frontier-peel.js";
import {
  collapseMeasurementGroup,
  createMeasurementGroupContractV1
} from "../../../../recall/shadow/measurement/index.js";
import {
  comparePsiV2,
  peelPsiV2Frontiers,
  psiV2CycleCount,
  psiV2Dominates,
  type PsiV2CandidateV1
} from "../../../../recall/shadow/psi-v2/index.js";
import { createNumericIntervalWitness } from "../../../../recall/shadow/witness/index.js";
import { PINS, PROV } from "../witness/fixtures.js";

const CONTRACT = createMeasurementGroupContractV1({
  contract_id: "psi.v2.numeric",
  operator_version: "1",
  proposition_schema: "support",
  measurement_domain: "numeric_interval",
  comparison_direction: "higher_is_stronger",
  correlation_policy: "identity_dedupe",
  combine_operator: "bound_intersection",
  soundness_preconditions: ["same_binding"],
  upper_bound_rule: "interval_upper"
});

describe("proposition Psi v2", () => {
  it("is irreflexive, asymmetric, and transitive on collapsed intervals", () => {
    const strong = candidate("a", [["p", 5, 5]]);
    const mid = candidate("b", [["p", 3, 3]]);
    const weak = candidate("c", [["p", 1, 1]]);
    expect(psiV2Dominates(strong, strong)).toBe(false);
    expect(psiV2Dominates(strong, mid)).toBe(true);
    expect(psiV2Dominates(mid, strong)).toBe(false);
    expect(psiV2Dominates(strong, weak)).toBe(true);
    expect(comparePsiV2(strong, mid).kind).toBe("dominates");
  });

  it("keeps genuine trade-offs unresolved and blocks on unknown collapse", () => {
    const mixed = candidate("a", [["p", 9, 9], ["q", 1, 1]]);
    const other = candidate("b", [["p", 1, 1], ["q", 9, 9]]);
    expect(comparePsiV2(mixed, other).kind).toBe("tradeoff");
    const blocked = candidate("c", [["p", 9, 9]]);
    const unknown: PsiV2CandidateV1 = {
      candidate_id: "d",
      coordinates: [{
        proposition_id: "p",
        applicable: true,
        collapse: {
          status: "unresolved",
          reason: "unknown correlation blocks collapse",
          observations: []
        }
      }]
    };
    expect(comparePsiV2(blocked, unknown).kind).toBe("blocked");
  });

  it("does not let a missing raw family fragment veto after lawful collapse", () => {
    const collapsed = candidate("a", [["p", 4, 4]]);
    const weaker = candidate("b", [["p", 1, 1]]);
    expect(comparePsiV2(collapsed, weaker).kind).toBe("dominates");
  });

  it("peels deterministic frontiers without deleting dominated candidates from the input", () => {
    const field = [
      candidate("a", [["p", 5, 5]]),
      candidate("b", [["p", 3, 3]]),
      candidate("c", [["p", 1, 1]])
    ];
    const peeled = peelPsiV2Frontiers(field);
    expect(isPsiCycleFailure(peeled)).toBe(false);
    if (!isPsiCycleFailure(peeled)) {
      expect(peeled.layers[0]?.member_keys).toEqual(["a"]);
      expect(peeled.layers.map((layer) => layer.member_keys).flat().sort()).toEqual(["a", "b", "c"]);
    }
    expect(field.map((row) => row.candidate_id)).toEqual(["a", "b", "c"]);
    expect(psiV2CycleCount(peeled)).toBe(0);
  });

  it("fails closed when the peel predicate cycles", () => {
    const cyclic = peelUndominated(["a", "b"], (left, right) => left !== right);
    expect(isPsiCycleFailure(cyclic)).toBe(true);
    expect(psiV2CycleCount(cyclic)).toBe(1);
  });
});

function candidate(
  id: string,
  rows: readonly [string, number, number][]
): PsiV2CandidateV1 {
  return {
    candidate_id: id,
    coordinates: rows.map(([propositionId, lower, upper]) => ({
      proposition_id: propositionId,
      applicable: true,
      collapse: collapseOne(id, propositionId, lower, upper)
    }))
  };
}

function collapseOne(
  candidateId: string,
  propositionId: string,
  lower: number,
  upper: number
) {
  return collapseMeasurementGroup({
    contract: CONTRACT,
    observations: [
      createNumericIntervalWitness({
        identity: {
          ...PINS,
          coordinate_id: `${candidateId}:${propositionId}`,
          candidate_id: candidateId,
          proposition_id: propositionId
        },
        provenance: PROV,
        epistemic: { kind: "exact" },
        payload: { lower, upper }
      })
    ]
  });
}
