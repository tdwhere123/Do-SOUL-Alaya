import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  renderFindings,
  renderReport,
  writeEntry,
  isHistoryEntryCommittedError,
  isCacheOnlySeedExtractionPath,
  KpiPayloadSchema,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { rm } from "node:fs/promises";
import {
  renderCompactDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects,
  type LongMemEvalDiagnosticsSidecar
} from "./diagnostics.js";
import {
  resolveBenchDiagnosticsArtifactRoot
} from "./diagnostics-artifacts.js";
import path from "node:path";
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
import {
  buildLongMemEvalRunProvenanceSidecar,
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema
} from "./provenance/run.js";
import {
  LONGMEMEVAL_COHORT_LEDGER_FILENAME,
  renderLongMemEvalCohortLedger
} from "./cohort-ledger.js";
import {
  buildLongMemEvalEvidenceManifest,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput
} from "./evidence-manifest.js";
import type { LongMemEvalDiagnosticsSpool } from "./diagnostics/spool.js";
import { buildBenchmarkMeasurementAttribution } from "./measurement/attribution.js";
import {
  prepareDiagnosticsArtifactStagingPath,
  withPublishedDiagnosticsArtifact,
  type StagedDiagnosticsArtifact
} from "./measurement/artifact-transaction.js";

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
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<LongMemEvalRunResult> {
  const layout: HistoryLayout = { historyRoot: input.opts.historyRoot };
  const payload = await withLongMemEvalDiff(layout, input.build.payload);
  const slug = entrySlug(
    input.runAt,
    input.commitSha7,
    benchArchiveDiscriminator(payload.policy_shape, payload.simulate_report)
  );
  const sidecars = await buildLongMemEvalArchiveSidecars({ ...input, payload, layout, slug });
  const entry = await withPublishedDiagnosticsArtifact(
    sidecars.diagnosticsArtifact,
    () => writeEntry(
      layout,
      "public",
      slug,
      sidecars.payload,
      sidecars.report,
      sidecars.findings,
      {
        sidecars: sidecars.sidecars,
        fileSidecars: [{
          filename: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
          sourcePath: sidecars.diagnosticsArtifact.finalPath
        }]
      }
    ),
    isHistoryEntryCommittedError
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload: sidecars.payload
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

type ArchiveSidecarBuildInput = Readonly<{
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
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}>;

type ArchiveSidecarBuildResult = Readonly<{
  readonly payload: KpiPayload;
  readonly report: string;
  readonly findings: string | null;
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
  readonly diagnosticsArtifact: StagedDiagnosticsArtifact;
}>;

async function buildLongMemEvalArchiveSidecars(
  input: ArchiveSidecarBuildInput
): Promise<ArchiveSidecarBuildResult> {
  const diagnostics = await buildDiagnosticsSidecar(input);
  try {
    return await buildArchiveSidecarsAfterDiagnostics(input, diagnostics);
  } catch (error) {
    await rm(diagnostics.stagedArtifactPath, { force: true });
    throw error;
  }
}

async function buildArchiveSidecarsAfterDiagnostics(
  input: ArchiveSidecarBuildInput,
  diagnostics: Awaited<ReturnType<typeof buildDiagnosticsSidecar>>
): Promise<ArchiveSidecarBuildResult> {
  const prepared = await prepareArchiveSidecars(input, diagnostics);
  return {
    payload: prepared.payload,
    report: prepared.report,
    findings: prepared.findings,
    sidecars: [
      { filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: diagnostics.compact },
      { filename: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: prepared.cohortLedger },
      { filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: prepared.comparison },
      prepared.runProvenanceSidecar,
      prepared.evidenceManifest
    ],
    diagnosticsArtifact: {
      stagedPath: diagnostics.stagedArtifactPath,
      finalPath: diagnostics.fullArtifactPath
    }
  };
}

async function prepareArchiveSidecars(
  input: ArchiveSidecarBuildInput,
  diagnostics: Awaited<ReturnType<typeof buildDiagnosticsSidecar>>
) {
  const previous = await selectFullRunBaseline(input.layout, "public", {
    split: input.payload.split,
    policyShape: input.payload.policy_shape,
    simulateReport: input.payload.simulate_report,
    embeddingProvider: input.payload.embedding_provider
  });
  const diff = diffKpis(input.payload, previous);
  const comparison = await buildComparisonSidecar(input, diagnostics.currentEvidence);
  const runProvenanceSidecar = await buildLongMemEvalRunProvenanceSidecar({
    opts: input.opts,
    evaluatedCount: input.payload.evaluated_count,
    commitSha7: input.payload.alaya_commit,
    embeddingProviderLabel: input.payload.embedding_provider,
    env: process.env
  });
  const payload = KpiPayloadSchema.parse(
    withMeasurementAttribution(input, diagnostics, runProvenanceSidecar)
  );
  const attributedInput = { ...input, payload };
  const { report, findings } = buildRenderedArchiveDocuments(payload, previous, diff);
  const cohortLedger = renderLongMemEvalCohortLedger(
    diagnostics.persistedPayload.questions,
    input.failedQuestionIds
  );
  const evidenceManifest = buildArchiveEvidenceManifestSidecar({
    input: attributedInput,
    diagnostics,
    comparison,
    runProvenanceSidecar,
    report,
    findings,
    cohortLedger
  });
  return {
    payload,
    report,
    findings,
    comparison,
    runProvenanceSidecar,
    evidenceManifest,
    cohortLedger
  };
}

function withMeasurementAttribution(
  input: ArchiveSidecarBuildInput,
  diagnostics: Awaited<ReturnType<typeof buildDiagnosticsSidecar>>,
  provenanceSidecar: { readonly contents: string }
): KpiPayload {
  const provenance = LongMemEvalRunProvenanceSchema.parse(
    JSON.parse(provenanceSidecar.contents)
  );
  const candidatePoolComplete = input.failedQuestionIds.length === 0 &&
    diagnostics.persistedPayload.questions.every(
      (question) => question.candidate_pool_complete
    );
  const provenanceComplete = isLongMemEvalRunProvenanceGateEligible(provenance) &&
    isCacheOnlySeedExtractionPath(input.payload.kpi.seed_extraction_path);
  const abstention = input.payload.kpi.quality_metrics?.abstention;
  const attribution = buildBenchmarkMeasurementAttribution({
    candidatePoolComplete,
    provenanceComplete,
    abstention,
    noGoldCount: input.payload.kpi.quality_metrics?.no_gold_count,
    evaluatorIdentityIssueCount:
      input.payload.kpi.quality_metrics?.evaluator_identity_issue_count,
    evaluatorIdentityUnscorableCount:
      input.payload.kpi.quality_metrics?.evaluator_identity_unscorable_count
  });
  return { ...input.payload, measurement_attribution: attribution };
}

function buildRenderedArchiveDocuments(
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>
): { readonly report: string; readonly findings: string | null } {
  return {
    report: appendSeedExtractionReleaseBlockerToReport(
      renderReport(payload, previous, diff),
      payload
    ),
    findings: appendSeedExtractionReleaseBlockerToFindings(
      renderFindings(payload, diff),
      payload
    )
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
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<{
  readonly compact: string;
  readonly fullArtifactPath: string;
  readonly stagedArtifactPath: string;
  readonly fullArtifactIdentity: { readonly bytes: number; readonly sha256: string };
  readonly persistedPayload: LongMemEvalDiagnosticsSidecar;
  readonly currentEvidence: ReturnType<typeof buildCurrentEvidence>;
}> {
  const currentEvidence = buildCurrentEvidence(input);
  const diagnosticsPayload = buildDiagnosticsPayload(input, currentEvidence);
  const artifact = await writeFullDiagnosticsArtifact({
    historyRoot: input.opts.historyRoot,
    slug: input.slug,
    sidecar: diagnosticsPayload,
    diagnosticsSpool: input.diagnosticsSpool
  });
  return {
    compact: renderCompactDiagnosticsSidecar(
      diagnosticsPayload,
      `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
      { includeQuestions: true }
    ),
    fullArtifactPath: artifact.finalPath,
    stagedArtifactPath: artifact.stagedPath,
    fullArtifactIdentity: artifact.identity,
    persistedPayload: diagnosticsPayload,
    currentEvidence
  };
}

async function writeFullDiagnosticsArtifact(input: {
  readonly historyRoot: string;
  readonly slug: string;
  readonly sidecar: LongMemEvalDiagnosticsSidecar;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<{
  readonly finalPath: string;
  readonly stagedPath: string;
  readonly identity: { readonly bytes: number; readonly sha256: string };
}> {
  const artifactPath = path.join(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    "public",
    input.slug,
    `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`
  );
  const stagedPath = await prepareDiagnosticsArtifactStagingPath(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    `${input.slug}-${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`
  );
  const written = await input.diagnosticsSpool.writeGzipArtifact(
    stagedPath,
    input.sidecar
  );
  return {
    finalPath: artifactPath,
    stagedPath: written.artifactPath,
    identity: { bytes: written.bytes, sha256: written.sha256 }
  };
}

interface EvidenceManifestSidecarInput {
  readonly input: Parameters<typeof buildLongMemEvalArchiveSidecars>[0];
  readonly diagnostics: Awaited<ReturnType<typeof buildDiagnosticsSidecar>>;
  readonly comparison: string;
  readonly runProvenanceSidecar: { readonly filename: string; readonly contents: string };
  readonly report: string;
  readonly findings: string | null;
  readonly cohortLedger: string;
}

function buildArchiveEvidenceManifestSidecar(input: EvidenceManifestSidecarInput) {
  const provenance = LongMemEvalRunProvenanceSchema.parse(
    JSON.parse(input.runProvenanceSidecar.contents)
  );
  const questions = input.diagnostics.persistedPayload.questions;
  const cohortIdentity = JSON.parse(input.cohortLedger) as {
    readonly question_id_digest: string;
  };
  const datasetSha = input.input.payload.dataset.checksum_sha256;
  if (datasetSha === undefined) {
    throw new Error("LongMemEval evidence manifest requires dataset.checksum_sha256");
  }
  const manifest = buildLongMemEvalEvidenceManifest({
    run: {
      slug: input.input.slug,
      bench_name: "public",
      split: input.input.payload.split,
      run_at: input.input.payload.run_at,
      alaya_commit: input.input.payload.alaya_commit,
      dataset_sha256: datasetSha,
      selection_manifest_sha256: provenance.question_manifest?.file_sha256 ?? null,
      question_id_digest: cohortIdentity.question_id_digest,
      candidate_pool_complete: input.input.failedQuestionIds.length === 0 &&
        questions.every((row) => row.candidate_pool_complete),
      provenance_complete:
        input.input.payload.measurement_attribution?.provenance_complete === true
    },
    artifacts: buildEvidenceArtifacts(input)
  });
  return {
    filename: LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
    contents: renderLongMemEvalEvidenceManifest(manifest)
  };
}

function buildEvidenceArtifacts(
  input: EvidenceManifestSidecarInput
): LongMemEvalEvidenceArtifactInput[] {
  return [
    { role: "kpi", path: "kpi.json", contents: `${JSON.stringify(input.input.payload, null, 2)}\n` },
    { role: "report", path: "report.md", contents: input.report },
    ...(input.findings === null
      ? []
      : [{ role: "findings" as const, path: "findings.md", contents: input.findings }]),
    { role: "diagnostics", path: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: input.diagnostics.compact },
    {
      role: "full_diagnostics",
      path: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
      identity: input.diagnostics.fullArtifactIdentity
    },
    { role: "cohort_ledger", path: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: input.cohortLedger },
    { role: "comparison", path: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: input.comparison },
    { role: "run_provenance", path: input.runProvenanceSidecar.filename, contents: input.runProvenanceSidecar.contents }
  ];
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
): LongMemEvalDiagnosticsSidecar {
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
    ...(input.payload.kpi.seed_fuel_inventory === undefined
      ? {}
      : { seed_fuel_inventory: input.payload.kpi.seed_fuel_inventory }),
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
