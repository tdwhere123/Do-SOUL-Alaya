import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createCanonicalSelectionReceipt } from "@do-soul/alaya-protocol";
import { LongMemEvalQuestionDiagnosticSchema } from "../../../diagnostics/schema/diagnostics-schema.js";
import {
  RecallAnswerSupportObservationSchema,
  RecallAnswerShapePlanSchema,
  RecallCandidateAnswerSupportSchema,
  RecallDeepHeadTraceSchema
} from "../../../harness/recall/answer-trace-schema.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  stripReplayCandidatePoolsForGateWrite,
  type LongMemEvalDiagnosticsSidecar
} from "../../../diagnostics/diagnostics.js";
import {
  buildLongMemEvalEvidenceManifest,
  verifyLongMemEvalEvidenceManifest
} from "../../../runs/provenance/evidence-manifest.js";
import { collectPairedEnvironment } from "../../../runs/provenance/run.js";
import { completeAnswerFeatures, diagnostic } from "./evidence-contract-test-support.js";
import { canonicalCandidatePoolComplete } from
  "../../../artifacts/candidate-readers/canonical-candidate-row.js";

describe("LongMemEval evidence contract answer features", () => {
  it("accepts a complete canonical selection pool without legacy deep-head evidence", () => {
    const candidateKey = "workspace_local:memory_entry:gold-a";
    const receipt = canonicalReceipt(candidateKey);
    const row = diagnostic({
      id: "q-canonical-capture",
      gold: ["gold-a"],
      recallResult: {
        ranking_authority: "prefix_sk",
        diagnostics: {
          capture_receipt: receipt,
          candidate_pool_count: 1,
          fine_assessment_pruned_candidates: [],
          token_economy: {
            fine_pruned_count: 0,
            fine_evaluated: 1,
            coarse_pool_size: 1
          },
          candidates: [{
            schema_version: 1,
            ranking_authority: "prefix_sk",
            capture_receipt_digest: receipt.receipt_digest,
            legacy_selection: {
              fusion: "not_applicable",
              deep_head: "not_applicable",
              coverage: "not_applicable"
            },
            object_id: "gold-a",
            object_kind: "memory_entry",
            candidate_key: candidateKey,
            origin_plane: "workspace_local",
            created_at: "2026-07-11T00:00:00.000Z",
            dimension: "procedure",
            admission_planes: ["lexical"],
            plane_first_admitted: "lexical",
            plane_winning_admission: "lexical",
            admission_attempts: [],
            final_rank: 1,
            post_rank: 1,
            in_final_packet: true,
            eviction_reason: null,
            dropped_reason: null,
            within_budget: true,
            source_channels: ["local_lexical"],
            capture_disposition: receipt.dispositions[0]
          }]
        }
      }
    });

    expect(row.ranking_authority).toBe("prefix_sk");
    expect(row.candidate_pool_complete).toBe(true);
    expect(row.candidates[0]?.answer_features).toBeNull();
    expect(row.candidates[0]?.deep_head_trace).toBeNull();
  });

  it("roundtrips exact query and candidate answer evidence only with full pools", () => {
    const answerSupport = {
      schema_version: 1,
      shape: "place",
      status: "compatible",
      eligible: true,
      value_supported: true,
      target_supported: true,
      relation_supported: true,
      matched_target_terms: ["alice"],
      matched_relation_terms: ["work"],
      authority: {
        schema_version: 1,
        provenance_status: "verified_user_assertion",
        subject_status: "bound",
        target_status: "bound",
        relation_status: "bound",
        event_status: "asserted",
        time_status: "not_requested",
        binding_status: "unique",
        behavior_eligible: true,
        evidence_ref: "evidence-alice-work"
      }
    };
    const answerShapePlan = {
      schema_version: 1,
      status: "high_confidence",
      shape: "place",
      target_terms: ["alice"],
      relation_terms: ["work"]
    };
    const answerSupportObservation = {
      schema_version: 1,
      source_identity: "evidence_ref:evidence-alice-work",
      support_identity:
        `verified_user_assertion:evidence-alice-work:sha256:${"c".repeat(64)}`,
      evidence_ref: "evidence-alice-work",
      source_role: "user",
      projection_kind: "atomic_assertion",
      provenance_status: "verified_user_assertion",
      query_status: "compatible",
      event_status: "asserted",
      time_status: "not_requested",
      behavior_eligible: true
    };
    const answerFeatures = completeAnswerFeatures({
      answer_support: answerSupport,
      answer_support_observations: [answerSupportObservation]
    });
    const deepHeadTrace = {
      lexical_agreement: 0.9,
      evidence_agreement: 0.5,
      resolved_evidence: 0.9,
      embedding_signal: 0.4,
      fusion_baseline_used: false,
      resolved_score: 0.94,
      score_source: "embedding_evidence"
    };
    const row = diagnostic({
      id: "q-features",
      gold: ["gold-a"],
      recallResult: {
        diagnostics: {
          query_probes: {
            normalized_query: "where does alice work?",
            lexical_terms: ["alice", "work"],
            subject_hints: ["alice"]
          },
          answer_shape_plan: answerShapePlan,
          query_sought_facets: ["occupation_work"],
          candidate_pool_count: 1,
          fine_assessment_pruned_candidates: [],
          token_economy: {
            fine_pruned_count: 0,
            fine_evaluated: 1,
            coarse_pool_size: 1
          },
          candidates: [{
            object_id: "gold-a",
            object_kind: "memory_entry",
            candidate_key: "workspace_local:memory_entry:gold-a",
            origin_plane: "workspace_local",
            created_at: "2026-07-11T00:00:00.000Z",
            facet_overlap: 1,
            selection_order: 4,
            fused_rank: 7,
            rank_after_feature_rerank: 5,
            rank_after_coverage_selector: 4,
            source_planes: ["path_expansion"],
            source_channels: ["path_plasticity"],
            path_suppression_score: 0.25,
            answer_features: answerFeatures,
            deep_head_trace: deepHeadTrace,
            coverage_marginal_gain: 2,
            per_stream_rank: { lexical_fts: 7 },
            fused_rank_contribution_per_stream: { lexical_fts: 0.2 },
            score_factors: { activation: 0.5 }
          }]
        }
      }
    });
    expect(row.query_probes).toEqual({
      normalized_query: "where does alice work?",
      lexical_terms: ["alice", "work"],
      subject_hints: ["alice"]
    });
    expect(row.answer_shape_plan).toEqual(answerShapePlan);
    expect(row.query_sought_facets).toEqual(["occupation_work"]);
    expect(row.candidates[0]).toMatchObject({
      origin_plane: "workspace_local",
      selection_order: 4,
      fused_rank: 7,
      rank_after_feature_rerank: 5,
      rank_after_coverage_selector: 4,
      source_planes: ["path_expansion"],
      source_channels: ["path_plasticity"],
      path_suppression_score: 0.25,
      answer_features: answerFeatures,
      deep_head_trace: deepHeadTrace,
      coverage_marginal_gain: 2
    });
    expect(row.candidates[0]?.answer_features?.evidence_gist_truncated).toBe(true);
    expect(row.candidate_pool_complete).toBe(true);
    expect(row.cohort_ledger?.evidence_status).toBe("complete");
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row)).toMatchObject({
      query_sought_facets: ["occupation_work"],
      answer_shape_plan: answerShapePlan,
      candidates: [{
        answer_features: answerFeatures,
        deep_head_trace: deepHeadTrace,
        coverage_marginal_gain: 2,
        path_suppression_score: 0.25
      }]
    });

    const incomplete = diagnostic({
      id: "q-incomplete-trace",
      gold: ["gold-a"],
      recallResult: {
        diagnostics: {
          query_probes: {
            normalized_query: "where does alice work?",
            lexical_terms: ["alice", "work"],
            subject_hints: ["alice"]
          },
          answer_shape_plan: answerShapePlan,
          candidate_pool_count: 1,
          fine_assessment_pruned_candidates: [],
          token_economy: {
            fine_pruned_count: 0,
            fine_evaluated: 1,
            coarse_pool_size: 1
          },
          candidates: [{
            object_id: "gold-a",
            object_kind: "memory_entry",
            candidate_key: "workspace_local:memory_entry:gold-a",
            origin_plane: "workspace_local",
            created_at: "2026-07-11T00:00:00.000Z",
            facet_overlap: 1,
            answer_features: answerFeatures,
            deep_head_trace: deepHeadTrace,
            per_stream_rank: { lexical_fts: 7 },
            fused_rank_contribution_per_stream: { lexical_fts: 0.2 },
            score_factors: { activation: 0.5 }
          }]
        }
      }
    });
    expect(incomplete.candidate_pool_complete).toBe(false);
    expect(incomplete.cohort_ledger?.evidence_status).toBe("partial");

    const mismatchedAuthority = diagnostic({
      id: "q-mismatched-authority",
      gold: ["gold-a"],
      recallResult: {
        diagnostics: {
          query_probes: {
            normalized_query: "where does alice work?",
            lexical_terms: ["alice", "work"],
            subject_hints: ["alice"]
          },
          answer_shape_plan: answerShapePlan,
          candidate_pool_count: 1,
          fine_assessment_pruned_candidates: [],
          token_economy: {
            fine_pruned_count: 0,
            fine_evaluated: 1,
            coarse_pool_size: 1
          },
          candidates: [{
            object_id: "gold-a",
            object_kind: "memory_entry",
            candidate_key: "workspace_local:memory_entry:gold-a",
            origin_plane: "workspace_local",
            created_at: "2026-07-11T00:00:00.000Z",
            facet_overlap: 1,
            answer_features: completeAnswerFeatures({
              evidence_refs: ["evidence-other"],
              answer_support: answerSupport
            }),
            deep_head_trace: deepHeadTrace,
            coverage_marginal_gain: 0.485,
            per_stream_rank: { lexical_fts: 7 },
            fused_rank_contribution_per_stream: { lexical_fts: 0.2 },
            score_factors: { activation: 0.5 }
          }]
        }
      }
    });
    expect(mismatchedAuthority.candidate_pool_complete).toBe(false);
    expect(mismatchedAuthority.cohort_ledger?.evidence_status).toBe("partial");

    const stripped = stripReplayCandidatePoolsForGateWrite({
      schema_version: 1,
      bench_name: "public",
      split: "longmemeval-s",
      run_at: "2026-07-11T00:00:00.000Z",
      alaya_commit: "d7266aa",
      embedding_provider: "disabled",
      embedding_mode: "disabled",
      provider_state_summary: {
        total: 1,
        provider_returned: 0,
        provider_pending: 0,
        provider_failed: 0,
        provider_not_requested: 1,
        query_embedding_unusable: 0,
        unknown: 0,
        provider_returned_rate: 0,
        provider_pending_rate: 0,
        provider_failed_rate: 0,
        provider_not_requested_rate: 1,
        query_embedding_unusable_rate: 0,
        unknown_rate: 0
      },
      questions: [row]
    } satisfies LongMemEvalDiagnosticsSidecar);
    expect(stripped.questions[0]).toMatchObject({
      candidate_pool_complete: false,
      candidate_pool_count: null,
      fine_pruned_count: null,
      fine_assessment_pruned_candidates: [],
      query_probes: null,
      query_sought_facets: null,
      candidates: [],
      cohort_ledger: { candidate_pool_complete: false, evidence_status: "partial" }
    });
    expect(JSON.stringify(stripped)).not.toMatch(
      /where does alice work|Alice works as an engineer|evidence-alice-work/u
    );
  });

  it("rejects candidate rows mixed across exact selection receipt instances", () => {
    const key = "workspace_local:memory_entry:gold-a";
    const selected = canonicalReceipt(key);
    const ineligible = canonicalIneligibleReceipt(key);
    const selectedRow = canonicalRow(selected, key);
    expect(canonicalCandidatePoolComplete({ receipt: selected, rows: [selectedRow],
      candidateKeys: [key] })).toBe(true);
    expect(canonicalCandidatePoolComplete({ receipt: ineligible, rows: [{
      ...selectedRow, capture_receipt_digest: ineligible.receipt_digest
    }], candidateKeys: [key] })).toBe(false);
    expect(canonicalCandidatePoolComplete({ receipt: selected, rows: [{
      ...selectedRow, final_rank: 2, post_rank: 2
    }], candidateKeys: [key] })).toBe(false);
  });

  it("preserves synthesis null and empty answer features without fabricating projections", () => {
    const answerFeatures = completeAnswerFeatures({
      content: "A concise synthesis.",
      evidence_gist: null,
      evidence_gist_truncated: false,
      domain_tags: [],
      evidence_refs: [],
      facet_tags: [],
      canonical_entities: [],
      projection_schema_version: null,
      event_time_start: null,
      event_time_end: null,
      valid_from: null,
      valid_to: null,
      time_precision: null,
      time_source: null,
      preference_subject: null,
      preference_predicate: null,
      preference_object: null,
      preference_category: null,
      preference_polarity: null
    });
    const row = diagnostic({
      id: "q-synthesis",
      recallResult: { diagnostics: { candidates: [{
        object_id: "synthesis-a",
        object_kind: "synthesis_capsule",
        candidate_key: "workspace_local:synthesis_capsule:synthesis-a",
        origin_plane: "workspace_local",
        answer_features: answerFeatures,
        path_suppression_score: 0
      }] } }
    });
    expect(row.candidates[0]).toMatchObject({
      answer_features: answerFeatures,
      path_suppression_score: 0
    });
  });

  it("keeps nullable defaults while requiring candidate identity primitives", () => {
    const current = diagnostic({ id: "q-old", recallResult: { diagnostics: { candidates: [] } } });
    const { query_sought_facets: _queryFacets, ...oldQuestion } = current as typeof current & {
      readonly query_sought_facets?: unknown;
    };
    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(oldQuestion);
    expect(parsed.query_sought_facets).toBeNull();

    const explicitNull = diagnostic({
      id: "q-explicit-null",
      recallResult: {
        diagnostics: {
          answer_shape_plan: null,
          candidates: []
        }
      }
    });
    expect(explicitNull.recall_diagnostics_present).toBe(true);
    expect(explicitNull.answer_shape_plan).toBeNull();

    const legacyCandidate = {
      object_id: "legacy-a",
      candidate_key: "workspace_local:memory_entry:legacy-a",
      final_rank: null,
      pre_budget_rank: null,
      selection_order: null,
      fused_rank: null,
      fused_score: null,
      per_stream_rank: null,
      fused_rank_contribution_per_stream: null,
      score_factors: {}
    };
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...current,
      candidates: [legacyCandidate]
    })).toThrow();

    const candidate = LongMemEvalQuestionDiagnosticSchema.parse({
      ...current,
      candidates: [{
        ...legacyCandidate,
        object_kind: "memory_entry",
        origin_plane: "workspace_local"
      }]
    }).candidates[0];
    expect(candidate).toMatchObject({
      answer_features: null,
      deep_head_trace: null,
      coverage_marginal_gain: null,
      path_suppression_score: null,
      answer_relevance_score: null,
      answer_relevance_rank: null
    });
  });

  it("marks malformed nested answer features as incomplete instead of silently accepting them", () => {
    const row = diagnostic({
      id: "q-malformed",
      recallResult: { diagnostics: { candidates: [{
        object_id: "bad-a",
        candidate_key: "bad-a",
        answer_features: { ...completeAnswerFeatures(), canonical_entities: "not-an-array" }
      }] } }
    });
    expect(row.candidates).toEqual([]);
    expect(row.candidate_pool_complete).toBe(false);
  });

  it("rejects malformed decision traces instead of admitting partial replay evidence", () => {
    const row = diagnostic({
      id: "q-malformed-trace",
      recallResult: { diagnostics: { candidates: [{
        object_id: "bad-trace",
        object_kind: "memory_entry",
        candidate_key: "workspace_local:memory_entry:bad-trace",
        origin_plane: "workspace_local",
        deep_head_trace: {
          lexical_agreement: 2,
          evidence_agreement: 0,
          resolved_evidence: 0,
          embedding_signal: null,
          fusion_baseline_used: false,
          resolved_score: null,
          score_source: "inactive"
        }
      }] } }
    });
    expect(row.candidates).toEqual([]);
    expect(row.candidate_pool_complete).toBe(false);
  });

});

function canonicalReceipt(candidateKey: string) {
  return createCanonicalSelectionReceipt({
    schema_version: 1 as const,
    ranking_authority: "prefix_sk" as const,
    identity: {
      algorithm_id: "alaya.recall.shadow.safe-dominance-capture.v1" as const,
      version: "safe-dominance-capture.v1.0.1" as const,
      digest: "384af589ca9be6791147016463a44519aa9405a70d694cf38a1db9b8991913cd" as const
    },
    execution: { status: "captured" as const, reason: null },
    field_membership: {
      e0_keys: [],
      e1_keys: [candidateKey],
      eligible_keys: [candidateKey]
    },
    observations_by_candidate_key: { [candidateKey]: { h_gate: "none", lineages: {} } },
    frontiers: { schema_version: 1, operator_id: "shadow.frontiers.peel_undominated.v1",
      layers: [{ index: 1, member_keys: [candidateKey] }] },
    gamma: {
      set_utilities: [{ schema_version: 1, candidate_key: candidateKey,
        object_key: "object:gold-a", obligations: [], matches: [],
        values: { status: "unavailable", values: [] }, cid: { status: "unavailable" },
        availability: { facility: "not_applicable", values: "unavailable",
          evidence_identity: "unavailable" } }],
      decisions: [{ schema_version: 1, candidate_key: candidateKey,
        capture_reason: "core_undominated", G: { unscaled_remainder: 0, Values_v: 0,
          evidence_novelty_redundancy: 0 }, G_status: { facility: "not_applicable",
          values: "unavailable", evidence_identity: "unavailable" },
        named_novelty: { facility_keys: [], value_pairs: [], content_ids: [] },
        novelty_core_known_absence: [], max_g_cohort: [candidateKey],
        equal_g_dominance_rejects: [], deterministic_tail: "origin_plane_object_id_code_unit_ascending",
        unresolved_pointwise_tradeoff: false, h_gate: "none", walk_reject: "none",
        static_frontier_index: 1 }],
      rejects: []
    },
    dispositions: [{ candidate_key: candidateKey, status: "selected",
      reason: "selected_by_gamma" }],
    delivery: [{ candidate_key: candidateKey, delivery_rank: 1 }]
  }, (preimage) => createHash("sha256").update(preimage, "utf8").digest("hex"));
}

function canonicalIneligibleReceipt(candidateKey: string) {
  const selected = canonicalReceipt(candidateKey);
  const { receipt_digest: _receiptDigest, ...body } = selected;
  return createCanonicalSelectionReceipt({
    ...body,
    field_membership: { ...selected.field_membership, eligible_keys: [] },
    frontiers: { ...selected.frontiers!, layers: [] },
    gamma: { ...selected.gamma, decisions: [] },
    dispositions: [{ candidate_key: candidateKey, status: "ineligible",
      reason: "h_ineligible" }],
    delivery: []
  }, (preimage) => createHash("sha256").update(preimage, "utf8").digest("hex"));
}

function canonicalRow(receipt: ReturnType<typeof canonicalReceipt>, candidateKey: string) {
  return {
    schema_version: 1 as const, ranking_authority: "prefix_sk" as const,
    capture_receipt_digest: receipt.receipt_digest,
    legacy_selection: { fusion: "not_applicable" as const, deep_head: "not_applicable" as const,
      coverage: "not_applicable" as const },
    object_id: "gold-a", object_kind: "memory_entry" as const, candidate_key: candidateKey,
    origin_plane: "workspace_local" as const, created_at: "2026-07-11T00:00:00.000Z",
    dimension: "procedure", admission_planes: ["lexical"], plane_first_admitted: "lexical",
    plane_winning_admission: "lexical", admission_attempts: [], final_rank: 1, post_rank: 1,
    in_final_packet: true, eviction_reason: null, dropped_reason: null, within_budget: true,
    source_channels: ["local_lexical"], capture_disposition: receipt.dispositions[0]!
  };
}
