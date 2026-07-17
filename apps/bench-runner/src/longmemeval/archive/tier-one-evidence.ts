import { rm } from "node:fs/promises";
import path from "node:path";
import {
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  isHistoryEntryCommittedError,
  KpiPayloadSchema,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type BenchName,
  type HistoryLayout,
  type KpiPayload,
  type VerifiedLongMemEvalEvidenceContext
} from "@do-soul/alaya-eval";
import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";
import {
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  renderLongMemEvalColdWarmComparisonSidecar
} from "./archive-evidence.js";
import {
  LONGMEMEVAL_COHORT_LEDGER_FILENAME,
  renderLongMemEvalCohortLedger
} from "../selection/cohort-ledger.js";
import {
  renderCompactDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects,
  summarizeProviderStates,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalQuestionDiagnostic
} from "../diagnostics.js";
import { resolveBenchDiagnosticsArtifactRoot } from "../diagnostics/artifacts/diagnostics-artifacts.js";
import { writeDiagnosticsGzipStream } from "../diagnostics/artifacts/artifact-gzip-stream.js";
import { withCurrentMeasurementAttribution } from "../measurement/archive-attribution.js";
import {
  createLongMemEvalHistoryLayout,
  resolveLongMemEvalEvidenceContext
} from "../history/evidence-context.js";
import {
  prepareDiagnosticsArtifactStagingPath,
  withPublishedDiagnosticsArtifact,
  type StagedDiagnosticsArtifact
} from "../measurement/artifact-transaction.js";
import { buildArchiveEvidenceManifestSidecar } from
  "../provenance/archive/archive-evidence-sidecar.js";
import { buildLongMemEvalRunProvenanceSidecar } from "../provenance/run.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import type { LongMemEvalSelectionContract } from "../selection/contract.js";
import { selectionContractIdentity } from "../selection/contract.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "../extraction/seed-fuel/seed-extraction-release-blocker.js";

type TierOneLongMemEvalBenchName = Extract<
  BenchName,
  "public-multiturn" | "public-crossquestion"
>;

export interface TierOneLongMemEvalArchiveInput {
  readonly benchName: TierOneLongMemEvalBenchName;
  readonly opts: LongMemEvalRunOptions;
  readonly datasetSha256: string;
  readonly datasetChecksumSource: string;
  readonly datasetSourcePath: string;
  readonly releaseEvidenceAuthority: LongMemEvalReleaseEvidenceAuthority | null;
  readonly selectionContract: LongMemEvalSelectionContract;
  readonly payload: KpiPayload;
  readonly diagnosticsPayload: LongMemEvalDiagnosticsSidecar;
  readonly releaseDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly commitSha7: string;
  readonly embeddingProviderLabel: string;
  readonly runAt: Date;
}

export interface TierOneLongMemEvalArchiveResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
  readonly evidenceContext: VerifiedLongMemEvalEvidenceContext | null;
}

export interface TierOneLongMemEvalHistoryAuthority {
  readonly historyRoot: string;
  readonly releaseEvidenceAuthority: LongMemEvalReleaseEvidenceAuthority | null;
}

export async function writeTierOneLongMemEvalArchive(
  input: TierOneLongMemEvalArchiveInput
): Promise<TierOneLongMemEvalArchiveResult> {
  if (input.payload.bench_name !== input.benchName) {
    throw new Error("Tier 1 archive bench identity does not match its pointer tree");
  }
  const layout = createTierOneLongMemEvalHistoryLayout({
    historyRoot: input.opts.historyRoot,
    releaseEvidenceAuthority: input.releaseEvidenceAuthority
  });
  const previous = await readLatest(layout, input.benchName, {
    split: input.payload.split,
    policyShape: input.payload.policy_shape,
    simulateReport: input.payload.simulate_report,
    embeddingProvider: input.payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(input.payload, previous);
  const payload = KpiPayloadSchema.parse({
    ...input.payload,
    diff_vs_previous: buildDiffVsPrevious(
      input.payload,
      previous,
      previous?.run_at ?? ""
    )
  });
  const slug = entrySlug(input.runAt, input.commitSha7);
  const prepared = await prepareTierOneArchive(input, slug, payload, previous, diff);
  const entry = await publishTierOneArchive(input, layout, slug, prepared);
  const evidenceContext = await resolvePostWriteEvidenceContext(
    layout,
    entry.kpiPath,
    prepared.payload
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload: prepared.payload,
    evidenceContext
  };
}

export function createTierOneLongMemEvalHistoryLayout(
  input: TierOneLongMemEvalHistoryAuthority
): HistoryLayout {
  return createLongMemEvalHistoryLayout({
    historyRoot: input.historyRoot,
    authority: input.releaseEvidenceAuthority
  });
}

async function resolvePostWriteEvidenceContext(
  layout: HistoryLayout,
  kpiPath: string,
  payload: KpiPayload
): Promise<VerifiedLongMemEvalEvidenceContext | null> {
  return resolveLongMemEvalEvidenceContext(layout, path.dirname(kpiPath), payload);
}

interface PreparedTierOneArchive {
  readonly payload: KpiPayload;
  readonly report: string;
  readonly findings: string | null;
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
  readonly diagnosticsArtifact: StagedDiagnosticsArtifact;
}

async function prepareTierOneArchive(
  input: TierOneLongMemEvalArchiveInput,
  slug: string,
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>
): Promise<PreparedTierOneArchive> {
  const diagnostics = buildEvidenceDiagnostics(input, payload);
  const artifact = await stageDiagnosticsArtifact(input, slug, diagnostics);
  try {
    const documents = await buildTierOneDocuments(
      input,
      slug,
      payload,
      previous,
      diff,
      diagnostics,
      artifact
    );
    return { ...documents, diagnosticsArtifact: artifact };
  } catch (error) {
    await rm(artifact.stagedPath, { force: true });
    throw error;
  }
}

async function buildTierOneDocuments(
  input: TierOneLongMemEvalArchiveInput,
  slug: string,
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>,
  diagnostics: LongMemEvalDiagnosticsSidecar,
  artifact: StagedDiagnosticsArtifact & { readonly identity: ArtifactIdentity }
) {
  const evidence = await assembleTierOneEvidence(
    input,
    slug,
    payload,
    previous,
    diff,
    diagnostics
  );
  const evidenceManifest = buildTierOneEvidenceManifest(
    slug,
    diagnostics,
    artifact.identity,
    evidence
  );
  return {
    payload: evidence.payload,
    report: evidence.report,
    findings: evidence.findings,
    sidecars: [
      { filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: evidence.compact },
      { filename: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: evidence.cohortLedger },
      { filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: evidence.comparison },
      evidence.provenance,
      evidenceManifest
    ]
  };
}

async function assembleTierOneEvidence(
  input: TierOneLongMemEvalArchiveInput,
  slug: string,
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>,
  diagnostics: LongMemEvalDiagnosticsSidecar
) {
  const provenance = await buildLongMemEvalRunProvenanceSidecar({
    opts: input.opts,
    evaluatedCount: payload.evaluated_count,
    commitSha7: input.commitSha7,
    embeddingProviderLabel: input.embeddingProviderLabel,
    env: process.env,
    datasetSha256: input.datasetSha256,
    selection: selectionContractIdentity(input.selectionContract)
  });
  const attributed = KpiPayloadSchema.parse(withCurrentMeasurementAttribution({
    payload,
    failedQuestionIds: [],
    diagnostics: input.releaseDiagnostics,
    provenanceContents: provenance.contents
  }));
  const report = buildTierOneReport(attributed, previous, diff);
  const findings = buildTierOneFindings(attributed, diff);
  const cohortLedger = renderLongMemEvalCohortLedger(
    input.releaseDiagnostics,
    [],
    input.selectionContract
  );
  const comparison = buildTierOneComparison(slug, attributed, diagnostics);
  const compact = renderCompactDiagnosticsSidecar(
    diagnostics,
    `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
    { includeQuestions: true }
  );
  return {
    payload: attributed,
    report,
    findings,
    cohortLedger,
    comparison,
    compact,
    provenance
  };
}

function buildTierOneEvidenceManifest(
  slug: string,
  diagnostics: LongMemEvalDiagnosticsSidecar,
  fullArtifactIdentity: ArtifactIdentity,
  evidence: Awaited<ReturnType<typeof assembleTierOneEvidence>>
) {
  return buildArchiveEvidenceManifestSidecar({
    slug,
    payload: evidence.payload,
    failedQuestionIds: [],
    diagnostics: {
      compact: evidence.compact,
      fullArtifactIdentity,
      persistedPayload: diagnostics
    },
    comparison: evidence.comparison,
    runProvenanceSidecar: evidence.provenance,
    report: evidence.report,
    findings: evidence.findings,
    cohortLedger: evidence.cohortLedger
  });
}

function buildEvidenceDiagnostics(
  input: TierOneLongMemEvalArchiveInput,
  payload: KpiPayload
): LongMemEvalDiagnosticsSidecar {
  return {
    ...input.diagnosticsPayload,
    policy_shape: payload.policy_shape,
    simulate_report: payload.simulate_report,
    provider_state_summary: summarizeProviderStates(input.releaseDiagnostics),
    report_side_effects: summarizeLongMemEvalReportSideEffects({
      mode: payload.simulate_report,
      snapshots: []
    }),
    scored_recall_evidence: summarizeLongMemEvalRecallEvidence(
      input.releaseDiagnostics
    ),
    questions: input.releaseDiagnostics
  };
}

function buildTierOneComparison(
  slug: string,
  payload: KpiPayload,
  diagnostics: LongMemEvalDiagnosticsSidecar
): string {
  return renderLongMemEvalColdWarmComparisonSidecar(
    buildLongMemEvalColdWarmComparisonSidecar({
      currentSlug: slug,
      current: payload,
      currentEvidence: {
        report_side_effects: diagnostics.report_side_effects!,
        scored_recall_evidence: diagnostics.scored_recall_evidence!
      },
      opposite: null
    })
  );
}

async function stageDiagnosticsArtifact(
  input: TierOneLongMemEvalArchiveInput,
  slug: string,
  diagnostics: LongMemEvalDiagnosticsSidecar
): Promise<StagedDiagnosticsArtifact & { readonly identity: ArtifactIdentity }> {
  const artifactRoot = resolveBenchDiagnosticsArtifactRoot(input.opts.historyRoot);
  const filename = `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`;
  const stagedPath = await prepareDiagnosticsArtifactStagingPath(
    artifactRoot,
    `${input.benchName}-${slug}-${filename}`
  );
  const identity = await writeDiagnosticsGzipStream(stagedPath, diagnostics);
  return {
    stagedPath,
    finalPath: path.join(artifactRoot, input.benchName, slug, filename),
    identity
  };
}

async function publishTierOneArchive(
  input: TierOneLongMemEvalArchiveInput,
  layout: HistoryLayout,
  slug: string,
  prepared: PreparedTierOneArchive
) {
  return withPublishedDiagnosticsArtifact(
    prepared.diagnosticsArtifact,
    () => writeEntry(
      layout,
      input.benchName,
      slug,
      prepared.payload,
      prepared.report,
      prepared.findings,
      {
        sidecars: prepared.sidecars,
        fileSidecars: [{
          filename: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
          sourcePath: prepared.diagnosticsArtifact.finalPath
        }]
      }
    ),
    isHistoryEntryCommittedError
  );
}

function buildTierOneReport(
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>
): string {
  return appendSeedExtractionReleaseBlockerToReport(
    renderReport(payload, previous, diff),
    payload
  );
}

function buildTierOneFindings(
  payload: KpiPayload,
  diff: ReturnType<typeof diffKpis>
): string | null {
  return appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(payload, diff),
    payload
  );
}

interface ArtifactIdentity {
  readonly bytes: number;
  readonly sha256: string;
}
