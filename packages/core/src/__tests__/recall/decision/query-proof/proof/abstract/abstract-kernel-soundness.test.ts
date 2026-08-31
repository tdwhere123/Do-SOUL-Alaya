import { describe, expect, it } from "vitest";

import { digestRecallFieldIdentity } from
  "../../../../../../recall/field/field-identity.js";
import {
  createChannelClosureResult,
  type ChannelClosureResult,
  type ChannelClosureScope
} from "../../../../../../recall/decision/query-proof/closure/index.js";
import {
  evaluateAbstractProofKernel,
  type AbstractDecisionOperator,
  type AbstractProofKernelInput
} from "../../../../../../recall/decision/query-proof/proof/abstract/index.js";

const QUERY = `sha256:${"a".repeat(64)}` as const;
const SNAPSHOT = `sha256:${"b".repeat(64)}` as const;
const PRINCIPAL = `sha256:${"c".repeat(64)}` as const;

describe("abstract proof-kernel soundness boundary", () => {
  it("joins bounded channel effects into the corresponding abstract domain", () => {
    const proof = evaluateAbstractProofKernel(kernelInput({
      closures: [createChannelClosureResult({
        scope: scope("lexical"),
        status: "bounded_open",
        remaining_effects: [{
          effect_id: "binding-tail",
          sensitivity_id: "answer-binding",
          effect: "answer_binding",
          possible_bindings: ["answer-a", "answer-b"]
        }],
        reason: "bounded_binding_tail"
      })],
      coordinates: [{
        coordinate_id: "binding",
        sensitivity_id: "answer-binding",
        owner_id: "lexical",
        decision_changing: true,
        kind: "binding",
        possible_bindings: ["answer-a"]
      }],
      operator: bindingOperator()
    }));

    expect(proof.status).toBe("OPEN");
    if (proof.status !== "OPEN") throw new Error("expected open proof");
    expect(proof.possible_outcomes).toHaveLength(2);
  });

  it("rejects self-digested closure payloads that violate status evidence", () => {
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

    const proof = evaluateAbstractProofKernel(kernelInput({
      closures: [forged],
      operator: singletonOperator()
    }));
    expect(proof.status).toBe("OPEN");
  });

  it("returns UNSUPPORTED when the injected operator throws or emits an invalid trace", () => {
    const throwing: AbstractDecisionOperator = {
      operator_id: "fixture_throwing_abstract_v1",
      evaluate: () => { throw new Error("fixture failure"); }
    };
    const invalidTrace: AbstractDecisionOperator = {
      operator_id: "fixture_invalid_trace_abstract_v1",
      evaluate: () => ({
        status: "outcomes",
        handled_sensitivity_ids: [],
        outcomes: [{
          candidate_prefix: ["candidate-a", "candidate-a"],
          answer_bindings: [],
          pick_reasons: []
        }]
      })
    };

    expect(() => evaluateAbstractProofKernel(kernelInput({ operator: throwing })))
      .not.toThrow();
    expect(evaluateAbstractProofKernel(kernelInput({ operator: throwing })).status)
      .toBe("UNSUPPORTED");
    expect(() => evaluateAbstractProofKernel(kernelInput({ operator: invalidTrace })))
      .not.toThrow();
    expect(evaluateAbstractProofKernel(kernelInput({ operator: invalidTrace })).status)
      .toBe("UNSUPPORTED");
  });

  it("binds the proof digest to closure premises but not their input order", () => {
    const a = notApplicableClosure("channel-a");
    const b = notApplicableClosure("channel-b");
    const onePremise = evaluateAbstractProofKernel(kernelInput({ closures: [a] }));
    const twoForward = evaluateAbstractProofKernel(kernelInput({ closures: [a, b] }));
    const twoReversed = evaluateAbstractProofKernel(kernelInput({ closures: [b, a] }));

    expect(onePremise.proof_digest).not.toBe(twoForward.proof_digest);
    expect(twoForward).toEqual(twoReversed);
  });
});

function kernelInput(
  overrides: Partial<AbstractProofKernelInput>
): AbstractProofKernelInput {
  return {
    query_digest: QUERY,
    snapshot_digest: SNAPSHOT,
    principal_digest: PRINCIPAL,
    k_max: 2,
    closures: [notApplicableClosure("lexical")],
    coordinates: [],
    limits: { max_channels: 8, max_coordinates: 16, max_sensitivities: 16 },
    operator: singletonOperator(),
    ...overrides
  };
}

function scope(channelId: string): ChannelClosureScope {
  return {
    query_digest: QUERY,
    request_digest: `sha256:${"d".repeat(64)}`,
    snapshot_digest: SNAPSHOT,
    principal_digest: PRINCIPAL,
    workspace_id: "workspace-1",
    observer_id: `${channelId}-observer`,
    channel_id: channelId,
    domain_id: "query-answer-domain",
    universe_digest: `sha256:${"e".repeat(64)}`,
    sensitivities: [{
      sensitivity_id: "answer-binding",
      effect: "answer_binding",
      target: "answer"
    }]
  };
}

function notApplicableClosure(channelId: string): ChannelClosureResult {
  return createChannelClosureResult({
    scope: scope(channelId),
    status: "not_applicable",
    reason: "not_applicable_fixture"
  });
}

function bindingOperator(): AbstractDecisionOperator {
  return {
    operator_id: "fixture_binding_abstract_v1",
    evaluate: ({ coordinates }) => {
      const coordinate = coordinates.find(({ sensitivity_id }) =>
        sensitivity_id === "answer-binding");
      const bindings = coordinate?.kind === "binding"
        ? coordinate.possible_bindings
        : [];
      return {
        status: "outcomes",
        handled_sensitivity_ids: ["answer-binding"],
        outcomes: bindings.map((binding) => trace([binding]))
      };
    }
  };
}

function singletonOperator(): AbstractDecisionOperator {
  return {
    operator_id: "fixture_singleton_abstract_v1",
    evaluate: () => ({
      status: "outcomes",
      handled_sensitivity_ids: [],
      outcomes: [trace(["candidate-a"])]
    })
  };
}

function trace(candidatePrefix: readonly string[]) {
  return {
    candidate_prefix: candidatePrefix,
    answer_bindings: [],
    pick_reasons: candidatePrefix.map((candidateKey, position) => ({
      position,
      candidate_key: candidateKey,
      reason_id: "fixture"
    }))
  };
}
