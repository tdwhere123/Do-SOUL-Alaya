import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import {
  materializeOpenSemanticFactorCompatibilityTrace,
  verifyOpenSemanticFactorCompatibilityTrace,
  type OpenSemanticFactorCompatibilityTrace
} from "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import {
  materializeOpenSemanticFactorComposition,
  verifyOpenSemanticFactorComposition
} from "../../../../recall/field/open-semantic-factors/composition.js";
import { classifyOpenSemanticFactorCompositionStatus } from
  "../../../../recall/field/open-semantic-factors/composition-status.js";
import {
  materializeOpenSemanticFactorActivation,
  verifyOpenSemanticFactorActivation
} from "../../../../recall/field/open-semantic-factors/activation.js";

describe("open semantic composition complete incompatible status", () => {
  it("reports no_match for a finished all-incompatible search despite remainder unavailable seal", () => {
    const query = formedQuery();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {
        disjoint: disjointEvidence(),
        remainder: unformedEvidence()
      }
    });

    expect(query.status).toBe("formed");
    expect(trace).toMatchObject({
      truncated: false,
      incomparable_seal: "unavailable",
      evaluated_evidence_count: 1
    });
    expect(trace.entries.map((entry) => entry.receipt.status)).toEqual(["incompatible"]);
    expect(verifyOpenSemanticFactorCompatibilityTrace(trace)).toBe(trace);

    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    });
    expect(composition).toMatchObject({
      status: "no_match",
      schema_version: 2,
      operator_id: "open_semantic_factor_composition_v2",
      solution_count: 0,
      truncated: false
    });
    expect(composition.compatibility_trace_digest).toBe(trace.trace_digest);
  });

  it("keeps an all-unformed remainder unavailable instead of claiming no_match", () => {
    const query = formedQuery();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { remainder: unformedEvidence() }
    });

    expect(trace).toMatchObject({
      truncated: false,
      evaluated_evidence_count: 0,
      incomparable_seal: "unavailable"
    });
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    })).toMatchObject({
      status: "unavailable",
      schema_version: 2,
      operator_id: "open_semantic_factor_composition_v2",
      solution_count: 0,
      truncated: false
    });
  });

  it("keeps a formed query with zero evaluated receipts unavailable", () => {
    const query = formedQuery();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {}
    });

    expect(trace.entries).toEqual([]);
    expect(trace.evaluated_evidence_count).toBe(0);
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    }).status).toBe("unavailable");
  });

  it("keeps a truncated incompatible search unavailable under remainder seal", () => {
    const query = formedQuery();
    const complete = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {
        disjoint: disjointEvidence(),
        remainder: unformedEvidence()
      }
    });
    const truncated = forceTruncated(complete);

    expect(verifyOpenSemanticFactorCompatibilityTrace(truncated)).toBe(truncated);
    expect(truncated.unevaluated_evidence_ids).toEqual(complete.unevaluated_evidence_ids);
    expect(materializeOpenSemanticFactorComposition({
      trace: truncated,
      query_capture: query
    }).status).toBe("unavailable");
  });

  it("reports no_match only for a finished all-incompatible search with seal none", () => {
    const query = formedQuery();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { disjoint: disjointEvidence() }
    });

    expect(trace).toMatchObject({
      truncated: false,
      incomparable_seal: "none",
      evaluated_evidence_count: 1
    });
    expect(trace.entries.map((entry) => entry.receipt.status)).toEqual(["incompatible"]);
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    }).status).toBe("no_match");
  });

  it("does not report no_match for a truncated search with seal none", () => {
    const query = formedQuery();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { disjoint: disjointEvidence() }
    });

    expect(trace.incomparable_seal).toBe("none");
    expect(trace.truncated).toBe(false);
    expect(trace.entries.length).toBeGreaterThan(0);
    expect(classifyOpenSemanticFactorCompositionStatus({
      query, trace, solutionCount: 0, truncated: true
    })).toBe("unavailable");
  });

  it("does not report no_match for a truncated compatibility trace with seal none", () => {
    const query = formedQuery();
    const complete = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: { disjoint: disjointEvidence() }
    });
    const truncated = forceTruncatedSealNone(complete);

    expect(truncated.incomparable_seal).toBe("none");
    expect(truncated.truncated).toBe(true);
    expect(truncated.entries.length).toBeGreaterThan(0);
    expect(verifyOpenSemanticFactorCompatibilityTrace(truncated)).toBe(truncated);
    expect(classifyOpenSemanticFactorCompositionStatus({
      query, trace: truncated, solutionCount: 0, truncated: false
    })).toBe("unavailable");
    expect(materializeOpenSemanticFactorComposition({
      trace: truncated,
      query_capture: query
    }).status).toBe("unavailable");
  });

  it("links composition v2 and activation v2 digests through the live rematerialize chain", () => {
    const query = formedQuery();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {
        disjoint: disjointEvidence(),
        remainder: unformedEvidence()
      }
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

    expect(verifyOpenSemanticFactorComposition({
      receipt: composition, trace, query_capture: query
    })).toBe(composition);
    expect(verifyOpenSemanticFactorActivation({
      activation, composition, trace, query_capture: query
    })).toBe(activation);
    expect(activation).toMatchObject({
      schema_version: 2,
      operator_id: "open_semantic_solution_membership_activation_v2",
      status: "no_match",
      composition_receipt_digest: composition.receipt_digest
    });
  });

  it("rejects a pre-cutover composition v1 receipt instead of rematerializing it", () => {
    const query = formedQuery();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {
        disjoint: disjointEvidence(),
        remainder: unformedEvidence()
      }
    });
    const current = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    });
    const { receipt_digest: _digest, ...body } = current;
    const legacyBody = Object.freeze({
      ...body,
      schema_version: 1 as const,
      operator_id: "open_semantic_factor_composition_v1" as const
    });
    const legacy = Object.freeze({
      ...legacyBody,
      receipt_digest: digestRecallFieldIdentity(legacyBody)
    });

    expect(() => verifyOpenSemanticFactorComposition({
      receipt: legacy as unknown as typeof current,
      trace,
      query_capture: query
    })).toThrow(/composition receipt digest mismatch/u);
  });
});

function forceTruncated(
  trace: OpenSemanticFactorCompatibilityTrace
): OpenSemanticFactorCompatibilityTrace {
  const { trace_digest: _digest, ...body } = trace;
  const nextBody = Object.freeze({
    ...body,
    observed_evidence_count: body.matchable_evidence_count + 2,
    matchable_evidence_count: body.evaluated_evidence_count + 1,
    truncated: true
  });
  return Object.freeze({
    ...nextBody,
    trace_digest: digestRecallFieldIdentity(nextBody)
  });
}

function forceTruncatedSealNone(
  trace: OpenSemanticFactorCompatibilityTrace
): OpenSemanticFactorCompatibilityTrace {
  const { trace_digest: _digest, ...body } = trace;
  const matchable = body.evaluated_evidence_count + 1;
  const nextBody = Object.freeze({
    ...body,
    observed_evidence_count: matchable,
    matchable_evidence_count: matchable,
    truncated: true
  });
  return Object.freeze({
    ...nextBody,
    trace_digest: digestRecallFieldIdentity(nextBody)
  });
}

function formedQuery() {
  return formation("query", "Which books have I bought?", {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("query-actor", "I", "i"),
      factor("query-predicate", "bought", "purchase"),
      factor("query-object", "books", "book")
    ],
    variables: [{ variable_id: "answer", surface: "Which" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "buy-query",
      predicate_factor_id: "query-predicate",
      arguments: [
        argument(0, "agent", "factor", "query-actor"),
        argument(1, "object", "factor", "query-object"),
        argument(2, "duration", "variable", "answer")
      ]
    }]
  });
}

function disjointEvidence() {
  return formation("evidence", "Alice likes tea.", {
    schema_version: 2,
    source_kind: "evidence",
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
  });
}

function unformedEvidence() {
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: "I bought three books."
  });
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  graph: unknown
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-test-producer-v1",
      source_text: sourceText,
      graph
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
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
