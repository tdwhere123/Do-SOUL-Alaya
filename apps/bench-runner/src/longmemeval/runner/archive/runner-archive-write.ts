import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  renderFindings,
  renderReport,
  writeEntry,
  isHistoryEntryCommittedError,
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
} from "../../diagnostics.js";
import {
  resolveBenchDiagnosticsArtifactRoot
} from "../../diagnostics/artifacts/diagnostics-artifacts.js";
import path from "node:path";
import {
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  renderLongMemEvalColdWarmComparisonSidecar
} from "../../archive/archive-evidence.js";
import { selectFullRunBaseline } from "../../lifecycle/recall-eval/recall-eval-archive-impl.js";
import { appendSeedExtractionReleaseBlockerToFindings, appendSeedExtractionReleaseBlockerToReport } from "../../extraction/seed-fuel/seed-extraction-release-blocker.js";
import type { BenchCommitInfo } from "../runner-helpers.js";
import type { LongMemEvalRunOptions, LongMemEvalRunResult } from "../../runner.js";
import type { LongMemEvalRunArchiveAggregate } from "./runner-archive-aggregate.js";
import type { LongMemEvalPayloadBuild } from "./runner-archive-payload.js";
import { buildArchiveRunProvenanceBundle } from
  "../../provenance/archive/archive-run-provenance.js";
import {
  LONGMEMEVAL_COHORT_LEDGER_FILENAME,
  renderLongMemEvalCohortLedger
} from "../../selection/cohort-ledger.js";
import type { LongMemEvalDiagnosticsSpool } from "../../diagnostics/spool.js";
import { withCurrentMeasurementAttribution } from "../../measurement/archive-attribution.js";
import {
  prepareDiagnosticsArtifactStagingPath,
  withPublishedDiagnosticsArtifact,
  type StagedDiagnosticsArtifact
} from "../../measurement/artifact-transaction.js";
import {
  selectionContractIdentity,
  type LongMemEvalSelectionContract
} from "../../selection/contract.js";
import { buildArchiveEvidenceManifestSidecar } from
  "../../provenance/archive/archive-evidence-sidecar.js";
import {
  createLongMemEvalHistoryLayout,
  resolveLongMemEvalEvidenceContext
} from "../../history/evidence-context.js";
import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";

export async function writeLongMemEvalRunArchive(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly datasetSha256: string;
  readonly datasetSourcePath: string;
  readonly datasetChecksumSource: string;
  readonly releaseEvidenceAuthority: LongMemEvalReleaseEvidenceAuthority | null;
  readonly selectionContract: LongMemEvalSelectionContract;
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
  const layout = createLongMemEvalHistoryLayout({
    historyRoot: input.opts.historyRoot,
    authority: input.releaseEvidenceAuthority
  });
  const payload = await withLongMemEvalDiff(layout, input.build.payload);
  const slug = entrySlug(
    input.runAt,
    input.commitSha7,
    benchArchiveDiscriminator(payload.policy_shape, payload.simulate_report)
  );
  const sidecars = await buildLongMemEvalArchiveSidecars({ ...input, payload, layout, slug });
  const entry = await publishLongMemEvalArchiveEntry(layout, slug, sidecars);
  const evidenceContext = await resolveLongMemEvalEvidenceContext(
    layout,
    path.dirname(entry.kpiPath),
    sidecars.payload
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload: sidecars.payload,
    evidenceContext
  };
}

async function publishLongMemEvalArchiveEntry(
  layout: HistoryLayout,
  slug: string,
  sidecars: ArchiveSidecarBuildResult
) {
  return withPublishedDiagnosticsArtifact(
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
  readonly datasetSha256: string;
  readonly selectionContract: LongMemEvalSelectionContract;
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
      prepared.runProvenance.sidecar,
      ...(prepared.runProvenance.authorityReferenceSidecar === null
        ? []
        : [prepared.runProvenance.authorityReferenceSidecar]),
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
  const runProvenance = await buildArchiveRunProvenance(input);
  const payload = KpiPayloadSchema.parse(
    withCurrentMeasurementAttribution({
      payload: input.payload,
      failedQuestionIds: input.failedQuestionIds,
      diagnostics: diagnostics.persistedPayload.questions,
      provenanceContents: runProvenance.fullContents
    })
  );
  return buildPreparedArchiveSidecars({
    input, diagnostics, previous, diff, comparison, runProvenance, payload
  });
}

function buildPreparedArchiveSidecars(input: {
  readonly input: ArchiveSidecarBuildInput;
  readonly diagnostics: Awaited<ReturnType<typeof buildDiagnosticsSidecar>>;
  readonly previous: KpiPayload | null;
  readonly diff: ReturnType<typeof diffKpis>;
  readonly comparison: Awaited<ReturnType<typeof buildComparisonSidecar>>;
  readonly runProvenance: Awaited<ReturnType<typeof buildArchiveRunProvenance>>;
  readonly payload: KpiPayload;
}) {
  const attributedInput = { ...input.input, payload: input.payload };
  const { report, findings } = buildRenderedArchiveDocuments(
    input.payload,
    input.previous,
    input.diff
  );
  const cohortLedger = renderLongMemEvalCohortLedger(
    input.diagnostics.persistedPayload.questions,
    input.input.failedQuestionIds,
    input.input.selectionContract
  );
  const evidenceManifest = buildArchiveEvidenceManifestSidecar({
    slug: attributedInput.slug,
    payload: attributedInput.payload,
    failedQuestionIds: attributedInput.failedQuestionIds,
    diagnostics: input.diagnostics,
    comparison: input.comparison,
    runProvenanceSidecar: input.runProvenance.sidecar,
    boundRunProvenance: input.runProvenance.full,
    authorityReferenceSidecar: input.runProvenance.authorityReferenceSidecar,
    report,
    findings,
    cohortLedger
  });
  return {
    payload: input.payload,
    report,
    findings,
    comparison: input.comparison,
    runProvenance: input.runProvenance,
    evidenceManifest,
    cohortLedger
  };
}

function buildArchiveRunProvenance(input: ArchiveSidecarBuildInput) {
  return buildArchiveRunProvenanceBundle({
    opts: input.opts,
    evaluatedCount: input.payload.evaluated_count,
    commitSha7: input.payload.alaya_commit,
    embeddingProviderLabel: input.payload.embedding_provider,
    env: process.env,
    datasetSha256: input.datasetSha256,
    selection: selectionContractIdentity(input.selectionContract)
  });
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
