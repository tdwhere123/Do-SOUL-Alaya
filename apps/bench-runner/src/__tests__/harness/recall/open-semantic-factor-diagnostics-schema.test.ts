import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import { OpenSemanticFactorCompatibilityTraceSchema } from
  "../../../harness/recall/semantic-factors/open-semantic-factor-diagnostics-schema.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../../../packages/core/src/recall/field/open-semantic-factors/compatibility-trace.js";
import { digestRecallFieldIdentity } from
  "../../../../../../packages/core/src/recall/field/field-identity.js";

describe("open semantic factor diagnostics schema cutover", () => {
  it("accepts the v4 compatibility trace emitted by Core", () => {
    const trace = coreCompatibilityTrace();

    expect(trace.entries[0]?.receipt.operator_id)
      .toBe("open_semantic_factor_compatibility_v4");
    expect(OpenSemanticFactorCompatibilityTraceSchema.parse(trace)).toEqual(trace);
  });

  it("rejects a resealed trace from the prior v3 compatibility operator", () => {
    const legacyTrace = resealAsLegacyV3(coreCompatibilityTrace());

    expect(OpenSemanticFactorCompatibilityTraceSchema.safeParse(legacyTrace).success)
      .toBe(false);
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
  Reflect.set(receipt, "operator_id", "open_semantic_factor_compatibility_v3");
  const { receipt_digest: _receiptDigest, ...receiptBody } = receipt;
  Reflect.set(receipt, "receipt_digest", digestRecallFieldIdentity(receiptBody));
  const { trace_digest: _traceDigest, ...traceBody } = legacy;
  Reflect.set(legacy, "trace_digest", digestRecallFieldIdentity(traceBody));
  return legacy;
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
