import { describe, expect, it } from "vitest";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import {
  materializeOpenSemanticFactorCompatibilityTrace,
  verifyOpenSemanticFactorCompatibilityTrace,
  type OpenSemanticFactorCompatibilityTrace
} from "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../recall/field/open-semantic-factors/activation.js";
import { attributeOpenSemanticFactorActivations } from
  "../../../../recall/field/open-semantic-factors/candidate-attribution.js";
import type { CoarseRecallCandidate } from
  "../../../../recall/runtime/recall-service-types.js";

describe("open semantic compatibility evaluation budget", () => {
  it("evaluates a late matchable row instead of stopping after 64 observed captures", () => {
    const query = queryGraph();
    const matchId = "zzz-match";
    const formations = paddedUnavailableFormations(64, {
      [matchId]: matchingEvidence()
    });

    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: formations
    });
    const compatibleIds = compatibleEvidenceIds(query, formations);

    expect(compatibleIds).toEqual([matchId]);
    expect(trace.observed_evidence_count).toBe(65);
    expect(trace.matchable_evidence_count).toBe(1);
    expect(trace.evaluated_evidence_count).toBe(1);
    expect(trace.truncated).toBe(false);
    expect(trace.incomparable_seal).toBe("unavailable");
    expect(trace.entries.map((entry) => entry.evidence_id)).toEqual([matchId]);
    expect(trace.entries[0]?.receipt.status).toBe("compatible");
    expect(verifyOpenSemanticFactorCompatibilityTrace(trace)).toBe(trace);

    const composition = materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    });
    expect(composition.status).toBe("composed");
    expect(composition.truncated).toBe(false);

    const activation = materializeOpenSemanticFactorActivation({
      composition,
      trace,
      query_capture: query
    });
    expect(activation.truncated).toBe(false);
    expect(attributeOpenSemanticFactorActivations({
      candidates: [memoryCandidate(matchId)],
      activation
    }).size).toBe(1);
  });

  it("keeps the compatible set identical to evaluating every observed capture", () => {
    const query = queryGraph();
    const formations = paddedUnavailableFormations(70, {
      "aaa-early": matchingEvidence(),
      "mmm-disjoint": disjointEvidence(),
      "zzz-late": matchingEvidence()
    });
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: formations
    });

    expect(compatibleTraceIds(trace)).toEqual(compatibleEvidenceIds(query, formations));
    expect(trace.truncated).toBe(false);
    expect(trace.matchable_evidence_count).toBe(trace.evaluated_evidence_count);
    expect(trace.observed_evidence_count).toBeGreaterThan(trace.evaluated_evidence_count);
  });

  it("seals an all-incomparable remainder as unavailable without claiming truncation", () => {
    const query = unboundQueryGraph();
    const formations = paddedUnavailableFormations(80);
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: formations
    });

    expect(trace).toMatchObject({
      observed_evidence_count: 80,
      matchable_evidence_count: 0,
      evaluated_evidence_count: 0,
      truncated: false,
      incomparable_seal: "unavailable"
    });
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    }).status).toBe("unavailable");
  });

  it("names qualified evidence whose semantic formation is unavailable", () => {
    const query = unboundQueryGraph();
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {},
      unavailable_evidence_ids: ["evidence-missing"]
    });

    expect(trace).toMatchObject({
      observed_evidence_count: 1,
      matchable_evidence_count: 0,
      evaluated_evidence_count: 0,
      unavailable_evidence_ids: ["evidence-missing"],
      incomparable_seal: "unavailable",
      truncated: false
    });
    expect(verifyOpenSemanticFactorCompatibilityTrace(trace)).toBe(trace);
    expect(materializeOpenSemanticFactorComposition({
      trace,
      query_capture: query
    }).status).toBe("unavailable");
  });

  it("preserves a rejected query seal when evidence is unavailable", () => {
    const query = Object.freeze({
      ...unboundQueryGraph(),
      status: "rejected" as const
    });
    const trace = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: query,
      evidence_formations: {},
      unavailable_evidence_ids: ["evidence-missing"]
    });

    expect(trace.incomparable_seal).toBe("rejected");
    expect(verifyOpenSemanticFactorCompatibilityTrace(trace)).toBe(trace);
  });

  it("seals formed evidence against an unformed query from the query capture status", () => {
    const evidence = matchingEvidence();
    expect(evidence.status).toBe("formed");
    const queries = [
      materializeOpenSemanticFactorFormation({
        source_kind: "query",
        source_text: "Which books have I bought?"
      }),
      materializeOpenSemanticFactorFormation({
        source_kind: "query",
        source_text: null
      }),
      materializeOpenSemanticFactorFormation({
        source_kind: "query",
        source_text: "Which books have I bought?",
        proposal: { not: "a formation proposal" }
      })
    ];

    for (const query of queries) {
      expect(["ineligible", "unavailable", "rejected"]).toContain(query.status);
      const trace = materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: { "e-formed": evidence }
      });
      expect(trace).toMatchObject({
        observed_evidence_count: 1,
        matchable_evidence_count: 0,
        evaluated_evidence_count: 0,
        truncated: false,
        incomparable_seal: query.status
      });
      expect(verifyOpenSemanticFactorCompatibilityTrace(trace)).toBe(trace);
    }

    const remainder = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: queries[0]!,
      evidence_formations: { "e-formed": evidence }
    });
    expect(() => verifyOpenSemanticFactorCompatibilityTrace(
      retargetSeal(remainder, "none")
    )).toThrow("open semantic factor compatibility trace contract mismatch");

    const complete = materializeOpenSemanticFactorCompatibilityTrace({
      query_capture: queryGraph(),
      evidence_formations: { "e-formed": evidence }
    });
    expect(complete.observed_evidence_count).toBe(complete.matchable_evidence_count);
    expect(() => verifyOpenSemanticFactorCompatibilityTrace(
      retargetSeal(complete, "unavailable")
    )).toThrow("open semantic factor compatibility trace contract mismatch");
  });
});

function retargetSeal(
  trace: OpenSemanticFactorCompatibilityTrace,
  incomparable_seal: OpenSemanticFactorCompatibilityTrace["incomparable_seal"]
): OpenSemanticFactorCompatibilityTrace {
  const { trace_digest: _digest, ...body } = trace;
  const nextBody = Object.freeze({ ...body, incomparable_seal });
  return Object.freeze({
    ...nextBody,
    trace_digest: digestRecallFieldIdentity(nextBody)
  });
}

function compatibleEvidenceIds(
  query: ReturnType<typeof queryGraph>,
  formations: Readonly<Record<string, ReturnType<typeof matchingEvidence>>>
): readonly string[] {
  return Object.entries(formations)
    .filter(([evidenceId]) => evidenceId.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([evidenceId, evidenceCapture]) =>
      materializeOpenSemanticFactorCompatibility({
        evidence_capture: evidenceCapture,
        query_capture: query
      }).status === "compatible"
        ? [evidenceId]
        : []);
}

function compatibleTraceIds(
  trace: ReturnType<typeof materializeOpenSemanticFactorCompatibilityTrace>
): readonly string[] {
  return trace.entries
    .filter((entry) => entry.receipt.status === "compatible")
    .map((entry) => entry.evidence_id);
}

function paddedUnavailableFormations(
  unavailableCount: number,
  extra: Readonly<Record<string, ReturnType<typeof matchingEvidence>>> = {}
): Record<string, ReturnType<typeof matchingEvidence>> {
  const formations: Record<string, ReturnType<typeof matchingEvidence>> = { ...extra };
  for (let index = 0; index < unavailableCount; index += 1) {
    formations[`e-${String(index).padStart(2, "0")}`] = unavailableEvidence();
  }
  return formations;
}

function memoryCandidate(evidenceId: string): CoarseRecallCandidate {
  return Object.freeze({
    entry: createMemoryEntry({
      object_id: "memory-1",
      evidence_refs: [evidenceId]
    }),
    originPlane: "workspace_local"
  });
}

function unboundQueryGraph() {
  return formation("query", "Which books have I bought?", {
    schema_version: 1,
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

function queryGraph() {
  return formation("query", "Which books have I bought?", {
    schema_version: 1,
    source_kind: "query",
    factors: [
      factor("query-actor", "I", "i"),
      factor("query-predicate", "bought", "purchase"),
      factor("query-object", "books", "book")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "buy-query",
      predicate_factor_id: "query-predicate",
      arguments: [
        argument(0, "agent", "factor", "query-actor"),
        argument(1, "object", "factor", "query-object")
      ]
    }]
  });
}

function matchingEvidence() {
  return formation("evidence", "I bought three books.", {
    schema_version: 1,
    source_kind: "evidence",
    factors: [
      factor("actor", "I", "i"),
      factor("predicate", "bought", "buy"),
      factor("object", "books", "book")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "buy-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "agent", "factor", "actor"),
        argument(1, "object", "factor", "object")
      ]
    }]
  });
}

function disjointEvidence() {
  return formation("evidence", "Alice likes tea.", {
    schema_version: 1,
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

function unavailableEvidence() {
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
