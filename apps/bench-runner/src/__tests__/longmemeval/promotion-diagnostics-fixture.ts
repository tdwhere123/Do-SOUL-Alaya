import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLongMemEvalSelectionContractIdentity,
  KpiPayloadSchema,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { assembleRecallEvalKpi } from
  "../../longmemeval/kpi/recall-eval-payload.js";
import type { RecallEvalQuestionResult } from
  "../../longmemeval/lifecycle/recall-eval-contract.js";
import type { RecallEvalRuntimeAttribution } from
  "../../longmemeval/lifecycle/recall-eval-runtime.js";
import {
  buildRecallEvalDiagnosticsEvidence,
  renderRecallEvalDiagnosticsEvidence
} from "../../longmemeval/provenance/recall-eval-diagnostics.js";
import { verifyRecallEvalDiagnostics } from
  "../../longmemeval/promotion/diagnostics-verifier.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../longmemeval/diagnostics-types.js";
import { buildQuestionMeasurementAxes } from
  "../../longmemeval/diagnostics-measurement-axes.js";
import { RecallEvalRankIdentitySchema } from
  "../../longmemeval/promotion/evidence-schema.js";
import type { LongMemEvalSnapshotManifest } from
  "../../longmemeval/snapshot.js";
import { promotionMeasurementDiagnostic, emptyTokenMetrics } from
  "./specialized-answerable-recall-fixture.js";

const roots: string[] = [];

async function cleanupPromotionDiagnosticsFixtureRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
}

interface MutableQuestion {
  diagnostics: {
    is_abstention: boolean;
    miss_classification: string;
    miss_taxonomy: string | null;
    candidate_pool_count: number;
    delivered_results: Array<{ rank: number }>;
    candidates: Array<{
      object_id: string;
      object_kind?: string;
      candidate_key: string;
      final_rank: number | null;
      budget_drop_reason: string | null;
    }>;
    candidate_key_collisions: unknown[];
    gold: Array<{
      final_rank: number | null;
      budget_drop_reason: string | null;
      score_factors: Record<string, unknown> | null;
      miss_taxonomy: string | null;
    }>;
    cohort_ledger: {
      evaluator_gold_identity: {
        status: "present" | "absent" | "ambiguous";
      };
      evaluation_issue_reason: string | null;
      stage_ranks: Array<{
        final_rank: number | null;
        selection_order: number | null;
      }>;
    };
  };
}

async function verifyFixture(
  payload: KpiPayload,
  diagnostics: string,
  rank: ReturnType<typeof RecallEvalRankIdentitySchema.parse>,
  goldByQuestion: ReadonlyMap<string, readonly string[]>,
  measurementByQuestion: ReadonlyMap<string, MeasurementOracle> =
    defaultMeasurementOracles(goldByQuestion)
) {
  const root = await mkdtemp(path.join(tmpdir(), "promotion-diagnostics-"));
  roots.push(root);
  const artifactPath = path.join(root, "diagnostics.json");
  await writeFile(artifactPath, diagnostics, "utf8");
  const handle = await open(artifactPath, "r");
  try {
    return await verifyRecallEvalDiagnostics({
      handle,
      payload,
      rankIdentity: rank,
      treatment: { embedding_supplement: false, answer_rerank: false },
      goldForQuestion: (questionId) => goldByQuestion.get(questionId),
      measurementForQuestion: (questionId) => {
        const oracle = measurementByQuestion.get(questionId);
        return oracle === undefined ? undefined : {
          ...oracle,
          sourceDatesBySession: new Map(oracle.sourceDatesBySession),
          sidecar: new Map(oracle.sidecar.map((entry) => [
            `${entry.objectKind}:${entry.objectId}`,
            entry
          ]))
        };
      },
      observeChunk: () => undefined
    });
  } finally {
    await handle.close();
  }
}

function fixtureEvidence(
  mixedCohort = false,
  degradationReason: "warm_cascade_engaged" | null = null
) {
  const datasetSha = "d".repeat(64);
  const collected = [
    question("q-1", 10, "scorable", degradationReason),
    mixedCohort
      ? question("q-2-abstention", 20, "abstention")
      : question("q-2", 20)
  ];
  const selection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: datasetSha,
    assignments: collected.map((row) => ({
      question_id: row.questionId,
      dataset_cohort: row.diagnostics.cohort_ledger?.dataset_cohort === "abstention"
        ? "abstention" as const
        : "answerable" as const
    }))
  });
  const runtime = runtimeAttribution(datasetSha, selection.selected_id_digest);
  const manifest = {
    question_count: collected.length,
    seed_extraction_path: {
      path: "official_api_compile",
      extraction_attempts: 2,
      cache_hits: 2,
      llm_calls: 0,
      offline_fallbacks: 0,
      live_extraction_failures: 0,
      cached_extraction_failures: 0,
      facts_produced: 2,
      signals_dropped: 0,
      parse_dropped: 0,
      compile_overflow_dropped: 0,
      signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
    },
    run_provenance: { selection }
  } as unknown as LongMemEvalSnapshotManifest;
  const payload = KpiPayloadSchema.parse(assembleRecallEvalKpi({
    collected,
    manifest,
    variant: "longmemeval_s",
    runAt: new Date("2026-07-16T00:00:00.000Z"),
    commitSha7: "abcdef0",
    alayaVersion: "0.3.11",
    policyShape: "stress",
    simulateReport: "none",
    sampleSize: collected.length,
    evaluatedCount: collected.length,
    recallWeightOverrides: undefined,
    embeddingProviderLabel: "none",
    runtimeAttribution: runtime,
    datasetSha256: datasetSha,
    provenanceComplete: true
  }));
  const diagnostics = renderRecallEvalDiagnosticsEvidence(
    buildRecallEvalDiagnosticsEvidence({
      questions: collected,
      embeddingSupplement: { enabled: false },
      answerRerank: { enabled: false }
    })
  );
  const rank = RecallEvalRankIdentitySchema.parse({
    schema_version: 2,
    snapshot_binding: {
      expected_question_count: collected.length,
      expected_question_id_digest: selection.selected_id_digest
    },
    replay: {
      question_count: collected.length,
      question_id_digest: selection.selected_id_digest,
      full_snapshot_match: true
    },
    questions: collected.map((row) => ({
      question_id: row.questionId,
      delivered_objects: row.diagnostics.delivered_results.map((result) => ({
        object_id: result.object_id,
        object_kind: result.object_kind ?? "memory_entry"
      }))
    }))
  });
  const goldByQuestion = new Map(collected.map((row) => [
    row.questionId,
    row.diagnostics.gold_memory_ids
  ]));
  const measurementByQuestion = defaultMeasurementOracles(goldByQuestion);
  return { payload, diagnostics, rank, goldByQuestion, measurementByQuestion };
}

function question(
  id: string,
  latencyMs: number,
  status: "scorable" | "abstention" = "scorable",
  degradationReason: "warm_cascade_engaged" | null = null
): RecallEvalQuestionResult {
  const hit = status === "scorable";
  const base = promotionMeasurementDiagnostic(id, status, hit);
  const oracle = measurementOracle(id, base.gold_memory_ids, status === "abstention");
  const axes = buildQuestionMeasurementAxes({
    ...measurementInput(oracle, base),
    evaluatorGoldMemoryIds: oracle.goldMemoryIds,
    evaluatorHitAt5: hit
  });
  const diagnostic = {
    ...base,
    answer_session_ids: oracle.answerSessionIds,
    quality_axes: axes,
    cohort_ledger: { ...base.cohort_ledger!, quality_axes: axes }
  };
  return {
    questionId: id,
    hitAt1: hit,
    hitAt5: hit,
    hitAt10: hit,
    firstTier: "hot",
    latencyMs,
    degradationReason,
    diagnostics: {
      ...diagnostic,
      degradation_reason: degradationReason,
      provider_state: "provider_not_requested",
      answer_rerank_status: "not_requested",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: null
    },
    tokenMetrics: emptyTokenMetrics(),
    recallTokenEconomy: {
      delivered_context_tokens_estimate: 10,
      coarse_pool_size: 5,
      fine_evaluated: 3,
      fine_pruned_count: 2,
      fine_priority_overflow_count: 0,
      fusion_families_with_hits: 1,
      embedding_inference_calls: 0
    },
    edgeProposalKpiRows: [],
    embeddingWarmup: null,
    queryEmbeddingWarmup: null,
    deliveredObjectIds: diagnostic.delivered_results.map((row) => row.object_id)
  };
}

interface MeasurementOracle {
  readonly answer: string;
  readonly answerSessionIds: readonly string[];
  readonly sourceDatesBySession: readonly (readonly [string, string])[];
  readonly sidecar: readonly Readonly<{
    objectId: string;
    objectKind: "memory_entry" | "synthesis_capsule";
    sessionId: string;
    hasAnswer: boolean;
  }>[];
  readonly isAbstention: boolean;
  readonly goldMemoryIds: readonly string[];
}

function defaultMeasurementOracles(
  goldByQuestion: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, MeasurementOracle> {
  return new Map([...goldByQuestion].map(([questionId, gold]) => [
    questionId,
    measurementOracle(questionId, gold, questionId.endsWith("-abstention"))
  ]));
}

function measurementOracle(
  questionId: string,
  goldMemoryIds: readonly string[],
  isAbstention: boolean
): MeasurementOracle {
  const sessionId = `${questionId}-answer-session`;
  return {
    answer: isAbstention ? "" : `Answer ${questionId}`,
    answerSessionIds: isAbstention ? [] : [sessionId],
    sourceDatesBySession: [[sessionId, "2026-07-15T00:00:00.000Z"]],
    sidecar: goldMemoryIds.map((objectId) => ({
      objectId,
      objectKind: "memory_entry" as const,
      sessionId,
      hasAnswer: true
    })),
    isAbstention,
    goldMemoryIds
  };
}

function measurementInput(
  oracle: MeasurementOracle,
  diagnostic: LongMemEvalQuestionDiagnostic
) {
  return {
    answer: oracle.answer,
    answerSessionIds: oracle.answerSessionIds,
    sourceDatesBySession: new Map(oracle.sourceDatesBySession),
    deliveredResults: diagnostic.delivered_results,
    candidates: diagnostic.candidates,
    sidecar: new Map(oracle.sidecar.map((entry) => [
      `${entry.objectKind}:${entry.objectId}`,
      entry
    ])),
    isAbstention: oracle.isAbstention
  };
}

function runtimeAttribution(
  datasetSha: string,
  questionDigest: string
): RecallEvalRuntimeAttribution {
  return {
    status: "attributed",
    gate_eligible: true,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    embedding_mode: "disabled",
    embedding_provider_kind: "local_onnx",
    embedding_provider_label: "none",
    onnx_threads: null,
    onnx_model_artifact_sha256: null,
    embedding_supplement: { enabled: false },
    answer_rerank: { enabled: false },
    recall_config: {
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "e".repeat(64)
    },
    evaluation_slice: {
      offset: 0,
      limit: null,
      evaluated_count: 2,
      question_id_digest: questionDigest
    },
    hydration_binding: { dataset_sha256: datasetSha, source: "external_expected_sha256" },
    snapshot_binding: {
      commit_sha7: "abcdef0",
      gate_sha256: "a".repeat(64),
      worktree_state_sha256: "b".repeat(64),
      extraction_cache_manifest_sha256: "c".repeat(64),
      extraction_cache_requested_turns: 2,
      extraction_cache_cached_turns: 2,
      extraction_cache_coverage: 1,
      dataset_sha256: datasetSha,
      question_id_digest: questionDigest,
      snapshot_manifest_sha256: "f".repeat(64),
      producer_recall_pipeline_version: "recall-eval-v1",
      consumer_recall_pipeline_version: "recall-eval-v1",
      producer_schema_migration_version: 1
    }
  };
}

export {
  cleanupPromotionDiagnosticsFixtureRoots,
  fixtureEvidence,
  verifyFixture
};
export type { MeasurementOracle, MutableQuestion };
