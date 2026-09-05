import { createHash } from "node:crypto";
import {
  compareCodeUnits,
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  evidenceFactFrameFormationCapturePreimage,
  type EvidenceFactFrameFormationCaptureBody
} from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  CandidatePropositionProvenanceDiagnosticsSchema,
  LexicalBoundProofDiagnosticsSchema
} from "../../../harness/recall/capture/capture-proof-diagnostics-schema.js";
import { parseBenchRecallDiagnosticsForRun } from
  "../../../harness/recall/recall-diagnostics-schema.js";
import {
  CAPTURE_PROOF_CANDIDATE_KEY as CANDIDATE_KEY,
  CAPTURE_PROOF_IDENTITY as IDENTITY,
  CAPTURE_PROOF_UNIVERSE as UNIVERSE,
  absentProof,
  capturedTruncatedProof,
  provenanceMap,
  sealLexicalProof,
  unavailableOsfRow,
  withNonMonotoneFrontier
} from "./capture-proof-diagnostics-fixture.js";

const FUSION_STREAMS = [
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "evidence_structural_agreement",
  "source_proximity",
  "source_evidence_agreement",
  "subject_alignment",
  "structural",
  "existing_score",
  "embedding_similarity",
  "graph_expansion",
  "entity_seed",
  "path_expansion",
  "temporal_recency",
  "workspace_activation"
] as const;

describe("capture proof diagnostics schema", () => {
  it("parses a captured receipt with a truncated frontier", () => {
    const proof = capturedTruncatedProof();
    expect(LexicalBoundProofDiagnosticsSchema.parse(proof)).toEqual(proof);
    expect(proof.receipt.lanes[0]?.unseen_upper_bound).toBe(0);
    const unordered = withNonMonotoneFrontier(proof);
    expect(LexicalBoundProofDiagnosticsSchema.parse(unordered)).toEqual(unordered);
    expect(unordered.receipt.lanes[0]?.unseen_upper_bound).toEqual({
      status: "unavailable",
      reason: "producer_order_not_monotone"
    });
  });

  it("parses proof_absent with honest unavailable coordinates", () => {
    const proof = absentProof();
    expect(LexicalBoundProofDiagnosticsSchema.parse(proof)).toEqual(proof);
    expect(proof.observed_candidate_keys).toEqual({
      status: "unavailable",
      reason: "proof_absent"
    });
    expect(proof.evaluated_universe).toEqual(UNIVERSE);
  });

  it("parses ineligible, rejected, truncated, and certified OSF provenance", () => {
    const map = provenanceMap();
    expect(CandidatePropositionProvenanceDiagnosticsSchema.parse(map)).toEqual(map);
    expect(map[CANDIDATE_KEY]?.osf.bindings).toMatchObject({
      status: "available",
      value: [{
        query_proposition_id: "q-alice-lives",
        evidence_proposition_id: "e-alice-lives"
      }]
    });
    expect(map["cand-ineligible"]?.osf.composition_status).toBe("ineligible");
    expect(map["cand-rejected"]?.osf.composition_status).toBe("rejected");
    expect(map["cand-truncated"]?.osf.reason).toBe("osf_composition_truncated");
  });

  it("parses a nested available formed receipt and rejects digest tamper, unknown keys, and empty lists", () => {
    const capture = digestCapture({
      schema_version: 1,
      operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
      status: "formed",
      producer_operator_id: "rule_based_evidence_fact_frame_normalizer_v1",
      source_hash: `sha256:${"a".repeat(64)}`,
      fact_frame: {
        schema_version: 1,
        slots: [
          { role: "subject", text: "Alice" },
          { role: "relation", text: "lives" },
          { role: "value", text: "Paris" }
        ]
      }
    });
    const receipt = { capture, evidence_id: "ev-alice" };
    const row = {
      ...unavailableOsfRow(CANDIDATE_KEY, {
        reason: "certified_osf_receipt_absent",
        formation_status: "unavailable",
        composition_status: "unavailable"
      }),
      typed_fact_frames: {
        status: "available" as const,
        value: [receipt]
      }
    };
    expect(CandidatePropositionProvenanceDiagnosticsSchema.parse({
      [CANDIDATE_KEY]: row
    })).toEqual({ [CANDIDATE_KEY]: row });
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: {
        ...row,
        typed_fact_frames: {
          status: "available",
          value: [{
            ...capture,
            evidence_id: "ev-alice"
          }]
        }
      }
    }).success).toBe(false);
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: {
        ...row,
        typed_fact_frames: {
          status: "available",
          value: [{
            capture: { ...capture, capture_digest: `sha256:${"0".repeat(64)}` },
            evidence_id: "ev-alice"
          }]
        }
      }
    }).success).toBe(false);
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: {
        ...row,
        typed_fact_frames: {
          status: "available",
          value: [{ ...receipt, extra: true }]
        }
      }
    }).success).toBe(false);
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: {
        ...row,
        typed_fact_frames: { status: "available", value: [] }
      }
    }).success).toBe(false);
    const unavailableFormation = CandidatePropositionProvenanceDiagnosticsSchema.parse({
      [CANDIDATE_KEY]: {
        ...unavailableOsfRow(CANDIDATE_KEY, {
          reason: "certified_osf_receipt_absent",
          formation_status: "unavailable",
          composition_status: "unavailable"
        }),
        typed_fact_frames: {
          status: "unavailable",
          reason: "typed_fact_frame_formation_unavailable"
        }
      }
    });
    expect(unavailableFormation[CANDIDATE_KEY]?.typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_formation_unavailable"
    });
    for (const reason of [
      "typed_fact_frame_formation_ineligible",
      "typed_fact_frame_formation_rejected"
    ] as const) {
      const parsed = CandidatePropositionProvenanceDiagnosticsSchema.parse({
        [CANDIDATE_KEY]: {
          ...unavailableOsfRow(CANDIDATE_KEY, {
            reason: "certified_osf_receipt_absent",
            formation_status: "unavailable",
            composition_status: "unavailable"
          }),
          typed_fact_frames: { status: "unavailable", reason }
        }
      });
      expect(parsed[CANDIDATE_KEY]?.typed_fact_frames).toEqual({
        status: "unavailable",
        reason
      });
    }
  });

  it("orders non-ASCII observed keys by code units, not locale collation", () => {
    const keys = ["北京", "上海"] as const;
    const codeUnitOrder = [...keys].sort(compareCodeUnits);
    const proof = withLaneKeys(capturedTruncatedProof(), keys, codeUnitOrder);
    expect(LexicalBoundProofDiagnosticsSchema.parse(proof).observed_candidate_keys)
      .toEqual(codeUnitOrder);
    const localeOrder = [...keys].sort((left, right) => left.localeCompare(right, "zh"));
    if (localeOrder.join("\0") !== codeUnitOrder.join("\0")) {
      expect(LexicalBoundProofDiagnosticsSchema.safeParse(
        withLaneKeys(proof as never, keys, localeOrder)
      ).success).toBe(false);
    }
  });

  it("retains both siblings through parseBenchRecallDiagnosticsForRun", () => {
    const lexical_bound_proofs = [capturedTruncatedProof()];
    const candidate_proposition_provenance = provenanceMap();
    const parsed = parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics(),
      lexical_bound_proofs,
      candidate_proposition_provenance
    } as never, {});

    expect(parsed.lexical_bound_proofs).toEqual(lexical_bound_proofs);
    expect(parsed.candidate_proposition_provenance).toEqual(candidate_proposition_provenance);
  });

  it("rejects a numeric truncated frontier when ranking keys are not monotone", () => {
    const proof = capturedTruncatedProof();
    const lane = proof.receipt.lanes[0]!;
    const { proof_digest: _digest, ...body } = {
      ...proof,
      receipt: {
        ...proof.receipt,
        lanes: [{
          ...lane,
          rows: [lane.rows[1]!, lane.rows[0]!],
          unseen_upper_bound: lane.rows[0]!.grouped_ordinal
        }]
      }
    };
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof(body)).success)
      .toBe(false);
  });

  it("rejects a query run id that disagrees with the sealed field prefix", () => {
    const proof = capturedTruncatedProof();
    const { proof_digest: _digest, ...body } = {
      ...proof,
      receipt: {
        ...proof.receipt,
        query_run_id: "memory.keyword.lexical_expanded.depth:1"
      }
    };
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof(body)).success)
      .toBe(false);
  });

  it("rejects an empty lexical_bound_proofs array when the field is present", () => {
    expect(() => parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics(),
      lexical_bound_proofs: []
    }, {})).toThrow();
  });

  it("rejects proof_absent that encodes evaluated universe as an empty array", () => {
    expect(LexicalBoundProofDiagnosticsSchema.safeParse({
      ...absentProof(),
      evaluated_universe: []
    }).success).toBe(false);
  });

  it("rejects identity unavailable encoded as proof_absent", () => {
    const gap = { status: "unavailable", reason: "proof_absent" };
    expect(LexicalBoundProofDiagnosticsSchema.safeParse({
      ...absentProof(),
      identity: {
        request_digest: gap,
        workspace_id: gap,
        snapshot_digest: gap
      }
    }).success).toBe(false);
  });

  it("rejects a provenance record key that does not match candidate_key", () => {
    const row = unavailableOsfRow(CANDIDATE_KEY, {
      reason: "certified_osf_receipt_absent",
      formation_status: "unavailable",
      composition_status: "unavailable"
    });
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      "other-key": row
    }).success).toBe(false);
  });

  it("rejects composition_status truncated and certified OSF with unavailable bindings", () => {
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: unavailableOsfRow(CANDIDATE_KEY, {
        reason: "osf_composition_not_composed",
        formation_status: "formed",
        composition_status: "truncated"
      })
    }).success).toBe(false);
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: {
        ...unavailableOsfRow(CANDIDATE_KEY, {
          reason: "certified_osf_receipt_absent",
          formation_status: "unavailable",
          composition_status: "unavailable"
        }),
        osf: {
          status: "certified",
          reason: null,
          formation_status: "formed",
          completeness_present: true,
          composition_status: "composed",
          producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
          bindings: { status: "unavailable", reason: "osf_binding_not_attributed" }
        }
      }
    }).success).toBe(false);
  });

  it("rejects a forged lexical proof digest and a lane missing unseen_upper_bound", () => {
    expect(LexicalBoundProofDiagnosticsSchema.safeParse({
      ...capturedTruncatedProof(),
      proof_digest: `sha256:${"b".repeat(64)}`
    }).success).toBe(false);
    const proof = capturedTruncatedProof();
    const [lane] = proof.receipt.lanes;
    const { unseen_upper_bound: _dropped, ...withoutFrontier } = lane!;
    const { proof_digest: _digest, ...body } = {
      ...proof,
      receipt: { ...proof.receipt, lanes: [withoutFrontier] }
    };
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof(body)).success)
      .toBe(false);
  });

  it("rejects unavailable OSF with a null reason and available empty arrays", () => {
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: {
        ...unavailableOsfRow(CANDIDATE_KEY, {
          reason: "certified_osf_receipt_absent",
          formation_status: "unavailable",
          composition_status: "unavailable"
        }),
        osf: {
          status: "unavailable",
          reason: null,
          formation_status: "unavailable",
          completeness_present: false,
          composition_status: "unavailable",
          producer_operator_id: null,
          bindings: { status: "unavailable", reason: "certified_osf_receipt_absent" }
        }
      }
    }).success).toBe(false);
    expect(CandidatePropositionProvenanceDiagnosticsSchema.safeParse({
      [CANDIDATE_KEY]: {
        ...unavailableOsfRow(CANDIDATE_KEY, {
          reason: "osf_binding_not_attributed",
          formation_status: "formed",
          composition_status: "composed"
        }),
        osf: {
          status: "unavailable",
          reason: "osf_binding_not_attributed",
          formation_status: "formed",
          completeness_present: true,
          composition_status: "composed",
          producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
          bindings: { status: "available", value: [] }
        }
      }
    }).success).toBe(false);
  });
});

function baseDiagnostics() {
  return {
    query_probes: {
      normalized_query: "question",
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
      lexical_terms: [],
      expanded_terms: [],
      phrases: [],
      char_ngrams: [],
      date_terms: []
    },
    total_scanned: 1,
    candidate_pool_count: 1,
    pre_budget_count: 1,
    delivered_count: 1,
    embedding_provider_status: "provider_not_requested",
    embedding_supplement_status: "disabled",
    provider_degradation_reason: null,
    answer_rerank_status: "not_requested",
    answer_rerank_expected_count: 0,
    answer_rerank_scored_count: 0,
    answer_rerank_failure_class: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    fusion_breakdown: [],
    fine_assessment_pruned_candidates: [],
    candidates: [{
      candidate_key: CANDIDATE_KEY,
      object_id: "memory-1",
      object_kind: "memory_entry",
      origin_plane: "workspace_local",
      admission_planes: ["lexical"],
      plane_first_admitted: "lexical",
      plane_winning_admission: "lexical",
      pre_budget_rank: 1,
      selection_order: 1,
      fused_rank: 1,
      fused_score: 0.4,
      per_stream_rank: Object.fromEntries(FUSION_STREAMS.map((key) => [key, null])),
      fused_rank_contribution_per_stream: Object.fromEntries(
        FUSION_STREAMS.map((key) => [key, 0])
      ),
      final_rank: 1,
      dropped_reason: null,
      within_budget: true,
      relevance_score: 0.93,
      lexical_rank: null,
      structural_score: 0,
      score_factors: {},
      source_channels: ["lexical"],
      path_expansion_sources: []
    }]
  };
}

function withLaneKeys(
  proof: ReturnType<typeof capturedTruncatedProof>,
  keys: readonly string[],
  observed: readonly string[]
) {
  const { proof_digest: _digest, ...body } = proof;
  const lane = body.receipt.lanes[0]!;
  return sealLexicalProof({
    ...body,
    receipt: {
      ...body.receipt,
      lanes: [{
        ...lane,
        rows: lane.rows.map((row, index) => ({
          ...row,
          candidate_key: keys[index] ?? row.candidate_key
        }))
      }]
    },
    observed_candidate_keys: observed
  });
}

function digestCapture(body: Readonly<EvidenceFactFrameFormationCaptureBody>) {
  return {
    ...body,
    capture_digest: `sha256:${createHash("sha256")
      .update(evidenceFactFrameFormationCapturePreimage(body), "utf8")
      .digest("hex")}`
  };
}
