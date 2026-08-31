import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateAbstractProofKernel } from
  "../../../../../../recall/decision/query-proof/proof/abstract/kernel.js";
import { createChannelClosureResult } from
  "../../../../../../recall/decision/query-proof/closure/contract.js";
import { deriveLiveClosureAuthorityBinding } from
  "../../../../../../recall/decision/query-proof/closure/live-authority-binding.js";
import type { AbstractCoordinate } from
  "../../../../../../recall/decision/query-proof/proof/abstract/contract.js";
import type { PreparedRecallRequest } from
  "../../../../../../recall/runtime/recall-service-runner-types.js";
import {
  authorityFrom,
  cleanup,
  preparedAuthority
} from "../../../../integration/shadow/live-receipt-fixtures.js";
import {
  createKernelCase,
  feasibilityCoordinate,
  membershipCoordinate,
  singletonOperator,
  trace
} from "./proof-fixture.js";

let prepared: PreparedRecallRequest;

beforeAll(async () => {
  prepared = await preparedAuthority();
});

afterAll(() => cleanup(prepared));

describe("conservative abstract domain parsing", () => {
  it("rejects unknown coordinate fields instead of trusting decision_changing", () => {
    const planted = {
      ...membershipCoordinate(["absent", "present"]),
      decision_changing: false
    } as unknown as AbstractCoordinate;
    const testCase = createKernelCase(authorityFrom(prepared), {
      coordinates: [planted]
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "UNSUPPORTED",
      reason: expect.stringMatching(/unknown or missing fields/u)
    });
  });

  it("returns OPEN for unresolved semantic feasibility", () => {
    const coordinate = feasibilityCoordinate(["feasible", "unresolved"]);
    const testCase = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate]
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "OPEN",
      requested_refinements: [expect.objectContaining({
        sensitivity_id: coordinate.sensitivity_id
      })]
    });
  });

  it.each([
    ["unknown correlation", {
      coordinate_id: "correlation", sensitivity_id: "sensitivity:correlation",
      owner_id: "owner:correlation", kind: "correlation" as const,
      possible_relations: ["same_group", "unknown"] as const
    }],
    ["overlapping extremum", {
      coordinate_id: "extremum", sensitivity_id: "sensitivity:extremum",
      owner_id: "owner:extremum", kind: "numeric_interval" as const,
      role: "extremum" as const, lower: 1, upper: 2,
      overlaps_decision_boundary: true
    }]
  ])("keeps %s OPEN", (_name, coordinate) => {
    const result = evaluateAbstractProofKernel(createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate],
      operator: singletonOperator([coordinate.sensitivity_id])
    }).input);

    expect(result).toMatchObject({
      status: "OPEN",
      requested_refinements: [expect.objectContaining({
        coordinate_id: coordinate.coordinate_id,
        sensitivity_id: coordinate.sensitivity_id,
        domain_kind: coordinate.kind
      })]
    });
  });

  it("returns CONFLICT for a four-valued both proposition", () => {
    const coordinate: AbstractCoordinate = {
      coordinate_id: "proposition",
      sensitivity_id: "sensitivity:proposition",
      owner_id: "owner:proposition",
      kind: "four_valued_proposition",
      possible_values: ["both"]
    };
    const testCase = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate]
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "CONFLICT",
      conflict_coordinate_ids: ["proposition"]
    });
  });

  it("fails UNSUPPORTED on malformed operator output and unknown fields", () => {
    const coordinate = membershipCoordinate(["present"]);
    const testCase = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate],
      operator: Object.freeze({
        operator_id: "fixture_malformed_abstract_v1",
        evaluate: () => ({
          status: "outcomes" as const,
          handled_sensitivity_ids: [coordinate.sensitivity_id],
          outcomes: [trace(["candidate-a"])],
          extra: true
        })
      })
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "UNSUPPORTED",
      reason: expect.stringMatching(/unknown or missing fields/u)
    });
  });

  it("rejects an unknown field planted on the abstract operator itself", () => {
    const valid = singletonOperator([]);
    const testCase = createKernelCase(authorityFrom(prepared), {
      operator: Object.freeze({ ...valid, planted_unknown_field: true }) as never
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "UNSUPPORTED",
      reason: expect.stringMatching(/abstract operator.*unknown or missing fields/u)
    });
  });

  it("detects a nondeterministic abstract operator", () => {
    let call = 0;
    const testCase = createKernelCase(authorityFrom(prepared), {
      operator: Object.freeze({
        operator_id: "fixture_nondeterministic_abstract_v1",
        evaluate: () => ({
          status: "outcomes" as const,
          handled_sensitivity_ids: [],
          outcomes: [trace(call++ % 2 === 0 ? ["candidate-a"] : [])]
        })
      })
    });

    expect(evaluateAbstractProofKernel(testCase.input)).toMatchObject({
      status: "UNSUPPORTED",
      reason: "abstract operator is not deterministic"
    });
  });

  it("does not let an open membership tail become a proof without a certificate", () => {
    const coordinate = membershipCoordinate(["absent", "present"]);
    const testCase = createKernelCase(authorityFrom(prepared), {
      coordinates: [coordinate],
      operator: singletonOperator([coordinate.sensitivity_id])
    });

    expect(evaluateAbstractProofKernel(testCase.input).status).toBe("OPEN");
  });

  it.each([
    "open_ann_without_sound_bound",
    "open_graph_without_sound_bound",
    "osf_unavailable",
    "osf_truncated_without_legal_frontier"
  ])("keeps %s OPEN as an unauthenticated channel closure", (reason) => {
    const live = deriveLiveClosureAuthorityBinding(authorityFrom(prepared));
    const closure = createChannelClosureResult({
      scope: {
        ...live,
        observer_id: `observer:${reason}`,
        channel_id: `channel:${reason}`,
        domain_id: `domain:${reason}`,
        universe_digest: `sha256:${"7".repeat(64)}`
      },
      status: "uncertified",
      reason
    });
    const result = evaluateAbstractProofKernel(createKernelCase(authorityFrom(prepared), {
      closures: [closure]
    }).input);

    expect(result).toMatchObject({
      status: "OPEN",
      reason: "unresolved or invalid channel closure"
    });
  });

  it.each(decisionOpenCoordinates())(
    "requests deterministic typed refinement for $kind",
    (coordinate) => {
      const testCase = createKernelCase(authorityFrom(prepared), {
        coordinates: [coordinate],
        operator: singletonOperator([coordinate.sensitivity_id])
      });
      const first = evaluateAbstractProofKernel(testCase.input);
      const replay = evaluateAbstractProofKernel(testCase.input);

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        status: "OPEN",
        requested_refinements: [expect.objectContaining({
          coordinate_id: coordinate.coordinate_id,
          sensitivity_id: coordinate.sensitivity_id,
          owner_id: coordinate.owner_id,
          domain_kind: coordinate.kind
        })]
      });
    }
  );

  it("returns UNSUPPORTED for every declared limit overflow", () => {
    const coordinate = membershipCoordinate(["present"]);
    const two = [coordinate, membershipCoordinate(["present"], "second",
      "sensitivity:second")];
    const closure = createChannelClosureResult({
      scope: {
        ...deriveLiveClosureAuthorityBinding(authorityFrom(prepared)),
        observer_id: "observer:limit",
        channel_id: "channel:limit",
        domain_id: "domain:limit",
        universe_digest: `sha256:${"6".repeat(64)}`
      },
      status: "uncertified",
      reason: "limit-fixture"
    });
    const cases = [
      createKernelCase(authorityFrom(prepared), {
        coordinates: two,
        limits: { max_channels: 8, max_coordinates: 1, max_sensitivities: 8 }
      }),
      createKernelCase(authorityFrom(prepared), {
        coordinates: two,
        limits: { max_channels: 8, max_coordinates: 8, max_sensitivities: 1 }
      }),
      createKernelCase(authorityFrom(prepared), {
        closures: [closure, closure],
        limits: { max_channels: 1, max_coordinates: 8, max_sensitivities: 8 }
      })
    ];

    expect(cases.map(({ input }) => evaluateAbstractProofKernel(input).status))
      .toEqual(["UNSUPPORTED", "UNSUPPORTED", "UNSUPPORTED"]);
  });
});

function decisionOpenCoordinates(): readonly AbstractCoordinate[] {
  return Object.freeze([
    membershipCoordinate(["absent", "present"]),
    {
      coordinate_id: "numeric", sensitivity_id: "sensitivity:numeric",
      owner_id: "owner:numeric", kind: "numeric_interval",
      role: "proposition_bound", lower: 0, upper: 1,
      overlaps_decision_boundary: false
    },
    {
      coordinate_id: "finite", sensitivity_id: "sensitivity:finite",
      owner_id: "owner:finite", kind: "finite_values", possible_values: ["a", "b"]
    },
    {
      coordinate_id: "binding", sensitivity_id: "sensitivity:binding",
      owner_id: "owner:binding", kind: "binding", possible_bindings: ["a", "b"]
    },
    {
      coordinate_id: "temporal", sensitivity_id: "sensitivity:temporal",
      owner_id: "owner:temporal", kind: "temporal_interval",
      minimum_epoch_ms: 0, maximum_epoch_ms: 1
    },
    {
      coordinate_id: "proposition", sensitivity_id: "sensitivity:proposition",
      owner_id: "owner:proposition", kind: "four_valued_proposition",
      possible_values: ["supported_only", "refuted_only"]
    },
    {
      coordinate_id: "correlation", sensitivity_id: "sensitivity:correlation",
      owner_id: "owner:correlation", kind: "correlation",
      possible_relations: ["same_group", "different_group"]
    },
    {
      coordinate_id: "feasibility", sensitivity_id: "sensitivity:feasibility",
      owner_id: "owner:feasibility", kind: "semantic_feasibility",
      possible_states: ["feasible", "infeasible"]
    },
    {
      coordinate_id: "identity", sensitivity_id: "sensitivity:identity",
      owner_id: "owner:identity", kind: "identity_tie", universe: "finite",
      possible_winner_digests: [`sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`]
    }
  ]);
}
