import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import {
  OpenSemanticFactorActivationReceiptSchema,
  OpenSemanticFactorCompatibilityTraceSchema,
  OpenSemanticFactorCompositionReceiptSchema
} from
  "../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../../../packages/core/src/recall/field/open-semantic-factors/activation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../../../packages/core/src/recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../../../packages/core/src/recall/field/open-semantic-factors/composition.js";
import { digestRecallFieldIdentity } from
  "../../../../../../packages/core/src/recall/field/field-identity.js";

describe("open semantic factor diagnostics schema cutover", () => {
  it("accepts the v2 compatibility trace emitted by Core", () => {
    const trace = coreCompatibilityTrace();

    expect(trace.entries[0]?.receipt.operator_id)
      .toBe("open_semantic_factor_compatibility_v5");
    expect(trace.operator_id).toBe("open_semantic_factor_compatibility_trace_v2");
    expect(trace.schema_version).toBe(2);
    expect(OpenSemanticFactorCompatibilityTraceSchema.parse(trace)).toEqual(trace);
  });

  it("archives observed unformed evidence without a compatibility receipt", () => {
    const query = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: "Who graduated with a degree?",
      proposal: proposal("Who graduated with a degree?", queryGraph())
    });
    const incompatible = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "Alice likes tea.",
      proposal: proposal("Alice likes tea.", disjointEvidenceGraph())
    });
    const unavailable = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "I redeemed a $5 coupon on coffee creamer at Target."
    });
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {
        "coupon-source": unavailable,
        "sunday-card": incompatible
      }
    });

    expect(trace.unevaluated_evidence_ids).toEqual(["coupon-source"]);
    expect(trace.unavailable_evidence_ids).toEqual([]);
    expect(trace.entries.map((entry) => entry.evidence_id)).toEqual(["sunday-card"]);
    expect(trace.entries[0]?.receipt.status).toBe("incompatible");
    expect(OpenSemanticFactorCompatibilityTraceSchema.parse(trace)).toEqual(trace);
  });

  it("rejects a compatibility trace still sealed as v1", () => {
    const current = coreCompatibilityTrace();
    const { unevaluated_evidence_ids: _unevaluated, ...legacyBody } = current;
    const legacy = {
      ...legacyBody,
      schema_version: 1 as const,
      operator_id: "open_semantic_factor_compatibility_trace_v1" as const
    };

    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse(legacy).success)
      .toBe(false);
  });

  it("rejects a resealed trace from the prior v3 compatibility operator", () => {
    const legacyTrace = resealAsLegacyV3(coreCompatibilityTrace());

    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse(legacyTrace).success)
      .toBe(false);
  });

  it.each([
    ["omitted remainder id", (trace: ReturnType<typeof coreCompatibilityTrace>) => ({
      ...omitDigest(trace),
      unevaluated_evidence_ids: []
    })],
    ["renamed remainder id", (trace: ReturnType<typeof coreCompatibilityTrace>) => ({
      ...omitDigest(trace),
      unevaluated_evidence_ids: ["renamed-remainder"]
    })],
    ["unsorted remainder ids", (trace: ReturnType<typeof unformedRemainderTrace>) => ({
      ...omitDigest(trace),
      unevaluated_evidence_ids: [...trace.unevaluated_evidence_ids].reverse()
    })],
    ["duplicate remainder id", (trace: ReturnType<typeof unformedRemainderTrace>) => ({
      ...omitDigest(trace),
      unevaluated_evidence_ids: [
        ...trace.unevaluated_evidence_ids,
        ...trace.unevaluated_evidence_ids
      ]
    })],
    ["overlapping evaluated id", (trace: ReturnType<typeof unformedRemainderTrace>) => ({
      ...omitDigest(trace),
      unevaluated_evidence_ids: [
        ...trace.unevaluated_evidence_ids,
        trace.entries[0]!.evidence_id
      ]
    })],
    ["bad remainder count", (trace: ReturnType<typeof coreCompatibilityTrace>) => ({
      ...omitDigest(trace),
      unevaluated_evidence_ids: ["extra-remainder"]
    })]
  ] as const)("rejects a present v2 dump with %s", (_name, mutate) => {
    const mutated = resealTrace(mutate(unformedRemainderTrace()));
    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse(mutated).success)
      .toBe(false);
  });

  it("rejects a present v2 dump whose trace digest does not match the body", () => {
    const current = coreCompatibilityTrace();
    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse({
      ...current,
      trace_digest: digestRecallFieldIdentity({ forged: true })
    }).success).toBe(false);
  });

  it("rejects composition and activation receipts still sealed as v1", () => {
    const { query, trace, composition, activation } = composedChain();
    expect(query.status).toBe("formed");
    expect(OpenSemanticFactorCompositionReceiptSchema.parse(composition)).toEqual(composition);
    expect(OpenSemanticFactorActivationReceiptSchema.parse(activation)).toEqual(activation);

    const { receipt_digest: _compositionDigest, ...compositionBody } = composition;
    expect(OpenSemanticFactorCompositionReceiptSchema.safeParse({
      ...compositionBody,
      schema_version: 1,
      operator_id: "open_semantic_factor_composition_v1"
    }).success).toBe(false);

    const { receipt_digest: _activationDigest, ...activationBody } = activation;
    expect(OpenSemanticFactorActivationReceiptSchema.safeParse({
      ...activationBody,
      schema_version: 1,
      operator_id: "open_semantic_solution_membership_activation_v1"
    }).success).toBe(false);
    expect(trace.schema_version).toBe(2);
  });
});

function coreCompatibilityTrace() {
  const evidenceText = "The user graduated with a degree.";
  const queryText = "Who graduated with a degree?";
  const evidence = materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: evidenceText,
    proposal: proposal(evidenceText, evidenceGraph())
  });
  const query = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: queryText,
    proposal: proposal(queryText, queryGraph())
  });
  return materializeOpenSemanticFactorCompatibilityTrace({
    query_capture: query,
    evidence_formations: { gold: evidence }
  });
}

function resealAsLegacyV3(trace: ReturnType<typeof coreCompatibilityTrace>) {
  const legacy = structuredClone(trace);
  const receipt = legacy.entries[0]!.receipt;
  Reflect.set(receipt, "operator_id", "open_semantic_factor_compatibility_v4");
  const { receipt_digest: _receiptDigest, ...receiptBody } = receipt;
  Reflect.set(receipt, "receipt_digest", digestRecallFieldIdentity(receiptBody));
  const { trace_digest: _traceDigest, ...traceBody } = legacy;
  Reflect.set(legacy, "trace_digest", digestRecallFieldIdentity(traceBody));
  return legacy;
}

function unformedRemainderTrace() {
  const query = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: "Who graduated with a degree?",
    proposal: proposal("Who graduated with a degree?", queryGraph())
  });
  return materializeOpenSemanticFactorCompatibilityTrace({
    query_capture: query,
    evidence_formations: {
      "coupon-source": materializeOpenSemanticFactorFormation({
        source_kind: "evidence",
        source_text: "I redeemed a $5 coupon on coffee creamer at Target."
      }),
      "later-source": materializeOpenSemanticFactorFormation({
        source_kind: "evidence",
        source_text: "I bought groceries on Sunday."
      }),
      "sunday-card": materializeOpenSemanticFactorFormation({
        source_kind: "evidence",
        source_text: "Alice likes tea.",
        proposal: proposal("Alice likes tea.", disjointEvidenceGraph())
      })
    }
  });
}

function composedChain() {
  const query = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: "Who graduated with a degree?",
    proposal: proposal("Who graduated with a degree?", queryGraph())
  });
  const evidence = materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: "The user graduated with a degree.",
    proposal: proposal("The user graduated with a degree.", evidenceGraph())
  });
  const trace = materializeOpenSemanticFactorCompatibilityTrace({
    query_capture: query,
    evidence_formations: { gold: evidence }
  });
  const composition = materializeOpenSemanticFactorComposition({
    trace,
    query_capture: query
  });
  const activation = materializeOpenSemanticFactorActivation({
    composition,
    trace,
    query_capture: query
  });
  return { query, trace, composition, activation };
}

function omitDigest<T extends { readonly trace_digest: string }>(
  trace: T
): Omit<T, "trace_digest"> {
  const { trace_digest: _digest, ...body } = trace;
  return body;
}

function resealTrace(body: Omit<ReturnType<typeof coreCompatibilityTrace>, "trace_digest">) {
  return { ...body, trace_digest: digestRecallFieldIdentity(body) };
}

function evidenceGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("predicate", "graduated", "graduate"),
      factor("user", "user", "user"),
      factor("degree", "degree", "degree")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "graduation",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "user", "factor", "user"),
        argument(1, "degree", "factor", "degree")
      ]
    }]
  };
}

function disjointEvidenceGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("alice", "Alice", "alice"),
      factor("likes", "likes", "like"),
      factor("tea", "tea", "tea")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "likes-tea",
      predicate_factor_id: "likes",
      arguments: [
        argument(0, "agent", "factor", "alice"),
        argument(1, "object", "factor", "tea")
      ]
    }]
  };
}

function queryGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [
      factor("predicate", "graduated", "graduate"),
      factor("degree", "degree", "degree")
    ],
    variables: [{ variable_id: "answer", surface: "Who" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "graduation-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "variable", "answer"),
        argument(1, "obtained", "factor", "degree")
      ]
    }]
  };
}

function proposal(sourceText: string, graph: unknown) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "open-factor-bench-test-v1",
    source_text: sourceText,
    graph
  };
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
