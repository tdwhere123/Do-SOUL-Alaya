import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { buildRecallCandidateDedupeKey } from
  "../../../../recall/runtime/recall-service-helpers.js";
import {
  buildCaptureProofDiagnostics,
  type CaptureProofDiagnostics
} from "../../../../recall/runtime/diagnostics/capture-proof-diagnostics.js";
import { absentLexicalBoundProof } from
  "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { buildRecallDiagnostics } from "../../../../recall/runtime/diagnostics.js";
import { unavailableProducerDigest } from
  "../../../../recall/runtime/snapshot-coherence/index.js";

const emptyQueryProbes = Object.freeze({
  normalized_query: "where did alice live",
  object_ids: [],
  subject_hints: [],
  evidence_refs: [],
  run_ids: [],
  surface_ids: [],
  file_paths: [],
  command_names: [],
  package_names: [],
  task_refs: [],
  dimensions: [],
  scope_classes: [],
  domain_tags: [],
  lexical_terms: ["alice", "live"],
  expanded_terms: [],
  phrases: [],
  char_ngrams: [],
  date_terms: []
});

describe("capture proof diagnostics adapter", () => {
  it("keys nonempty field candidates even when prepared candidates are absent", () => {
    const memory = {
      entry: { object_id: "mem-1", evidence_refs: ["ev-1"] }
    };
    const capsule = {
      entry: { object_id: "ev-cap", evidence_refs: ["ev-linked"] },
      objectKind: "evidence_capsule" as const
    };
    const diagnostics = buildCaptureProofDiagnostics(
      preparedWithoutBaseSnapshot(),
      { supplementaryData: {} },
      [memory, capsule]
    );
    const memoryKey = buildRecallCandidateDedupeKey(memory);
    const capsuleKey = buildRecallCandidateDedupeKey(capsule);
    expect(Object.keys(diagnostics.candidate_proposition_provenance).sort()).toEqual(
      [capsuleKey, memoryKey].sort()
    );
    expect(diagnostics.lexical_bound_proofs).toHaveLength(1);
    expect(diagnostics.lexical_bound_proofs[0]?.status).toBe("proof_absent");
    expect(diagnostics.lexical_bound_proofs[0]?.field_prefix).toEqual({
      status: "unavailable",
      reason: "field_prefix_not_sealed"
    });
    expect(diagnostics.lexical_bound_proofs[0]?.candidate_key_domain).toEqual({
      status: "unavailable",
      reason: "candidate_key_domain_not_sealed"
    });
    expect(diagnostics.candidate_proposition_provenance[memoryKey]?.evidence_links).toEqual({
      status: "available",
      value: ["ev-1"]
    });
    expect(diagnostics.candidate_proposition_provenance[capsuleKey]?.evidence_links).toEqual({
      status: "available",
      value: ["ev-linked", "ev-cap"]
    });
    expect(diagnostics.candidate_proposition_provenance[memoryKey]?.typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_receipt_absent"
    });
    expect(diagnostics.candidate_proposition_provenance[memoryKey]?.polarity).toEqual({
      status: "unavailable",
      reason: "polarity_receipt_absent"
    });
    expect(diagnostics.candidate_proposition_provenance[memoryKey]?.relation_validity)
      .toEqual({ status: "unavailable", reason: "relation_validity_receipt_absent" });
    expect(diagnostics.candidate_proposition_provenance[memoryKey]?.supersession)
      .toEqual({ status: "unavailable", reason: "supersession_receipt_absent" });
    expect(diagnostics.candidate_proposition_provenance[memoryKey]?.contradiction)
      .toEqual({ status: "unavailable", reason: "contradiction_receipt_absent" });
  });

  it("emits an empty provenance map only for an empty field", () => {
    const empty = buildCaptureProofDiagnostics(
      preparedWithoutBaseSnapshot(),
      { supplementaryData: {} },
      []
    );
    expect(empty.candidate_proposition_provenance).toEqual({});
    expect(empty.lexical_bound_proofs).toHaveLength(1);
    expect(empty.lexical_bound_proofs[0]?.status).toBe("proof_absent");
    const nonempty = buildCaptureProofDiagnostics(
      preparedWithoutBaseSnapshot(),
      { supplementaryData: {} },
      [{ entry: { object_id: "mem-1", evidence_refs: [] } }]
    );
    expect(Object.keys(nonempty.candidate_proposition_provenance)).toEqual([
      "workspace_local:memory_entry:mem-1"
    ]);
  });

  it("rejects duplicate field keys", () => {
    const candidate = { entry: { object_id: "mem-1", evidence_refs: [] } };
    expect(() => buildCaptureProofDiagnostics(
      preparedWithoutBaseSnapshot(),
      { supplementaryData: {} },
      [candidate, candidate]
    )).toThrow(/duplicate recall candidate field key/);
  });

  it("copies query OSF/composition receipts without certifying unattributed rows", () => {
    const field = [{ entry: { object_id: "mem-1", evidence_refs: ["ev-other"] } }];
    const diagnostics = buildCaptureProofDiagnostics(
      preparedWithoutBaseSnapshot(),
      {
        supplementaryData: {
          queryOpenSemanticFactorFormation: {
            status: "formed",
            producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
          },
          queryOpenSemanticFactorCompletenessReceipt: {
            query_producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
          },
          openSemanticFactorComposition: {
            status: "composed",
            truncated: false,
            bindings: [{
              variable_id: "v-city",
              binding_identity: "osf-binding:alice-lives-paris",
              semantic_identity: "city:paris",
              evidence_id: "ev-gold",
              query_proposition_id: "q-alice-lives",
              evidence_proposition_id: "e-alice-lives"
            }]
          }
        }
      },
      field
    );
    const row = diagnostics.candidate_proposition_provenance[
      "workspace_local:memory_entry:mem-1"
    ]!;
    expect(row.osf.status).toBe("unavailable");
    expect(row.osf.reason).toBe("osf_binding_not_attributed");
    expect(row.osf.formation_status).toBe("formed");
    expect(row.osf.completeness_present).toBe(true);
    expect(row.osf.composition_status).toBe("composed");
  });
});

function preparedWithoutBaseSnapshot() {
  return {
    snapshotVector: { base_store_digest: unavailableProducerDigest("base_store") },
    retrievalFieldBundle: {
      memoryLexicalBoundProofs: () => [],
      memoryLexicalBoundProofsForSnapshot: () => {
        throw new Error("unavailable base-store snapshot must not seal a proof");
      }
    }
  };
}

describe("capture proof diagnostic gate", () => {
  it("emits both capture siblings only when candidate evidence is included", () => {
    const captureProofDiagnostics: CaptureProofDiagnostics = Object.freeze({
      lexical_bound_proofs: Object.freeze([absentLexicalBoundProof()]),
      candidate_proposition_provenance: Object.freeze({})
    });
    const params = diagnosticParams(captureProofDiagnostics);
    const emitted = buildRecallDiagnostics(params);
    expect(emitted).toHaveProperty("lexical_bound_proofs");
    expect(emitted).toHaveProperty("candidate_proposition_provenance");
    expect(emitted.lexical_bound_proofs).toHaveLength(1);
    expect(emitted.lexical_bound_proofs?.[0]?.status).toBe("proof_absent");
    expect(emitted.candidate_proposition_provenance).toEqual({});

    const omitted = buildRecallDiagnostics({
      ...params,
      includeCandidateEvidence: false
    });
    expect(omitted).not.toHaveProperty("lexical_bound_proofs");
    expect(omitted).not.toHaveProperty("candidate_proposition_provenance");
  });
});

function diagnosticParams(captureProofDiagnostics: CaptureProofDiagnostics) {
  return {
    queryProbes: emptyQueryProbes,
    captureProofDiagnostics,
    totalScanned: 0,
    candidatePoolCount: 0,
    preBudgetCount: 0,
    deliveredCount: 0,
    embeddingProviderStatus: "provider_not_requested" as const,
    embeddingSupplementStatus: "disabled" as const,
    providerDegradationReason: null,
    answerRerankDiagnostics: {
      status: "not_requested" as const,
      expected_count: 0,
      scored_count: 0,
      failure_class: null
    },
    graphExpansionDiagnostics: {
      graph_expansion_plane_count_per_hop: [0, 0] as const,
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 0,
        recalls: 0,
        supports: 0
      }
    },
    candidates: [],
    fineAssessmentPrunedCandidates: [],
    tokenEconomy: {
      delivered_context_tokens_estimate: 0,
      coarse_pool_size: 0,
      fine_evaluated: 0,
      fine_pruned_count: 0,
      fine_priority_overflow_count: 0,
      fusion_families_with_hits: 0,
      embedding_inference_calls: 0
    }
  };
}
