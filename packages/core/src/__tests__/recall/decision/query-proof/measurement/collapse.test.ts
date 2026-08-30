import { describe, expect, it } from "vitest";
import {
  collapseMeasurementGroup,
  createMeasurementGroupContractV1
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import {
  createCorrelationWitness,
  createNumericIntervalWitness,
  isKnownZeroEpistemic,
  type NumericIntervalWitness,
  type WitnessEpistemic
} from "../../../../../recall/decision/query-proof/witness/index.js";
import { PINS, PROV, PROV_EXTENDED, UNISSUED_COMPLETENESS } from
  "../witness/fixtures.js";

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

  it("does not leak source-coordinate completeness onto a collapsed coordinate", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "bound_intersection"
    });
    expect(() => knownZero("c1")).toThrow(/issued completeness authority/u);
    const collapsed = collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 0), numeric("c2", 0, 10)]
    });
    expect(collapsed.status).toBe("collapsed");
    if (collapsed.status === "collapsed") {
      expect(collapsed.witness.payload).toEqual({ lower: 0, upper: 0 });
      expect(isKnownZeroEpistemic(collapsed.witness.epistemic)).toBe(false);
    }
    const plainZero = collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 0), numeric("c2", 0, 0)]
    });
    expect(plainZero.status).toBe("collapsed");
    if (plainZero.status === "collapsed") {
      expect(isKnownZeroEpistemic(plainZero.witness.epistemic)).toBe(false);
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

  it("takes the sound maximum of overlapping intervals and preserves existential nesting", () => {
    const lowerMax = collapseMeasurementGroup({
      contract: createMeasurementGroupContractV1({
        ...BASE,
        combine_operator: "proved_lower_max"
      }),
      observations: [numeric("c1", 1, 9), numeric("c2", 3, 8)]
    });
    expect(lowerMax.status).toBe("collapsed");
    if (lowerMax.status === "collapsed") {
      expect(lowerMax.witness.payload).toEqual({ lower: 3, upper: 9 });
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

  it("takes the sound maximum of disjoint intervals independent of input order", () => {
    const lowerMax = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "proved_lower_max"
    });
    const forward = collapseMeasurementGroup({
      contract: lowerMax,
      observations: [numeric("c1", 1, 2), numeric("c2", 4, 5)]
    });
    const reverse = collapseMeasurementGroup({
      contract: lowerMax,
      observations: [numeric("c2", 4, 5), numeric("c1", 1, 2)]
    });
    expect(forward.status).toBe("collapsed");
    expect(reverse.status).toBe("collapsed");
    if (forward.status === "collapsed" && reverse.status === "collapsed") {
      expect(forward.witness.payload).toEqual({ lower: 4, upper: 5 });
      expect(reverse.witness.payload).toEqual(forward.witness.payload);
    }
  });

  it("preserves exact points and typed unresolved results for proved_lower_max", () => {
    const lowerMax = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "proved_lower_max"
    });
    const exact = collapseMeasurementGroup({
      contract: lowerMax,
      observations: [numeric("c1", 2, 2), numeric("c2", 4, 4)]
    });
    expect(exact.status).toBe("collapsed");
    if (exact.status === "collapsed") {
      expect(exact.witness.payload).toEqual({ lower: 4, upper: 4 });
    }
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

  it("does not let a foreign query or snapshot correlation witness authorize collapse", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      correlation_policy: "unknown_blocks",
      combine_operator: "bound_intersection"
    });
    const observations = [numeric("c1", 0, 10), numeric("c2", 5, 12)];
    const live = correlation("c1", "c2");
    const collapsed = collapseMeasurementGroup({
      contract,
      observations,
      correlations: [live]
    });
    expect(collapsed.status).toBe("collapsed");
    if (collapsed.status === "collapsed") {
      expect(collapsed.witness.payload).toEqual({ lower: 5, upper: 10 });
    }
    expect(collapseMeasurementGroup({
      contract,
      observations,
      correlations: [correlation("c1", "c2", { query_id: "query-stale" })]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract,
      observations,
      correlations: [correlation("c1", "c2", {
        snapshot_digest: `sha256:${"f".repeat(64)}`
      })]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract,
      observations,
      correlations: [correlation("c1", "c2", { candidate_id: "other-cand" })]
    }).status).toBe("unresolved");
    expect(collapseMeasurementGroup({
      contract,
      observations,
      correlations: [correlation("c1", "c2", { proposition_id: "other-prop" })]
    }).status).toBe("unresolved");
  });
});

function correlation(
  leftId: string,
  rightId: string,
  identity: {
    query_id?: string;
    snapshot_digest?: string;
    candidate_id?: string;
    proposition_id?: string;
  } = {}
) {
  return createCorrelationWitness({
    identity: {
      ...PINS,
      coordinate_id: `corr:${leftId}:${rightId}`,
      candidate_id: identity.candidate_id ?? PINS.candidate_id,
      proposition_id: identity.proposition_id ?? "prop-1",
      ...(identity.query_id === undefined ? {} : { query_id: identity.query_id }),
      ...(identity.snapshot_digest === undefined
        ? {}
        : { snapshot_digest: identity.snapshot_digest })
    },
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: {
      left_id: leftId,
      right_id: rightId,
      state: "certified_independent"
    }
  });
}

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
  const identity = {
    ...PINS,
    coordinate_id: coordinate,
    proposition_id: "prop-1"
  };
  return createNumericIntervalWitness({
    identity,
    provenance: PROV,
    epistemic: {
      kind: "exact",
      known_zero: true,
      completeness: {
        ...UNISSUED_COMPLETENESS,
        coordinate_id: identity.coordinate_id
      }
    },
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
