import { renderCompactDiagnosticsSidecar, summarizeLongMemEvalMissTaxonomy, summarizeProviderStates, type LongMemEvalDiagnosticsSidecar, type LongMemEvalEmbeddingVectorCacheSummary, type LongMemEvalMissTaxonomySummary, type LongMemEvalQueryEmbeddingCacheSummary, type LongMemEvalQuestionDiagnostic, type LongMemEvalReportUsageSummary } from "../longmemeval/diagnostics.js";
import type { LongMemEvalArchiveEvidenceSummary } from "../longmemeval/archive/archive-evidence.js";
import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  mergeMissTaxonomySummaries,
  readCompactMissTaxonomySummary
} from "../longmemeval/diagnostics/miss/diagnostics-miss-taxonomy.js";
import { ratio } from "./merge-shared.js";

export function buildMergedLongMemEvalDiagnosticsSidecar(
  payload: KpiPayload,
  shardDiagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[],
  evidence: LongMemEvalArchiveEvidenceSummary
): MergedLongMemEvalDiagnosticsPayload {
  const questions = normalizeMergedQuestions(
    shardDiagnostics.flatMap((diagnostics) => {
      if (diagnostics === null) {
        throw new Error(
          "merge refused: missing diagnostics sidecar for one or more shards"
        );
      }
      return diagnostics.questions ?? [];
    }),
    payload.answerable_evaluated_count === undefined
  );
  assertMergedDiagnosticsQuestionsMatchKpi(payload, questions);
  const summary = collectMergedDiagnosticsSummary(payload, shardDiagnostics, questions);
  return {
    sidecar: buildMergedDiagnosticsSidecar(payload, evidence, questions, summary),
    question_count: summary.questionCount,
    report_side_effects_snapshot_count: summary.reportSideEffectSnapshotCount,
    failed_question_ids: summary.questionFailures?.failed_question_ids ?? []
  };
}

interface MergedDiagnosticsSummary {
  readonly questionCount: number;
  readonly reportSideEffectSnapshotCount: number | null;
  readonly embeddingMode: LongMemEvalDiagnosticsSidecar["embedding_mode"];
  readonly reportUsage: LongMemEvalReportUsageSummary | null;
  readonly embeddingVectorCache: LongMemEvalEmbeddingVectorCacheSummary | null;
  readonly queryEmbeddingCache: LongMemEvalQueryEmbeddingCacheSummary | null;
  readonly missTaxonomySummary: LongMemEvalMissTaxonomySummary | null;
  readonly questionFailures: LongMemEvalDiagnosticsSidecar["question_failures"] | null;
}

function buildMergedDiagnosticsSidecar(
  payload: KpiPayload,
  evidence: LongMemEvalArchiveEvidenceSummary,
  questions: readonly LongMemEvalQuestionDiagnostic[],
  summary: MergedDiagnosticsSummary
): LongMemEvalDiagnosticsSidecar {
  return {
    schema_version: 1,
    bench_name: "public",
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: summary.embeddingMode,
    policy_shape: payload.policy_shape,
    simulate_report: payload.simulate_report,
    seed_extraction_path: payload.kpi.seed_extraction_path,
    ...(summary.reportUsage === null ? {} : { report_usage: summary.reportUsage }),
    ...(evidence.report_side_effects === null
      ? {}
      : { report_side_effects: evidence.report_side_effects }),
    ...(evidence.scored_recall_evidence === null
      ? {}
      : { scored_recall_evidence: evidence.scored_recall_evidence }),
    ...(summary.embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: summary.embeddingVectorCache }),
    ...(summary.queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: summary.queryEmbeddingCache }),
    ...(summary.questionFailures === null ? {} : { question_failures: summary.questionFailures }),
    ...(summary.missTaxonomySummary === null
      ? {}
      : { miss_taxonomy_summary: summary.missTaxonomySummary }),
    provider_state_summary: summarizeProviderStates(questions),
    questions
  };
}

function collectMergedDiagnosticsSummary(
  payload: KpiPayload,
  diagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[],
  questions: readonly LongMemEvalQuestionDiagnostic[]
): MergedDiagnosticsSummary {
  const present = diagnostics.filter(
    (sidecar): sidecar is LongMemEvalDiagnosticsSidecar => sidecar !== null
  );
  return {
    questionCount: diagnostics.reduce((sum, sidecar) => sum + diagnosticQuestionCount(sidecar), 0),
    reportSideEffectSnapshotCount: aggregateReportSideEffectSnapshotCount(diagnostics),
    embeddingMode: present[0]?.embedding_mode ??
      (payload.embedding_provider === "none" ? "disabled" : "env"),
    reportUsage: aggregateReportUsage(present.flatMap((sidecar) =>
      sidecar.report_usage === undefined ? [] : [sidecar.report_usage]
    )),
    embeddingVectorCache: aggregateEmbeddingVectorCache(present.flatMap((sidecar) =>
      sidecar.embedding_vector_cache === undefined ? [] : [sidecar.embedding_vector_cache]
    )),
    queryEmbeddingCache: aggregateQueryEmbeddingCache(present.flatMap((sidecar) =>
      sidecar.query_embedding_cache === undefined ? [] : [sidecar.query_embedding_cache]
    )),
    missTaxonomySummary: aggregateMissTaxonomySummary(diagnostics, questions),
    questionFailures: aggregateQuestionFailures(diagnostics, questions.length)
  };
}

function normalizeMergedQuestions(
  questions: readonly LongMemEvalQuestionDiagnostic[],
  legacyMeasurementContract: boolean
): LongMemEvalQuestionDiagnostic[] {
  if (!legacyMeasurementContract) return [...questions];
  return questions.map(withLegacyMeasurementEvidence);
}

function withLegacyMeasurementEvidence(
  question: LongMemEvalQuestionDiagnostic
): LongMemEvalQuestionDiagnostic {
  if (question.cohort_ledger === undefined) {
    return withLegacyPartialCohort(question);
  }
  return {
    ...question,
    cohort_ledger: {
      ...question.cohort_ledger,
      measurement_evidence_mode: "legacy_synthesized"
    }
  };
}

function withLegacyPartialCohort(
  question: LongMemEvalQuestionDiagnostic
): LongMemEvalQuestionDiagnostic {
  const abstention = question.is_abstention || question.question_id.endsWith("_abs");
  const hit = question.hit_at_5;
  return {
    ...question,
    candidate_pool_complete: false,
    candidates: question.candidates ?? [],
    cohort_ledger: {
      measurement_evidence_mode: "legacy_synthesized",
      measurement_status: abstention
        ? "abstention_unscorable"
        : "evaluator_identity_unscorable",
      dataset_cohort: abstention ? "abstention" : "answerable",
      extraction_materialization: question.gold_memory_ids.length > 0
        ? { status: "memory_emitted", emitted_memory_count: question.gold_memory_ids.length, reason: null }
        : { status: "unknown", emitted_memory_count: 0, reason: null },
      evaluator_gold_identity: {
        status: question.gold_memory_ids.length > 0 ? "present" : "absent",
        object_ids: question.gold_memory_ids
      },
      retrieval_status: abstention ? "not_applicable" : hit ? "hit_at_5" : "miss_at_5",
      evidence_status: "partial",
      evaluation_issue_reason: abstention ? null : "missing_diagnostics",
      candidate_pool_complete: false,
      stage_ranks: [],
      final_verdict: abstention ? "abstain_false_confident" : hit ? "hit_at_5" : "miss_at_5"
    }
  };
}

export interface MergedLongMemEvalDiagnosticsPayload {
  readonly sidecar: LongMemEvalDiagnosticsSidecar;
  readonly question_count: number;
  readonly report_side_effects_snapshot_count: number | null;
  readonly failed_question_ids: readonly string[];
}

function aggregateQuestionFailures(
  diagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[],
  completedCount: number
): LongMemEvalDiagnosticsSidecar["question_failures"] | null {
  const failedIds = diagnostics.flatMap((sidecar) =>
    sidecar?.question_failures?.failed_question_ids ?? []
  );
  if (failedIds.length === 0) return null;
  if (new Set(failedIds).size !== failedIds.length) {
    throw new Error("merge refused: duplicate failed question ID across shards");
  }
  return {
    failed_count: failedIds.length,
    completed_count: completedCount,
    failed_question_ids: failedIds
  };
}

function assertMergedDiagnosticsQuestionsMatchKpi(
  _payload: KpiPayload,
  questions: readonly { readonly question_id?: unknown }[]
): void {
  if (questions.length === 0) {
    return;
  }
  const seenIds = new Set<string>();
  for (const question of questions) {
    if (typeof question.question_id !== "string") {
      throw new Error("merge refused: diagnostics question is missing question_id");
    }
    if (seenIds.has(question.question_id)) {
      throw new Error(
        `merge refused: duplicate diagnostics question_id '${question.question_id}' across shards`
      );
    }
    seenIds.add(question.question_id);
  }
}

function diagnosticQuestionCount(
  diagnostics: LongMemEvalDiagnosticsSidecar | null
): number {
  if (diagnostics === null) {
    return 0;
  }
  if (Array.isArray(diagnostics.questions)) {
    return diagnostics.questions.length;
  }
  const compactQuestionCount = (
    diagnostics as { readonly question_count?: unknown }
  ).question_count;
  return requiredCompactNonNegativeInteger(
    compactQuestionCount,
    "question_count"
  );
}

function aggregateReportSideEffectSnapshotCount(
  shardDiagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[]
): number | null {
  let total = 0;
  let observed = false;
  for (const diagnostics of shardDiagnostics) {
    const reportSideEffects = diagnostics?.report_side_effects;
    if (reportSideEffects === undefined) continue;
    observed = true;
    if (Array.isArray(reportSideEffects.snapshots)) {
      total += reportSideEffects.snapshots.length;
      continue;
    }
    const compactSnapshotCount = (
      reportSideEffects as { readonly snapshot_count?: unknown }
    ).snapshot_count;
    total += requiredCompactNonNegativeInteger(
      compactSnapshotCount,
      "report_side_effects.snapshot_count"
    );
  }
  return observed ? total : null;
}

function requiredCompactNonNegativeInteger(
  value: unknown,
  fieldName: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `invalid compact diagnostics ${fieldName}: expected non-negative integer`
    );
  }
  return value;
}

function aggregateMissTaxonomySummary(
  shardDiagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[],
  questions: readonly LongMemEvalQuestionDiagnostic[]
): LongMemEvalMissTaxonomySummary | null {
  const summaries: LongMemEvalMissTaxonomySummary[] = [];
  if (shardDiagnostics.some((diagnostics) => Array.isArray(diagnostics?.questions))) {
    const currentQuestions = questions.filter((question) =>
      question.cohort_ledger?.measurement_evidence_mode !== "legacy_synthesized"
    );
    summaries.push(summarizeLongMemEvalMissTaxonomy(currentQuestions));
  }
  for (const diagnostics of shardDiagnostics) {
    if (diagnostics === null || Array.isArray(diagnostics.questions)) continue;
    const summary = readCompactMissTaxonomySummary(diagnostics.miss_taxonomy_summary);
    if (summary === null) continue;
    summaries.push(summary);
  }
  return summaries.length === 0 ? null : mergeMissTaxonomySummaries(summaries);
}

export function renderMergedLongMemEvalCompactDiagnosticsSidecar(
  payload: MergedLongMemEvalDiagnosticsPayload,
  fullDiagnosticsArtifactPath: string
): string {
  const compact = JSON.parse(
    renderCompactDiagnosticsSidecar(
      payload.sidecar,
      fullDiagnosticsArtifactPath,
      { includeQuestions: true }
    )
  ) as {
    question_count?: unknown;
    report_side_effects?: { snapshot_count?: unknown };
  };
  compact.question_count = payload.question_count;
  if (
    compact.report_side_effects !== undefined &&
    payload.report_side_effects_snapshot_count !== null
  ) {
    compact.report_side_effects.snapshot_count =
      payload.report_side_effects_snapshot_count;
  }
  return JSON.stringify(compact, null, 2) + "\n";
}

function aggregateReportUsage(
  usages: readonly LongMemEvalReportUsageSummary[]
): LongMemEvalReportUsageSummary | null {
  if (usages.length === 0) {
    return null;
  }
  return {
    mode: usages[0]?.mode ?? "none",
    reports_attempted: usages.reduce(
      (sum, usage) => sum + usage.reports_attempted,
      0
    ),
    reports_used: usages.reduce((sum, usage) => sum + usage.reports_used, 0),
    reports_skipped: usages.reduce(
      (sum, usage) => sum + usage.reports_skipped,
      0
    ),
    used_object_count: usages.reduce(
      (sum, usage) => sum + usage.used_object_count,
      0
    )
  };
}

export function aggregateEmbeddingVectorCache(
  summaries: readonly LongMemEvalEmbeddingVectorCacheSummary[]
): LongMemEvalEmbeddingVectorCacheSummary | null {
  if (summaries.length === 0) {
    return null;
  }
  const expectedCount = summaries.reduce(
    (sum, summary) => sum + summary.expected_count,
    0
  );
  const readyCount = summaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const maxPassCount = summaries.reduce(
    (max, summary) => Math.max(max, summary.max_pass_count),
    0
  );
  return {
    expected_count: expectedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, expectedCount - readyCount),
    ready_rate: ratio(readyCount, expectedCount),
    max_pass_count: maxPassCount
  };
}

export function aggregateQueryEmbeddingCache(
  summaries: readonly LongMemEvalQueryEmbeddingCacheSummary[]
): LongMemEvalQueryEmbeddingCacheSummary | null {
  if (summaries.length === 0) {
    return null;
  }
  const requestedCount = summaries.reduce(
    (sum, summary) => sum + summary.requested_count,
    0
  );
  const readyCount = summaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const cacheHitCount = summaries.reduce(
    (sum, summary) => sum + summary.cache_hit_count,
    0
  );
  const providerRequestedCount = summaries.reduce(
    (sum, summary) => sum + summary.provider_requested_count,
    0
  );
  const lastError = [...summaries].reverse().find(
    (summary) => summary.last_error !== undefined
  )?.last_error;
  return {
    requested_count: requestedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, requestedCount - readyCount),
    ready_rate: ratio(readyCount, requestedCount),
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}
