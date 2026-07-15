import { describe, expect, it } from "vitest";
import {
  buildRecallEvalDiagnosticsEvidence,
  RecallEvalDiagnosticsEvidenceSchema,
  RECALL_EVAL_DIAGNOSTICS_FILENAME
} from "../../longmemeval/provenance/recall-eval-diagnostics.js";
import {
  buildLongMemEvalEvidenceManifest,
  verifyLongMemEvalEvidenceManifest
} from "../../longmemeval/evidence-manifest.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../longmemeval/diagnostics-schema.js";
import {
  buildGoldDiagnostic,
  buildQuestionDiagnosticFixture
} from "./gold-diagnostic-fixture.js";

const documentWarmup = {
  status: "ready" as const,
  expected_count: 3,
  ready_count: 3,
  ready_rate: 1,
  pass_count: 1,
  missing_object_ids: [] as string[],
  provider_kind: "local_onnx",
  model_id: "Xenova/test",
  schema_version: 2,
  d2q_input: "content_plus_hq" as const
};
const queryWarmup = {
  status: "ready" as const,
  requested_count: 1,
  ready_count: 1,
  cache_hit_count: 0,
  provider_requested_count: 1,
  missing_count: 0,
  provider_kind: "local_onnx",
  model_id: "Xenova/test",
  schema_version: 2,
  d2q_input: "content_plus_hq" as const
};
const biIdentity = {
  enabled: true as const,
  provider_kind: "local_onnx" as const,
  effective_model_id: "Xenova/test",
  model_artifact_sha256: "a".repeat(64),
  effective_schema_version: 2,
  d2q_input: "content_plus_hq" as const
};

function question(id: string, rerank: "returned" | "not_applicable") {
  return {
    questionId: id,
    diagnostics: {
      ...buildQuestionDiagnosticFixture({
        questionId: id,
        gold: [buildGoldDiagnostic({ object_id: `${id}-gold` })]
      }),
      provider_state: "provider_returned" as const,
      embedding_workspace_scanned_count: 3,
      embedding_workspace_truncated: false,
      embedding_workspace_provider_kind: "local_onnx",
      embedding_workspace_model_id: "Xenova/test",
      embedding_workspace_schema_version: 2,
      answer_rerank_status: rerank,
      answer_rerank_expected_count: rerank === "returned" ? 5 : 0,
      answer_rerank_scored_count: rerank === "returned" ? 5 : 0,
      answer_rerank_failure_class: null
    },
    embeddingWarmup: documentWarmup,
    queryEmbeddingWarmup: queryWarmup
  };
}

describe("recall-eval diagnostics evidence", () => {
  it("persists strict per-question diagnostics and exact readiness/status counts", () => {
    const evidence = buildRecallEvalDiagnosticsEvidence({
      questions: [question("q-1", "returned"), question("q-2", "not_applicable")],
      embeddingSupplement: biIdentity,
      answerRerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: "b".repeat(64)
      }
    });

    expect(RecallEvalDiagnosticsEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(evidence.summary).toMatchObject({
      question_count: 2,
      document_embedding_cache: { expected_count: 6, ready_count: 6 },
      query_embedding_cache: { requested_count: 2, ready_count: 2 },
      provider_states: { provider_returned: 2, total: 2 },
      answer_rerank_status_counts: { returned: 1, not_applicable: 1 },
      answer_rerank_scores: { expected_count: 5, scored_count: 5 },
      embedding_identity: {
        provider_kind: "local_onnx",
        model_id: "Xenova/test",
        schema_version: 2,
        consistent: true
      }
    });
    expect(evidence.questions[0]).toHaveProperty("diagnostics.question_id", "q-1");
  });

  it("rejects a cross-encoder arm that never scores an applicable candidate", () => {
    expect(() => buildRecallEvalDiagnosticsEvidence({
      questions: [question("q-not-applicable", "not_applicable")],
      embeddingSupplement: biIdentity,
      answerRerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: "b".repeat(64)
      }
    })).toThrow(/no complete cross-encoder scores/u);
  });

  it.each([
    ["model", { model_id: "Xenova/other" }],
    ["schema", { schema_version: 1 }],
    ["D2Q input", { d2q_input: "raw_content" as const }]
  ])("fails loud when warmup %s disagrees with effective bi provenance", (_label, drift) => {
    expect(() => buildRecallEvalDiagnosticsEvidence({
      questions: [{
        ...question("q-drift", "returned"),
        queryEmbeddingWarmup: { ...queryWarmup, ...drift }
      }],
      embeddingSupplement: biIdentity,
      answerRerank: { enabled: false }
    })).toThrow(/embedding identity drift/u);
  });

  it.each([
    ["provider", { embedding_workspace_provider_kind: "openai" }],
    ["model", { embedding_workspace_model_id: "Xenova/other" }],
    ["schema", { embedding_workspace_schema_version: 1 }],
    ["truncated", { embedding_workspace_truncated: true }]
  ] as const)("rejects per-question workspace %s drift", (_label, drift) => {
    const source = question("q-workspace-drift", "returned");
    expect(() => buildRecallEvalDiagnosticsEvidence({
      questions: [{
        ...source,
        diagnostics: { ...source.diagnostics, ...drift }
      }],
      embeddingSupplement: biIdentity,
      answerRerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: "b".repeat(64)
      }
    })).toThrow(/embedding identity drift/u);
  });

  it("accepts pooled-only bi activation when warmup proves the effective identity", () => {
    const source = question("q-pooled-only", "not_applicable");
    const diagnostics = LongMemEvalQuestionDiagnosticSchema.parse({
      ...source.diagnostics,
      embedding_workspace_scanned_count: undefined,
      embedding_workspace_truncated: undefined,
      embedding_workspace_provider_kind: undefined,
      embedding_workspace_model_id: undefined,
      embedding_workspace_schema_version: undefined,
      answer_rerank_status: "not_requested" as const,
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      candidates: [{
        object_id: "pooled-candidate",
        candidate_key: "memory_entry:pooled-candidate",
        final_rank: 1,
        pre_budget_rank: 1,
        selection_order: 1,
        fused_rank: 1,
        fused_score: 0.5,
        per_stream_rank: null,
        fused_rank_contribution_per_stream: null,
        score_factors: { embedding_similarity: 0.8 }
      }]
    });

    expect(() => buildRecallEvalDiagnosticsEvidence({
      questions: [{ ...source, diagnostics }],
      embeddingSupplement: biIdentity,
      answerRerank: { enabled: false }
    })).not.toThrow();
  });

  it("accepts null query warmup when document warmup proves bi identity (encode-in-timer)", () => {
    const source = question("q-encode-in-timer", "not_applicable");
    expect(() => buildRecallEvalDiagnosticsEvidence({
      questions: [{
        ...source,
        queryEmbeddingWarmup: null,
        diagnostics: {
          ...source.diagnostics,
          answer_rerank_status: "not_requested",
          answer_rerank_expected_count: 0,
          answer_rerank_scored_count: 0
        }
      }],
      embeddingSupplement: biIdentity,
      answerRerank: { enabled: false }
    })).not.toThrow();
  });

  it("rejects D2Q identity that disagrees with the persisted workspace schema", () => {
    expect(() => buildRecallEvalDiagnosticsEvidence({
      questions: [question("q-d2q-drift", "returned")],
      embeddingSupplement: { ...biIdentity, d2q_input: "raw_content" },
      answerRerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: "b".repeat(64)
      }
    })).toThrow(/embedding identity drift/u);
  });

  it("rejects any provider or workspace work in a bi-encoder control arm", () => {
    const source = question("q-disabled-drift", "not_applicable");
    expect(() => buildRecallEvalDiagnosticsEvidence({
      questions: [{
        ...source,
        embeddingWarmup: null,
        queryEmbeddingWarmup: null,
        diagnostics: {
          ...source.diagnostics,
          provider_state: "provider_not_requested"
        }
      }],
      embeddingSupplement: { enabled: false },
      answerRerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: "b".repeat(64)
      }
    })).toThrow(/disabled run produced embedding work/u);
  });

  it("binds the recall-eval diagnostics bytes into a complete evidence bundle", () => {
    const evidence = buildRecallEvalDiagnosticsEvidence({
      questions: [question("q-1", "returned")],
      embeddingSupplement: biIdentity,
      answerRerank: {
        enabled: true,
        provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "Xenova/reranker",
        model_artifact_sha256: "b".repeat(64)
      }
    });
    const diagnostics = `${JSON.stringify(evidence, null, 2)}\n`;
    const artifacts = [
      { role: "kpi" as const, path: "kpi.json", contents: "{}\n" },
      { role: "report" as const, path: "report.md", contents: "# report\n" },
      { role: "rank_identity" as const, path: "recall-eval-rank-identity.json", contents: "{}\n" },
      { role: "run_provenance" as const, path: "longmemeval-run-provenance.json", contents: "{}\n" },
      { role: "recall_eval_diagnostics" as const, path: RECALL_EVAL_DIAGNOSTICS_FILENAME, contents: diagnostics }
    ];
    const manifest = buildLongMemEvalEvidenceManifest({
      profile: "recall_eval",
      run: {
        slug: "recall-eval-test",
        bench_name: "public",
        split: "longmemeval-s",
        run_at: "2026-07-13T00:00:00.000Z",
        alaya_commit: "05d98df",
        dataset_sha256: "c".repeat(64),
        selection_manifest_sha256: null,
        question_id_digest: "d".repeat(64),
        candidate_pool_complete: true,
        provenance_complete: true
      },
      artifacts
    });

    expect(manifest.profile).toBe("recall_eval");
    expect(manifest.evidence_status).toBe("complete");
    expect(manifest.artifacts.find((item) => item.path === RECALL_EVAL_DIAGNOSTICS_FILENAME))
      .toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(verifyLongMemEvalEvidenceManifest(manifest, artifacts)).toEqual({
      valid: true,
      errors: []
    });
  });
});
