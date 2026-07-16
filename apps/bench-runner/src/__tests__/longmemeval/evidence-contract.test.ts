import { describe, expect, it } from "vitest";
import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  stripReplayCandidatePoolsForGateWrite,
  type LongMemEvalDiagnosticsSidecar
} from "../../longmemeval/diagnostics.js";
import {
  buildLongMemEvalEvidenceManifest,
  verifyLongMemEvalEvidenceManifest
} from "../../longmemeval/evidence-manifest.js";
import { collectPairedEnvironment } from "../../longmemeval/provenance/run.js";

function diagnostic(input: {
  readonly id: string;
  readonly gold?: readonly string[];
  readonly abstention?: boolean;
  readonly recallResult?: unknown;
  readonly seedDropReasons?: { candidate_absent: number; materialization_drop: number };
}) {
  return buildQuestionDiagnostic({
    questionId: input.id,
    goldMemoryIds: input.gold ?? [],
    answerSessionIds: [],
    deliveredResults: [],
    hitAt1: false,
    hitAt5: false,
    hitAt10: false,
    isAbstention: input.abstention,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: input.recallResult ?? null,
    seedDropReasons: input.seedDropReasons
  });
}

function completeAnswerFeatures(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    content: "Alice works as an engineer.",
    evidence_gist: "Alice said she works as an engineer.",
    evidence_gist_truncated: true,
    domain_tags: ["occupation"],
    evidence_refs: ["evidence-private-1"],
    facet_tags: [{ facet: "occupation_work", value: "engineer" }],
    canonical_entities: ["alice", "engineer"],
    projection_schema_version: 1,
    event_time_start: "2026-07-01T00:00:00.000Z",
    event_time_end: "2026-07-01T01:00:00.000Z",
    valid_from: "2026-07-01T00:00:00.000Z",
    valid_to: null,
    time_precision: "day",
    time_source: "session_timestamp",
    preference_subject: "alice",
    preference_predicate: "works_as",
    preference_object: "engineer",
    preference_category: "occupation",
    preference_polarity: "positive",
    ...overrides
  };
}

describe("LongMemEval evidence contract", () => {
  it("adds an explicit reconstructable cohort while old rows still parse", () => {
    const missing = diagnostic({ id: "q-missing" });
    expect(missing.cohort_ledger).toMatchObject({
      dataset_cohort: "answerable",
      extraction_materialization: { status: "unknown", emitted_memory_count: 0 },
      evaluator_gold_identity: { status: "absent", object_ids: [] },
      retrieval_status: "not_applicable",
      evidence_status: "missing",
      evaluation_issue_reason: "missing_diagnostics",
      candidate_pool_complete: false,
      final_verdict: "evaluation_unscorable"
    });

    const oldShape = { ...missing, cohort_ledger: undefined };
    expect(LongMemEvalQuestionDiagnosticSchema.parse(oldShape).question_id).toBe("q-missing");
  });

  it("separates extraction drops and abstentions from ambiguous gold failures", () => {
    const dropped = diagnostic({
      id: "q-drop",
      seedDropReasons: { candidate_absent: 0, materialization_drop: 2 },
      recallResult: { diagnostics: { candidates: [] } }
    });
    expect(dropped.miss_taxonomy).toBe("materialization_drop");
    expect(dropped.cohort_ledger).toMatchObject({
      dataset_cohort: "answerable",
      extraction_materialization: {
        status: "drop",
        emitted_memory_count: 0,
        reason: "materialization_drop"
      },
      evaluator_gold_identity: { status: "absent" },
      evaluation_issue_reason: "extraction_materialization_drop"
    });

    const abstention = diagnostic({ id: "q_abs", abstention: true });
    expect(abstention.miss_taxonomy).toBeNull();
    expect(abstention.cohort_ledger).toMatchObject({
      measurement_status: "abstention_unscorable",
      dataset_cohort: "abstention",
      retrieval_status: "not_applicable",
      evaluation_issue_reason: null,
      final_verdict: "abstention_uncalibrated"
    });
    expect(buildLongMemEvalQualityMetrics([abstention])).toMatchObject({
      measurement_cohort_counts: {
        evaluated: 1,
        non_abstention: 0,
        abstention: 1,
        scorable_answerable: 0,
        unscorable_answerable: 0,
        hit_at_5: 0,
        miss_at_5: 0
      },
      unscorable_reason_distribution: { abstention_uncalibrated: 1 }
    });
  });

  it("hash-binds every declared artifact and rejects drift or incomplete replay evidence", () => {
    const artifacts = [
      { role: "kpi" as const, path: "kpi.json", contents: "{\"r_at_5\":0.8}\n" },
      { role: "cohort_ledger" as const, path: "longmemeval-cohort-ledger.json", contents: "{}\n" }
    ];
    const manifest = buildLongMemEvalEvidenceManifest({
      run: {
        slug: "run-1",
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-07-11T00:00:00.000Z",
        alaya_commit: "d7266aa",
        dataset_sha256: "a".repeat(64),
        selection_manifest_sha256: null,
        question_id_digest: "b".repeat(64),
        candidate_pool_complete: false
      },
      artifacts
    });

    expect(verifyLongMemEvalEvidenceManifest(manifest, artifacts)).toEqual({
      valid: true,
      errors: []
    });
    expect(verifyLongMemEvalEvidenceManifest(manifest, [
      artifacts[0]!,
      { ...artifacts[1]!, contents: "drift\n" }
    ])).toMatchObject({ valid: false });
    expect(manifest.evidence_status).toBe("partial");
    expect(() => buildLongMemEvalEvidenceManifest({
      run: { ...manifest.run, dataset_sha256: "unpinned" },
      artifacts
    })).toThrow(/invalid dataset_sha256/u);
  });

  it("hash-binds binary artifact bytes without UTF-8 coercion", () => {
    const compressed = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80]);
    const artifacts = [{
      role: "full_diagnostics" as const,
      path: "longmemeval-diagnostics.json.gz",
      contents: compressed
    }];
    const manifest = buildLongMemEvalEvidenceManifest({
      run: {
        slug: "run-binary",
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-07-11T00:00:00.000Z",
        alaya_commit: "d7266aa",
        dataset_sha256: "a".repeat(64),
        selection_manifest_sha256: null,
        question_id_digest: "b".repeat(64),
        candidate_pool_complete: true
      },
      artifacts
    });

    expect(manifest.artifacts[0]?.bytes).toBe(compressed.byteLength);
    expect(verifyLongMemEvalEvidenceManifest(manifest, artifacts).valid).toBe(true);
    expect(verifyLongMemEvalEvidenceManifest(manifest, [{
      ...artifacts[0]!,
      contents: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xfe, 0x00, 0x80])
    }])).toMatchObject({
      valid: false,
      errors: [expect.stringMatching(/sha256 mismatch/u)]
    });
  });

  it("accepts a precomputed streaming artifact identity", () => {
    const manifest = buildLongMemEvalEvidenceManifest({
      run: {
        slug: "run-stream",
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-07-11T00:00:00.000Z",
        alaya_commit: "d7266aa",
        dataset_sha256: "a".repeat(64),
        selection_manifest_sha256: null,
        question_id_digest: "b".repeat(64),
        candidate_pool_complete: true,
        provenance_complete: true
      },
      artifacts: [{
        role: "full_diagnostics",
        path: "longmemeval-diagnostics.json.gz",
        identity: { sha256: "c".repeat(64), bytes: 42 }
      }]
    });

    expect(manifest.artifacts[0]).toEqual({
      role: "full_diagnostics",
      path: "longmemeval-diagnostics.json.gz",
      sha256: "c".repeat(64),
      bytes: 42
    });
  });

  it.each(["/tmp/escape.json", "../escape.json", "nested/../../escape.json"])(
    "rejects uncontained evidence artifact reference %s",
    (artifactPath) => {
      expect(() => buildLongMemEvalEvidenceManifest({
        run: {
          slug: "run-safe-path",
          bench_name: "public",
          split: "longmemeval-s",
          run_at: "2026-07-11T00:00:00.000Z",
          alaya_commit: "d7266aa",
          dataset_sha256: "a".repeat(64),
          selection_manifest_sha256: null,
          question_id_digest: "b".repeat(64),
          candidate_pool_complete: false
        },
        artifacts: [{ role: "diagnostics", path: artifactPath, contents: "{}" }]
      })).toThrow(/unsafe evidence artifact path/u);
    }
  );

  it("roundtrips exact query and candidate answer evidence only with full pools", () => {
    const answerFeatures = completeAnswerFeatures();
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
          query_sought_facets: ["occupation_work"],
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
      answer_features: answerFeatures
    });
    expect(row.candidates[0]?.answer_features?.evidence_gist_truncated).toBe(true);
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row)).toMatchObject({
      query_sought_facets: ["occupation_work"],
      candidates: [{ answer_features: answerFeatures, path_suppression_score: 0.25 }]
    });

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
        unknown: 0,
        provider_returned_rate: 0,
        provider_pending_rate: 0,
        provider_failed_rate: 0,
        provider_not_requested_rate: 1,
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
      /where does alice work|Alice works as an engineer|evidence-private-1/u
    );
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

  it("binds effective ranking switches into paired provenance", () => {
    expect(collectPairedEnvironment({
      ALAYA_RECALL_CONF_RHO_PATH: "0.5",
      UNRELATED_SECRET: "not-recorded"
    })).toEqual({
      ALAYA_RECALL_CONF_RHO_PATH: "0.5"
    });
  });
});
