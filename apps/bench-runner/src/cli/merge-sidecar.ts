import { renderCompactDiagnosticsSidecar, summarizeLongMemEvalMissTaxonomy, summarizeProviderStates, type LongMemEvalDiagnosticsSidecar, type LongMemEvalEmbeddingVectorCacheSummary, type LongMemEvalMissTaxonomySummary, type LongMemEvalQueryEmbeddingCacheSummary, type LongMemEvalReportUsageSummary } from "../longmemeval/diagnostics.js";
import type { LongMemEvalArchiveEvidenceSummary } from "../longmemeval/archive-evidence.js";
import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  mergeMissTaxonomySummaries,
  readCompactMissTaxonomySummary
} from "../longmemeval/diagnostics-miss-taxonomy.js";
import { ratio } from "./merge-shared.js";

export function buildMergedLongMemEvalDiagnosticsSidecar(
  payload: KpiPayload,
  shardDiagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[],
  evidence: LongMemEvalArchiveEvidenceSummary
): MergedLongMemEvalDiagnosticsPayload {
  const questions = shardDiagnostics.flatMap((diagnostics) => {
    if (diagnostics === null) {
      throw new Error(
        "merge refused: missing diagnostics sidecar for one or more shards"
      );
    }
    return diagnostics.questions ?? [];
  });
  assertMergedDiagnosticsQuestionsMatchKpi(payload, questions);
  const questionCount = shardDiagnostics.reduce(
    (sum, diagnostics) => sum + diagnosticQuestionCount(diagnostics),
    0
  );
  const reportSideEffectSnapshotCount = aggregateReportSideEffectSnapshotCount(
    shardDiagnostics
  );
  const embeddingMode =
    shardDiagnostics.find(
      (diagnostics): diagnostics is LongMemEvalDiagnosticsSidecar =>
        diagnostics !== null
    )?.embedding_mode ??
    (payload.embedding_provider === "none" ? "disabled" : "env");
  const reportUsage = aggregateReportUsage(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.report_usage)
      .filter(
        (usage): usage is LongMemEvalReportUsageSummary => usage !== undefined
      )
  );
  const embeddingVectorCache = aggregateEmbeddingVectorCache(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.embedding_vector_cache)
      .filter(
        (summary): summary is LongMemEvalEmbeddingVectorCacheSummary =>
          summary !== undefined
      )
  );
  const queryEmbeddingCache = aggregateQueryEmbeddingCache(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.query_embedding_cache)
      .filter(
        (summary): summary is LongMemEvalQueryEmbeddingCacheSummary =>
          summary !== undefined
      )
  );
  const missTaxonomySummary = aggregateMissTaxonomySummary(shardDiagnostics);

  const sidecar: LongMemEvalDiagnosticsSidecar = {
    schema_version: 1,
    bench_name: "public",
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: embeddingMode,
    policy_shape: payload.policy_shape,
    simulate_report: payload.simulate_report,
    ...(reportUsage === null ? {} : { report_usage: reportUsage }),
    ...(evidence.report_side_effects === null
      ? {}
      : { report_side_effects: evidence.report_side_effects }),
    ...(evidence.scored_recall_evidence === null
      ? {}
      : { scored_recall_evidence: evidence.scored_recall_evidence }),
    ...(embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: embeddingVectorCache }),
    ...(queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: queryEmbeddingCache }),
    ...(missTaxonomySummary === null
      ? {}
      : { miss_taxonomy_summary: missTaxonomySummary }),
    provider_state_summary: summarizeProviderStates(questions),
    questions
  };
  return {
    sidecar,
    question_count: questionCount,
    report_side_effects_snapshot_count: reportSideEffectSnapshotCount
  };
}

interface MergedLongMemEvalDiagnosticsPayload {
  readonly sidecar: LongMemEvalDiagnosticsSidecar;
  readonly question_count: number;
  readonly report_side_effects_snapshot_count: number | null;
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
  shardDiagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[]
): LongMemEvalMissTaxonomySummary | null {
  const summaries: LongMemEvalMissTaxonomySummary[] = [];
  for (const diagnostics of shardDiagnostics) {
    if (diagnostics === null) continue;
    const summary = Array.isArray(diagnostics.questions)
      ? summarizeLongMemEvalMissTaxonomy(diagnostics.questions)
      : readCompactMissTaxonomySummary(diagnostics.miss_taxonomy_summary);
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
    renderCompactDiagnosticsSidecar(payload.sidecar, fullDiagnosticsArtifactPath)
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
