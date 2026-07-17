import { createHash } from "node:crypto";
import {
  createLongMemEvalSelectionContractIdentity
} from "@do-soul/alaya-eval";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { computeCacheKey } from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  buildExtractionContentClosureIndex,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256
} from "../../../longmemeval/extraction/content-closure.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  EXTRACTION_REQUEST_PROFILES
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type { RecallEvalQuestionResult } from "../../../longmemeval/lifecycle/recall-eval/recall-eval-contract.js";
import type { RecallEvalRuntimeAttribution } from "../../../longmemeval/lifecycle/recall-eval/recall-eval-runtime.js";
import {
  canonicalProductRecallConfig,
  canonicalProductRecallProvenanceConfig
} from "../../../longmemeval/promotion/verifiers/product-policy-verifier.js";
import {
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../../longmemeval/provenance/run.js";
import { buildQuestionMeasurementAxes } from "../../../longmemeval/diagnostics/diagnostics-measurement-axes.js";
import { RECALL_PIPELINE_VERSION } from "../../../shared/version.js";
import {
  promotionGoldId,
  promotionMeasurementDiagnostic,
  emptyTokenMetrics
} from "../recall-eval/specialized-answerable-recall-fixture.js";

const DATASET_SHA = "d".repeat(64);
const GATE_SHA = "a".repeat(64);
const SNAPSHOT_GATE_SHA = "9".repeat(64);
const WORKTREE_SHA = "b".repeat(64);
const COMMIT_SHA7 = "abcdef0";
const COMMIT_SHA = COMMIT_SHA7 + "1".repeat(33);
const EXECUTED_DIST = {
  algorithm: "sha256-reachable-path-file-sha256-v1" as const,
  sha256: "8".repeat(64),
  file_count: 1
};

interface SnapshotFixtureOptions {
  readonly recallPipelineVersion?: string;
  readonly schemaMigrationOffset?: number;
  readonly storedGateEligible?: boolean;
  readonly duplicateObject?: "exact" | "conflicting";
  readonly producerEnvOverride?: Readonly<Record<string, string>>;
  readonly tamperSeedLedger?:
    | "source"
    | "raw_digest"
    | "raw_count"
    | "draft_count"
    | "memory_ids";
  readonly seedFactsProducedOffset?: number;
  readonly extractionAuthorityDrift?: "expected_turns" | "content_closure" | "window";
  readonly tamperCanonical?:
    | "question"
    | "question_date"
    | "answer_sessions"
    | "sidecar_session"
    | "has_answer"
    | "omit_distractor_round";
}

function canonicalQuestion(questionId: string): LongMemEvalQuestion {
  const sessionId = `${questionId}-answer-session`;
  const distractorSessionId = `${questionId}-distractor-session`;
  return {
    question_id: questionId,
    question_type: "single-session-user",
    question: `Question ${questionId}`,
    answer: `Answer ${questionId}`,
    question_date: "2026-07-16T00:00:00.000Z",
    haystack_session_ids: [sessionId, distractorSessionId],
    haystack_dates: [
      "2026-07-15T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z"
    ],
    haystack_sessions: [
      [
        { role: "user", content: `Context ${questionId}` },
        { role: "assistant", content: `Answer ${questionId}`, has_answer: true }
      ],
      [
        { role: "user", content: `Distractor ${questionId}` },
        { role: "assistant", content: `No durable signal ${questionId}` }
      ]
    ],
    answer_session_ids: [sessionId]
  };
}


function runProvenance(
  selection: ReturnType<typeof createLongMemEvalSelectionContractIdentity>,
  gateSha256: string,
  questions: readonly LongMemEvalQuestion[],
  pairedEnvOverride: Readonly<Record<string, string>> = {}
): LongMemEvalRunProvenance {
  const cache = cacheIdentityForQuestions(questions);
  return LongMemEvalRunProvenanceSchema.parse({
    schema_version: 1,
    dataset_sha256: DATASET_SHA,
    selection,
    code: {
      commit_sha7: COMMIT_SHA7,
      commit_sha: COMMIT_SHA,
      gate_sha256: gateSha256,
      gate_contract_path: "/fixture/promotion-contract.json",
      worktree_state_sha256: WORKTREE_SHA,
      worktree_clean: true,
      executed_dist: EXECUTED_DIST
    },
    extraction_cache: {
      schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
      manifest_sha256: "c".repeat(64),
      extraction_model: "fixture-model",
      model_family: "fixture-family",
      request_profile: EXTRACTION_REQUEST_PROFILES[0],
      provider_url: "redacted",
      system_prompt_sha256: sha256(OFFICIAL_API_SYSTEM_PROMPT),
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval_s",
      dataset_revision: DATASET_SHA,
      requested_turns: cache.entries.length,
      cached_turns: cache.entries.length,
      coverage: 1,
      fill_status: "complete",
      window_offset: 0,
      window_limit: 2,
      expected_turns: cache.entries.length,
      expected_key_set_sha256: cache.keySetSha256,
      content_closure_sha256: cache.contentClosureSha256,
      content_closure_index: cache.contentClosureIndex,
      storage: "git-tracked",
      built_at: "2026-07-16T00:00:00.000Z",
      builder: "fixture"
    },
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      embedding_mode: "disabled",
      embedding_provider_kind: "local_onnx",
      embedding_provider_label: "none",
      onnx_threads: null,
      embedding_supplement: { enabled: false },
      answer_rerank: { enabled: false },
      paired_env: {
        ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false",
        ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false",
        ALAYA_RECALL_ANSWERS_WITH: "1",
        ALAYA_INGEST_RECONCILIATION_ENABLED: "1",
        ALAYA_CONFLICT_DETECTION_ENABLED: "1",
        ALAYA_GARDEN_PROVIDER_KIND: "host_worker",
        ...pairedEnvOverride
      }
    },
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: null,
      evaluated_count: 2
    },
    recall_config: canonicalProductRecallProvenanceConfig(),
    seed_capabilities: { facet_tags_enabled: false },
    question_manifest: null
  });
}

function runtimeAttribution(
  questionDigest: string,
  provenance: LongMemEvalRunProvenance,
  snapshotManifestSha256: string,
  snapshotGateSha256: string,
  schemaMigrationVersion: number
): RecallEvalRuntimeAttribution {
  const cache = requireV3Cache(provenance);
  return {
    status: "attributed",
    gate_eligible: true,
    node_version: provenance.runtime.node_version,
    platform: provenance.runtime.platform,
    arch: provenance.runtime.arch,
    embedding_mode: "disabled",
    embedding_provider_kind: "local_onnx",
    embedding_provider_label: "none",
    onnx_threads: null,
    onnx_model_artifact_sha256: null,
    embedding_supplement: { enabled: false },
    answer_rerank: { enabled: false },
    recall_config: canonicalProductRecallConfig(),
    evaluation_slice: {
      offset: 0,
      limit: null,
      evaluated_count: 2,
      question_id_digest: questionDigest
    },
    hydration_binding: { dataset_sha256: DATASET_SHA, source: "external_expected_sha256" },
    snapshot_binding: {
      commit_sha7: COMMIT_SHA7,
      gate_sha256: snapshotGateSha256,
      worktree_state_sha256: WORKTREE_SHA,
      extraction_cache_manifest_sha256: cache.manifest_sha256,
      extraction_cache_requested_turns: cache.requested_turns!,
      extraction_cache_cached_turns: cache.cached_turns!,
      extraction_cache_coverage: cache.coverage!,
      dataset_sha256: DATASET_SHA,
      question_id_digest: questionDigest,
      snapshot_manifest_sha256: snapshotManifestSha256,
      producer_recall_pipeline_version: RECALL_PIPELINE_VERSION,
      consumer_recall_pipeline_version: RECALL_PIPELINE_VERSION,
      producer_schema_migration_version: schemaMigrationVersion
    }
  };
}


function requireV3Cache(provenance: LongMemEvalRunProvenance) {
  const cache = provenance.extraction_cache;
  if (cache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION) {
    throw new Error("promotion fixture requires extraction cache v3");
  }
  return cache;
}

function question(id: string, latencyMs: number): RecallEvalQuestionResult {
  const base = promotionMeasurementDiagnostic(id, "scorable", true);
  const source = canonicalQuestion(id);
  const sessionId = source.answer_session_ids[0]!;
  const sidecar = new Map([[
    `memory_entry:${promotionGoldId(id)}`,
    {
      objectId: promotionGoldId(id),
      objectKind: "memory_entry" as const,
      sessionId,
      hasAnswer: true
    }
  ]]);
  const axes = buildQuestionMeasurementAxes({
    answer: source.answer,
    answerSessionIds: source.answer_session_ids,
    sourceDatesBySession: new Map(source.haystack_session_ids.map(
      (sourceSessionId, index) => [sourceSessionId, source.haystack_dates[index]!]
    )),
    deliveredResults: base.delivered_results,
    candidates: base.candidates,
    sidecar,
    isAbstention: false,
    evaluatorGoldMemoryIds: base.gold_memory_ids,
    evaluatorHitAt5: true
  });
  const diagnostic = {
    ...base,
    answer_session_ids: source.answer_session_ids,
    quality_axes: axes,
    cohort_ledger: { ...base.cohort_ledger!, quality_axes: axes }
  };
  return {
    questionId: id,
    hitAt1: true,
    hitAt5: true,
    hitAt10: true,
    firstTier: "hot",
    latencyMs,
    degradationReason: null,
    diagnostics: {
      ...diagnostic,
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

function seedExtractionPath() {
  return {
    path: "official_api_compile" as const,
    extraction_attempts: 4,
    cache_hits: 4,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 2,
    signals_dropped: 0,
    parse_dropped: 0,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
  };
}

function seedRoundsForQuestion(question: LongMemEvalQuestion) {
  return question.haystack_sessions.map((session, sessionIndex) => {
    const content = `User: ${session[0]!.content}\nAssistant: ${session[1]!.content}`;
    const memoryObjectIds = sessionIndex === 0
      ? [promotionGoldId(question.question_id)]
      : [];
    return {
      sessionIndex,
      roundIndex: 0,
      sessionId: question.haystack_session_ids[sessionIndex]!,
      contentSha256: sha256(content),
      hasAnswer: sessionIndex === 0,
      extractionSource: "cache" as const,
      cacheKey: computeCacheKey(
        "fixture-model",
        EXTRACTION_REQUEST_PROFILES[0],
        OFFICIAL_API_SYSTEM_PROMPT,
        content
      ),
      rawJsonSha256: sha256(`raw:${question.question_id}:${sessionIndex}`),
      rawSignalCount: memoryObjectIds.length,
      draftCount: memoryObjectIds.length,
      factsProduced: memoryObjectIds.length,
      parseDropped: 0,
      compileOverflowDropped: 0,
      candidateAbsent: 0,
      materializationDrop: 0,
      memoryObjectIds,
      memoryBindings: memoryObjectIds.map((objectId) => ({
        objectId,
        signalId: promotionSignalId(question.question_id),
        evidenceId: `${question.question_id}-evidence`
      }))
    };
  });
}

function promotionSignalId(questionId: string): string {
  return `${questionId}-signal`;
}

function cacheIdentityForQuestions(questions: readonly LongMemEvalQuestion[]) {
  const entries = questions.flatMap((question) =>
    seedRoundsForQuestion(question).map((round) => ({
      cacheKey: round.cacheKey,
      model: "fixture-model",
      requestProfile: EXTRACTION_REQUEST_PROFILES[0],
      rawJsonSha256: round.rawJsonSha256,
      rawSignalCount: round.rawSignalCount,
      parsedDraftCount: round.draftCount
    })));
  return {
    entries,
    keySetSha256: computeExtractionKeySetSha256(
      entries.map((entry) => entry.cacheKey)
    ),
    contentClosureSha256: computeExtractionContentClosureSha256(entries),
    contentClosureIndex: buildExtractionContentClosureIndex(entries)
  };
}


function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export {
  cacheIdentityForQuestions,
  canonicalQuestion,
  COMMIT_SHA,
  COMMIT_SHA7,
  DATASET_SHA,
  EXECUTED_DIST,
  GATE_SHA,
  promotionSignalId,
  question,
  requireV3Cache,
  runProvenance,
  runtimeAttribution,
  seedExtractionPath,
  seedRoundsForQuestion,
  sha256,
  SNAPSHOT_GATE_SHA,
  WORKTREE_SHA
};
export type { SnapshotFixtureOptions };
