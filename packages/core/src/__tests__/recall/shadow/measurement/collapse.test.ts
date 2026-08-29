import { describe, expect, it } from "vitest";
import {
  collapseMeasurementGroup,
  createMeasurementGroupContractV1
} from "../../../../recall/shadow/measurement/index.js";
import {
  createNumericIntervalWitness,
  type NumericIntervalWitness
} from "../../../../recall/shadow/witness/index.js";
import { PINS, PROV } from "../witness/fixtures.js";

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

  it("keeps a lawful collapse unchanged after an unsound extra fragment is added", () => {
    const contract = createMeasurementGroupContractV1({
      ...BASE,
      combine_operator: "bound_intersection"
    });
    const lawful = collapseMeasurementGroup({
      contract,
      observations: [numeric("c1", 0, 10), numeric("c2", 2, 8)]
    });
    const withUnknown = collapseMeasurementGroup({
      contract,
      observations: [
        numeric("c1", 0, 10),
        numeric("c2", 2, 8),
        createNumericIntervalWitness({
          identity: { ...PINS, coordinate_id: "c3", proposition_id: "prop-1" },
          provenance: PROV,
          epistemic: { kind: "unavailable" },
          payload: null
        })
      ]
    });
    expect(lawful.status).toBe("collapsed");
    expect(withUnknown.status).toBe("collapsed");
    if (lawful.status === "collapsed" && withUnknown.status === "collapsed") {
      expect(withUnknown.witness.payload).toEqual(lawful.witness.payload);
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
});

function numeric(
  coordinate: string,
  lower: number,
  upper: number,
  identity: { candidate_id?: string } = {}
): NumericIntervalWitness {
  return createNumericIntervalWitness({
    identity: {
      ...PINS,
      coordinate_id: coordinate,
      candidate_id: identity.candidate_id ?? PINS.candidate_id,
      proposition_id: "prop-1"
    },
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { lower, upper }
  });
}

