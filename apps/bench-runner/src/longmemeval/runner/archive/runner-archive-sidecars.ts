import {
  diffKpis,
  renderFindings,
  renderReport,
  KpiPayloadSchema,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { rm } from "node:fs/promises";
import {
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  renderLongMemEvalColdWarmComparisonSidecar
} from "../../../bench/archive/archive-evidence.js";
import { selectFullRunBaseline } from "../../../bench/lifecycle/recall-eval/recall-eval-archive-impl.js";
import { appendSeedExtractionReleaseBlockerToFindings, appendSeedExtractionReleaseBlockerToReport } from "../../../bench/extraction/seed-fuel/seed-extraction-release-blocker.js";
import type { BenchCommitInfo } from "../runner-helpers.js";
import type { LongMemEvalRunOptions } from "../../runner.js";
import type { LongMemEvalRunArchiveAggregate } from "./runner-archive-aggregate.js";
import type { LongMemEvalPayloadBuild } from "./runner-archive-payload.js";
import { buildArchiveRunProvenanceBundle } from
  "../../../bench/provenance/archive/archive-run-provenance.js";
import { freezeGitStateMeasurement } from "../../../bench/provenance/identity/archive-git-identity.js";
import type { MeasuredGitState } from "../../../bench/provenance/contract/frozen-code-contract.js";
import {
  LONGMEMEVAL_COHORT_LEDGER_FILENAME,
  renderLongMemEvalCohortLedger
} from "../../../bench/selection/cohort-ledger.js";
import type { LongMemEvalDiagnosticsSpool } from "../../../bench/diagnostics/spool.js";
import { withCurrentMeasurementAttribution } from "../../../bench/measurement/archive-attribution.js";
import type { StagedDiagnosticsArtifact } from "../../../bench/measurement/artifact-transaction.js";
import {
  selectionContractIdentity,
  type LongMemEvalSelectionContract
} from "../../../bench/selection/contract.js";
import { buildArchiveEvidenceManifestSidecar } from
  "../../../bench/provenance/archive/archive-evidence-sidecar.js";
import type { EffectiveReconciliationBasis } from "@do-soul/alaya";
import {
  buildDiagnosticsSidecar
} from "./runner-archive-diagnostics.js";

type ArchiveSidecarBuildInput = Readonly<{
  readonly opts: LongMemEvalRunOptions;
  readonly datasetSha256: string;
  readonly selectionContract: LongMemEvalSelectionContract;
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly build: LongMemEvalPayloadBuild;
  readonly commitInfo: BenchCommitInfo;
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly reconciliationBasis?: EffectiveReconciliationBasis;
  readonly collectedLength: number;
  readonly payload: KpiPayload;
  readonly layout: HistoryLayout;
  readonly slug: string;
  readonly recordedGitState: MeasuredGitState;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}>;

export type ArchiveSidecarBuildResult = Readonly<{
  readonly payload: KpiPayload;
  readonly report: string;
  readonly findings: string | null;
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
  readonly diagnosticsArtifact: StagedDiagnosticsArtifact;
}>;

export async function buildLongMemEvalArchiveSidecars(
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
    selection: selectionContractIdentity(input.selectionContract),
    recordedGitState: input.recordedGitState,
    measureGitState: freezeGitStateMeasurement(input.recordedGitState),
    ...(input.reconciliationBasis === undefined
      ? {}
      : { reconciliationBasis: input.reconciliationBasis })
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

async function buildComparisonSidecar(
  input: {
    readonly layout: HistoryLayout;
    readonly payload: KpiPayload;
    readonly slug: string;
  },
  currentEvidence: Awaited<ReturnType<typeof buildDiagnosticsSidecar>>["currentEvidence"]
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
