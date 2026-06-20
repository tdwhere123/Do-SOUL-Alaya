import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects
} from "./diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "./diagnostics-artifacts.js";
import {
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  renderLongMemEvalColdWarmComparisonSidecar
} from "./archive-evidence.js";
import { selectFullRunBaseline } from "./recall-eval-archive.js";
import { appendSeedExtractionReleaseBlockerToFindings, appendSeedExtractionReleaseBlockerToReport } from "./seed-extraction-release-blocker.js";
import type { BenchCommitInfo } from "./runner-helpers.js";
import type { LongMemEvalRunOptions, LongMemEvalRunResult } from "./runner.js";
import type { LongMemEvalRunArchiveAggregate } from "./runner-archive-aggregate.js";
import type { LongMemEvalPayloadBuild } from "./runner-archive-payload.js";

export async function writeLongMemEvalRunArchive(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly build: LongMemEvalPayloadBuild;
  readonly commitInfo: BenchCommitInfo;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly collectedLength: number;
}): Promise<LongMemEvalRunResult> {
  const layout: HistoryLayout = { historyRoot: input.opts.historyRoot };
  const payload = await withLongMemEvalDiff(layout, input.build.payload);
  const slug = entrySlug(
    input.runAt,
    input.commitSha7,
    benchArchiveDiscriminator(payload.policy_shape, payload.simulate_report)
  );
  const sidecars = await buildLongMemEvalArchiveSidecars({ ...input, payload, layout, slug });
  const entry = await writeEntry(layout, "public", slug, payload, sidecars.report, sidecars.findings, {
    sidecars: sidecars.sidecars
  });
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload
  };
}

async function withLongMemEvalDiff(
  layout: HistoryLayout,
  payload: KpiPayload
): Promise<KpiPayload> {
  const previous = await selectFullRunBaseline(layout, "public", {
    split: payload.split,
    policyShape: payload.policy_shape,
    simulateReport: payload.simulate_report,
    embeddingProvider: payload.embedding_provider
  });
  const diff = diffKpis(payload, previous);
  return {
    ...payload,
    diff_vs_previous: buildDiffVsPrevious(payload, previous, previous?.run_at ?? "")
  };
}

async function buildLongMemEvalArchiveSidecars(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly build: LongMemEvalPayloadBuild;
  readonly commitInfo: BenchCommitInfo;
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly collectedLength: number;
  readonly payload: KpiPayload;
  readonly layout: HistoryLayout;
  readonly slug: string;
}): Promise<{
  readonly report: string;
  readonly findings: string | null;
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
}> {
  const previous = await selectFullRunBaseline(input.layout, "public", {
    split: input.payload.split,
    policyShape: input.payload.policy_shape,
    simulateReport: input.payload.simulate_report,
    embeddingProvider: input.payload.embedding_provider
  });
  const diff = diffKpis(input.payload, previous);
  const diagnostics = await buildDiagnosticsSidecar(input);
  const comparison = await buildComparisonSidecar(input, diagnostics.currentEvidence);
  return {
    report: appendSeedExtractionReleaseBlockerToReport(renderReport(input.payload, previous, diff), input.payload),
    findings: appendSeedExtractionReleaseBlockerToFindings(renderFindings(input.payload, diff), input.payload),
    sidecars: [
      { filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: diagnostics.compact },
      { filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: comparison }
    ]
  };
}

async function buildDiagnosticsSidecar(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly build: LongMemEvalPayloadBuild;
  readonly commitInfo: BenchCommitInfo;
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly collectedLength: number;
  readonly payload: KpiPayload;
  readonly slug: string;
}): Promise<{ readonly compact: string; readonly currentEvidence: ReturnType<typeof buildCurrentEvidence> }> {
  const currentEvidence = buildCurrentEvidence(input);
  const diagnosticsPayload = buildDiagnosticsPayload(input, currentEvidence);
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: input.opts.historyRoot,
    benchName: "public",
    slug: input.slug,
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: renderDiagnosticsSidecar(diagnosticsPayload)
  });
  return {
    compact: renderCompactDiagnosticsSidecar(diagnosticsPayload, diagnosticsArtifactPath),
    currentEvidence
  };
}

function buildCurrentEvidence(input: {
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly payload: KpiPayload;
}): {
  readonly report_side_effects: ReturnType<typeof summarizeLongMemEvalReportSideEffects>;
  readonly scored_recall_evidence: ReturnType<typeof summarizeLongMemEvalRecallEvidence>;
} {
  return {
    report_side_effects: summarizeLongMemEvalReportSideEffects({
      mode: input.payload.simulate_report,
      snapshots: input.aggregate.reportSideEffectSnapshots
    }),
    scored_recall_evidence: summarizeLongMemEvalRecallEvidence(
      input.aggregate.questionDiagnostics
    )
  };
}

function buildDiagnosticsPayload(
  input: Parameters<typeof buildDiagnosticsSidecar>[0],
  currentEvidence: ReturnType<typeof buildCurrentEvidence>
) {
  return {
    schema_version: 1,
    bench_name: "public",
    split: input.payload.split,
    run_at: input.payload.run_at,
    alaya_commit: input.payload.alaya_commit,
    commit_resolution: input.commitInfo,
    recall_pipeline_version: input.payload.recall_pipeline_version,
    embedding_provider: input.payload.embedding_provider,
    embedding_mode: input.opts.embeddingMode ?? "disabled",
    policy_shape: input.payload.policy_shape,
    simulate_report: input.payload.simulate_report,
    seed_extraction_path: input.payload.kpi.seed_extraction_path,
    report_usage: {
      mode: input.payload.simulate_report,
      reports_attempted: input.build.reportUsage.reportsAttempted,
      reports_used: input.build.reportUsage.reportsUsed,
      reports_skipped: input.build.reportUsage.reportsSkipped,
      used_object_count: input.build.reportUsage.reportUsedObjectCount
    },
    ...(input.questionFailures === 0
      ? {}
      : {
          question_failures: {
            failed_count: input.questionFailures,
            completed_count: input.collectedLength,
            failed_question_ids: input.failedQuestionIds
          }
        }),
    report_side_effects: currentEvidence.report_side_effects,
    scored_recall_evidence: currentEvidence.scored_recall_evidence,
    ...(input.build.embeddingVectorCache === null ? {} : { embedding_vector_cache: input.build.embeddingVectorCache }),
    ...(input.build.queryEmbeddingCache === null ? {} : { query_embedding_cache: input.build.queryEmbeddingCache }),
    provider_state_summary: input.build.providerSummary,
    questions: input.aggregate.questionDiagnostics
  } as const;
}

async function buildComparisonSidecar(
  input: {
    readonly layout: HistoryLayout;
    readonly payload: KpiPayload;
    readonly slug: string;
  },
  currentEvidence: ReturnType<typeof buildCurrentEvidence>
): Promise<string> {
  const opposite = await readLatestLongMemEvalOppositeArchive({
    layout: input.layout,
    current: input.payload
  });
  return renderLongMemEvalColdWarmComparisonSidecar(
    buildLongMemEvalColdWarmComparisonSidecar({
      currentSlug: input.slug,
      current: input.payload,
      currentEvidence,
      opposite
    })
  );
}
