import { describe, expect, it } from "vitest";

import { digestRecallFieldIdentity } from
  "../../../../../../recall/field/field-identity.js";
import type { ChannelClosureResult } from
  "../../../../../../recall/decision/query-proof/closure/contract.js";
import { evaluateAbstractProofKernel } from
  "../../../../../../recall/decision/query-proof/proof/abstract/kernel.js";
import type {
  AbstractCoordinate,
  AbstractDecisionOperator
} from "../../../../../../recall/decision/query-proof/proof/abstract/contract.js";
import {
  boundedClosure,
  createKernelCase,
  notApplicableClosure,
  singletonOperator,
  trace
} from "./proof-fixture.js";

describe("abstract proof-kernel soundness boundary", () => {
  it("joins bounded channel effects into the matching abstract domain", () => {
    const coordinate: AbstractCoordinate = {
      coordinate_id: "binding",
      sensitivity_id: "answer-binding",
      owner_id: "lexical",
      kind: "binding",
      possible_bindings: ["answer-a"]
    };
    const operator: AbstractDecisionOperator = Object.freeze({
      operator_id: "fixture_binding_abstract_v1",
      evaluate: ({ coordinates }) => {
        const binding = coordinates.find(({ sensitivity_id }) =>
          sensitivity_id === "answer-binding");
        const values = binding?.kind === "binding" ? binding.possible_bindings : [];
        return Object.freeze({
          status: "outcomes" as const,
          handled_sensitivity_ids: ["answer-binding"],
          outcomes: values.map((value) => trace([value]))
        });
      }
    });
    const closure = boundedClosure("lexical", {
      effect_id: "binding-tail",
      sensitivity_id: "answer-binding",
      effect: "answer_binding",
      possible_bindings: ["answer-a", "answer-b"]
    });
    const proof = evaluateAbstractProofKernel(createKernelCase({
      closures: [closure], coordinates: [coordinate], operator
    }).input);
    expect(proof.status).toBe("OPEN");
    if (proof.status === "OPEN") expect(proof.possible_outcomes).toHaveLength(2);
  });

  it("rejects a self-digested but non-issued closure payload", () => {
    const valid = notApplicableClosure("lexical");
    const { result_digest: _digest, ...validBody } = valid;
    const forgedBody = {
      ...validBody,
      status: "exact_closed" as const,
      completeness_refs: [],
      reason: "forged_exact_without_completeness"
    };
    const forged = {
      ...forgedBody,
      result_digest: digestRecallFieldIdentity(forgedBody)
    } as ChannelClosureResult;
    const proof = evaluateAbstractProofKernel(createKernelCase({
      closures: [forged]
    }).input);
    expect(proof.status).toBe("OPEN");
  });

  it("returns UNSUPPORTED for throwing operators and malformed traces", () => {
    const throwing: AbstractDecisionOperator = Object.freeze({
      operator_id: "fixture_throwing_abstract_v1",
      evaluate: () => { throw new Error("fixture failure"); }
    });
    const invalidTrace: AbstractDecisionOperator = Object.freeze({
      operator_id: "fixture_invalid_trace_abstract_v1",
      evaluate: () => ({
        status: "outcomes", handled_sensitivity_ids: [],
        outcomes: [{
          candidate_prefix: ["candidate-a", "candidate-a"],
          answer_bindings: [], pick_reasons: []
        }]
      })
    });
    expect(evaluateAbstractProofKernel(createKernelCase({
      closures: [], operator: throwing
    }).input).status).toBe("UNSUPPORTED");
    expect(evaluateAbstractProofKernel(createKernelCase({
      closures: [], operator: invalidTrace
    }).input).status).toBe("UNSUPPORTED");
  });

  it("binds proof bytes to closure premises but canonicalizes their order", () => {
    const a = notApplicableClosure("channel-a");
    const b = notApplicableClosure("channel-b");
    const operator = singletonOperator([]);
    const one = evaluateAbstractProofKernel(createKernelCase({
      closures: [a], operator
    }).input);
    const forward = evaluateAbstractProofKernel(createKernelCase({
      closures: [a, b], operator
    }).input);
    const reverse = evaluateAbstractProofKernel(createKernelCase({
      closures: [b, a], operator
    }).input);
    expect(one.proof_digest).not.toBe(forward.proof_digest);
    expect(forward).toEqual(reverse);
  });

  it("rejects unknown coordinate fields and enum variants", () => {
    const valid: AbstractCoordinate = {
      coordinate_id: "membership", sensitivity_id: "membership",
      owner_id: "test-channel", kind: "membership", possible_states: ["present"]
    };
    const withExtra = { ...valid, hidden: true } as never;
    const badEnum = { ...valid, possible_states: ["maybe"] } as never;
    expect(evaluateAbstractProofKernel(createKernelCase({
      coordinates: [withExtra], operator: singletonOperator(["membership"])
    }).input).status).toBe("UNSUPPORTED");
    expect(evaluateAbstractProofKernel(createKernelCase({
      coordinates: [badEnum], operator: singletonOperator(["membership"])
    }).input).status).toBe("UNSUPPORTED");
  });
});
