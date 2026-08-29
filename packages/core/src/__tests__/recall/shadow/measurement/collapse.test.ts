import { describe, expect, it } from "vitest";
import {
  collapseMeasurementGroup,
  createMeasurementGroupContractV1
} from "../../../../recall/shadow/measurement/index.js";
import {
  createNumericIntervalWitness,
  isKnownZeroEpistemic,
  type NumericIntervalWitness,
  type WitnessEpistemic
} from "../../../../recall/shadow/witness/index.js";
import { COMPLETE, PINS, PROV, PROV_EXTENDED } from "../witness/fixtures.js";

const BASE = {
  contract_id: "measure.support.v1",
  operator_version: "1",
  proposition_schema: "works_at",
  measurement_domain: "numeric_interval" as const,
  comparison_direction: "higher_is_stronger" as const,
  correlation_policy: "identity_dedupe" as const,
  soundness_preconditions: ["same_binding", "exact_numeric"],
  upper_bound_rule: "interval_upper" as const
};

describe("measurement group collapse", () => {
  it("intersects bounds, dedupes coordinates, and conflicts on disjoint exact values", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "bound_intersection"
    });
    const collapsed = collapseMeasurementGroup({
      contract,
      observations: [
        numeric("c1", 0, 10),
        numeric("c1", 0, 10),
        numeric("c2", 5, 12)
      ]
    });
    expect(collapsed.status).toBe("collapsed");
    if (collapsed.status === "collapsed") {
      expect(collapsed.witness.payload).toEqual({ lower: 5, upper: 10 });
    }
    const conflict = collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 1, 1), numeric("c2", 2, 2)]
    });
    expect(conflict.status).toBe("conflict");
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), numeric("c1", 1, 4)]
    }).status).toBe("conflict");
  });

  it("unions duplicate-coordinate provenance deterministically across permutations", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "bound_intersection"
    });
    const first = numeric("c1", 0, 10, {}, PROV);
    const duplicate = numeric("c1", 0, 10, {}, PROV_EXTENDED.slice(1));

    const forward = collapseMeasurementGroup({
      contract,
      observations: [first, duplicate]
    });
    const reverse = collapseMeasurementGroup({
      contract,
      observations: [duplicate, first]
    });

    expect(forward.status).toBe("collapsed");
    expect(reverse.status).toBe("collapsed");
    if (forward.status === "collapsed" && reverse.status === "collapsed") {
      expect(forward.witness.provenance).toEqual(PROV_EXTENDED);
      expect(reverse.witness.provenance).toEqual(PROV_EXTENDED);
      expect(reverse.witness).toEqual(forward.witness);
    }
  });

  it("rejects mixed bindings, unknown correlation, and exact comparator without an upper rule", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      correlation_policy: "unknown_blocks",
      combine_operator: "bound_intersection"
    });
    expect(() => collapseMeasurementGroup({
      contract,
      observations: [
        numeric("c1", 0, 10),
        numeric("c2", 1, 4, { candidate_id: "other" })
      ]
    })).toThrow(/same candidate\/proposition/u);
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), numeric("c2", 1, 4)]
    }).status).toBe("unresolved");
    expect(() => createMeasurementGroupContractV1({
      ...BASE,
      comparison_direction: "exact",
      combine_operator: "proved_lower_max",
      upper_bound_rule: "none_declared"
    })).toThrow(/upper-bound/u);
  });

  it("fails closed when an applicable unknown or conflict observation is present", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "bound_intersection"
    });
    const lawful = collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), numeric("c2", 2, 8)]
    });
    expect(lawful.status).toBe("collapsed");
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), numeric("c2", 2, 8), nonExact("c3", { kind: "unavailable" })]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), nonExact("c3", { kind: "not_observed" })]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract,
      observations: [
        numeric("c1", 0, 10),
        nonExact("c3", { kind: "negative", named_negative: "h_event" })
      ]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), nonExact("c3", { kind: "conflict" })]
    }).status).toBe("conflict");
  });

  it("preserves known_zero completeness on a collapsed exact zero", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "bound_intersection"
    });
    const collapsed = collapseMeasurementGroup({
      contract,
      observations: [knownZero("c1"), numeric("c2", 0, 10)]
    });
    expect(collapsed.status).toBe("collapsed");
    if (collapsed.status === "collapsed") {
      expect(collapsed.witness.payload).toEqual({ lower: 0, upper: 0 });
      expect(isKnownZeroEpistemic(collapsed.witness.epistemic)).toBe(true);
      if (isKnownZeroEpistemic(collapsed.witness.epistemic)) {
        expect(collapsed.witness.epistemic.completeness).toEqual(COMPLETE);
      }
    }
    const plainZero = collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 0), numeric("c2", 0, 0)]
    });
    expect(plainZero.status).toBe("collapsed");
    if (plainZero.status === "collapsed") {
      expect(isKnownZeroEpistemic(plainZero.witness.epistemic)).toBe(false);
    }
    const absence = knownZero("c3", null);
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), absence]
    }).status).toBe("conflict");
    const onlyAbsence = collapseMeasurementGroup({
      contract,
      observations: [absence]
    });
    expect(onlyAbsence.status).toBe("collapsed");
    if (onlyAbsence.status === "collapsed") {
      expect(onlyAbsence.witness.payload).toBeNull();
      expect(isKnownZeroEpistemic(onlyAbsence.witness.epistemic)).toBe(true);
    }
  });

  it("changes digest when the combine operator changes", () => {
    const intersection = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "bound_intersection"
    });
    const agreement = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "exact_agreement"
    });
    expect(intersection.digest).not.toBe(agreement.digest);
  });

  it("applies proved_lower_max with a declared upper rule and existential nested proof", () => {
    const lowerMax = collapseMeasurementGroup({
      contract: createMeasurementGroupContractV1({
        ...BASE,
        combine_operator: "proved_lower_max"
      }),
      observations: [numeric("c1", 1, 9), numeric("c2", 3, 8)]
    });
    expect(lowerMax.status).toBe("collapsed");
    if (lowerMax.status === "collapsed") {
      expect(lowerMax.witness.payload).toEqual({ lower: 3, upper: 8 });
    }
    const nested = collapseMeasurementGroup({
      contract: createMeasurementGroupContractV1({
        ...BASE,
        combine_operator: "existential_proof"
      }),
      observations: [numeric("c1", 0, 10), numeric("c2", 2, 6)]
    });
    expect(nested.status).toBe("collapsed");
    if (nested.status === "collapsed") {
      expect(nested.witness.payload).toEqual({ lower: 2, upper: 6 });
    }
  });

  it("does not treat existential_proof as intersection of non-nested overlap", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "existential_proof"
    });
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), numeric("c2", 5, 12)]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 2), numeric("c2", 5, 8)]
    }).status).toBe("conflict");
  });

  it("returns typed operator results instead of throwing on unsound composition", () => {
    const lowerMax = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "proved_lower_max"
    });
    expect(() => collapseMeasurementGroup({
      contract: lowerMax,
      observations: [numeric("c1", 1, 2), numeric("c2", 4, 5)]
    })).not.toThrow();
    expect(collapseMeasurementGroup({
      contract: lowerMax,
      observations: [numeric("c1", 1, 2), numeric("c2", 4, 5)]
    }).status).toBe("conflict");
    expect(collapseMeasurementGroup({
      contract: createMeasurementGroupContractV1({
        ...BASE,
        combine_operator: "proved_lower_max",
        upper_bound_rule: "none_declared"
      }),
      observations: [numeric("c1", 1, 9), numeric("c2", 3, 8)]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract: createMeasurementGroupContractV1({
        ...BASE,
        combine_operator: "identity_dedupe"
      }),
      observations: [numeric("c1", 0, 10), numeric("c2", 5, 12)]
    }).status).toBe("unresolved");
  });
});

function numeric(
  coordinate: string,
  lower: number,
  upper: number,
  identity: { candidate_id?: string } = {},
  provenance = PROV
): NumericIntervalWitness {
  return createNumericIntervalWitness({
    identity: {
      ...PINS,
      coordinate_id: coordinate,
      candidate_id: identity.candidate_id ?? PINS.candidate_id,
      proposition_id: "prop-1"
    },
    provenance,
    epistemic: { kind: "exact" },
    payload: { lower, upper }
  });
}

function knownZero(
  coordinate: string,
  payload: { lower: number; upper: number } | null = { lower: 0, upper: 0 }
): NumericIntervalWitness {
  return createNumericIntervalWitness({
    identity: {
      ...PINS,
      coordinate_id: coordinate,
      proposition_id: "prop-1"
    },
    provenance: PROV,
    epistemic: { kind: "exact", known_zero: true, completeness: COMPLETE },
    payload
  });
}

function nonExact(
  coordinate: string,
  epistemic: WitnessEpistemic
): NumericIntervalWitness {
  return createNumericIntervalWitness({
    identity: {
      ...PINS,
      coordinate_id: coordinate,
      proposition_id: "prop-1"
    },
    provenance: PROV,
    epistemic,
    payload: null
  });
}
