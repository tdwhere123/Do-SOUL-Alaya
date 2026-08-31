import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateAbstractProofKernel } from
  "../../../../../../recall/decision/query-proof/proof/abstract/kernel.js";
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
});
