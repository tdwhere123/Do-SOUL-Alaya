import {
  buildDiffVsPrevious,
  diffKpis,
  isHistoryEntryCommittedError,
  renderFindings,
  writeEntry,
  type HistoryLayout
} from "@do-soul/alaya-eval";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../../../harness/recall/recall-weight-overrides.js";
import { assembleRecallEvalKpi } from "../../recall-eval-kpi.js";
import { buildPerQuestionDelivered, buildRecallEvalArchiveSlug } from
  "../../kpi/recall-eval-archive.js";
import { selectRecallEvalBaseline } from "./recall-eval-archive-impl.js";
import { snapshotQuestionIdDigest } from "../../snapshot/materialize.js";
import { finalizeOwnedTempRoot } from "../owned-temp-root.js";
import {
  boundLifecycleFailure,
  renderLifecycleFailure,
  throwLifecycleErrors
} from "../errors.js";
import { buildRecallEvalArchiveBundle } from "../../provenance/recall-eval/recall-eval-archive-bundle.js";
import {
  RecallEvalDiagnosticsSpool
} from "../../provenance/recall-eval/recall-eval-diagnostics-spool.js";
import {
  buildRecallEvalRunProvenance,
  isRecallEvalRunEvidenceEligible
} from "../../provenance/recall-eval/recall-eval-run.js";
import { withPublishedDiagnosticsArtifact } from
  "../../measurement/artifact-transaction.js";
import {
  withRecallEvalMemoryProfile,
  type RecallEvalMemoryProfile
} from "../../measurement/recall-eval-memory-profile.js";
import {
  prepareRecallEvalRunContext,
  type RecallEvalRunContext
} from "./recall-eval-run-context.js";
import { renderRecallEvalReport } from "../../kpi/recall-eval-report.js";
import { recordedWorktreeIdentityForSlug } from "../../provenance/identity/history-code-slug.js";
import {
  disposeRecallEvalSelectionBoundaryArtifact,
  RECALL_EVAL_SELECTION_BOUNDARY_FILENAME,
  type RecallEvalSelectionBoundaryArtifact
} from "./recall-eval-selection-replay.js";
import type { RecallEvalOptions, RecallEvalQuestionResult, RecallEvalResult } from "./recall-eval-contract.js";
import { executeRecallEvalRun } from "./recall-eval-execute.js";
export type { RecallEvalOptions, RecallEvalQuestionResult, RecallEvalResult } from "./recall-eval-contract.js";

/** Run recall-only scoring against an integrity-checked working snapshot copy. */
export async function runRecallEval(
  options: RecallEvalOptions
): Promise<RecallEvalResult> {
  const recallWeightOverrides = resolveBenchRecallWeightOverrides({
    cliJson: options.weightOverridesJson,
    envJson: process.env[ALAYA_RECALL_WEIGHT_OVERRIDES_ENV]
  });
  if (recallWeightOverrides !== undefined) {
    process.stdout.write(
      `[recall-eval weights] ${formatBenchRecallWeightOverrides(recallWeightOverrides)}\n`
    );
  }

  const profiled = await withRecallEvalMemoryProfile({
    outputPath: process.env.ALAYA_RECALL_EVAL_MEMORY_PROFILE_PATH
  }, async (profile) => {
    await profile?.sample({ phase: "invocation_started" });
    return executeWithRecallEvalDiagnosticsSpool(
      options, recallWeightOverrides, profile
    );
  });
  return { ...profiled.value, memoryProfile: profiled.completion };
}

async function executeWithRecallEvalDiagnosticsSpool(
  options: RecallEvalOptions,
  recallWeightOverrides: ReturnType<typeof resolveBenchRecallWeightOverrides>,
  profile: RecallEvalMemoryProfile | null
): Promise<RecallEvalResult> {
  const diagnosticsSpool = await RecallEvalDiagnosticsSpool.create();
  let result: RecallEvalResult | undefined;
  let primaryError: unknown;
  try {
    const context = await prepareRecallEvalRunContext(
      options, recallWeightOverrides, process.env, profile
    );
    result = await executeManagedRecallEval(context, diagnosticsSpool);
  } catch (error) {
    primaryError = error;
  }
  const cleanupError = await captureCleanupError(() => diagnosticsSpool.dispose());
  if (result === undefined) {
    throwLifecycleErrors("recall-eval diagnostics lifecycle failed", [
      primaryError, cleanupError
    ]);
    throw new Error("recall-eval diagnostics lifecycle lost its failure");
  }
  if (cleanupError !== undefined) {
    result = appendCompletionFailure(result, "diagnostics_spool_cleanup", cleanupError);
  }
  await sampleRecallEvalMemoryAfterCommit(profile, "cleanup_complete");
  return result;
}

async function executeManagedRecallEval(
  context: RecallEvalRunContext,
  diagnosticsSpool: RecallEvalDiagnosticsSpool
): Promise<RecallEvalResult> {
  let result: RecallEvalResult | undefined;
  let selectionArtifact: RecallEvalSelectionBoundaryArtifact | null = null;
  let primaryError: unknown;
  try {
    await context.memoryProfile?.sample({ phase: "snapshot_restored" });
    const ran = await executeRecallEvalRun(context, diagnosticsSpool);
    selectionArtifact = ran.selectionArtifact;
    result = await writeRecallEvalArtifacts(
      withPagerRebuildReport(context, ran.evidenceProjectionRebuild),
      diagnosticsSpool, ran.collected, selectionArtifact
    );
  } catch (error) {
    primaryError = error;
  }
  const dataRootError = await captureCleanupError(() => finalizeOwnedTempRoot(
    { path: context.dataDirRoot, owned: context.ownsDataDirRoot },
    result !== undefined
  ));
  const selectionError = await captureCleanupError(async () => {
    const cleanups = await Promise.allSettled([
      context.selectionBoundarySpool?.dispose(),
      disposeRecallEvalSelectionBoundaryArtifact(selectionArtifact)
    ]);
    const failures = cleanups.flatMap((cleanup) =>
      cleanup.status === "rejected" ? [cleanup.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "selection replay cleanup failed");
    }
  });
  if (result === undefined) {
    throwLifecycleErrors("recall-eval lifecycle failed", [
      primaryError, dataRootError, selectionError
    ]);
    throw new Error("recall-eval produced no result");
  }
  if (dataRootError !== undefined) {
    result = appendCompletionFailure(result, "data_root_cleanup", dataRootError);
  }
  if (selectionError !== undefined) {
    result = appendCompletionFailure(result, "selection_spool_cleanup", selectionError);
  }
  return result;
}

async function writeRecallEvalArtifacts(
  context: RecallEvalRunContext,
  diagnosticsSpool: RecallEvalDiagnosticsSpool,
  collected: readonly RecallEvalQuestionResult[],
  selectionArtifact: RecallEvalSelectionBoundaryArtifact | null
): Promise<RecallEvalResult> {
  await context.memoryProfile?.sample({ phase: "before_kpi" });
  const prepared = await prepareRecallEvalArtifacts(context, collected);
  await context.memoryProfile?.sample({ phase: "after_kpi" });
  return persistRecallEvalArtifacts(
    { ...context, runtimeAttribution: prepared.runtimeAttribution },
    diagnosticsSpool,
    collected,
    prepared,
    selectionArtifact
  );
}

async function prepareRecallEvalArtifacts(
  context: RecallEvalRunContext,
  collected: readonly RecallEvalQuestionResult[]
) {
  const offset = context.options.offset ?? 0;
  const limit = context.options.limit ?? null;
  const expectedQuestionIdDigest = snapshotQuestionIdDigest(context.window);
  const actualQuestionIdDigest = snapshotQuestionIdDigest(collected);
  const runtimeAttribution = {
    ...context.runtimeAttribution,
    evaluation_slice: {
      offset, limit, evaluated_count: collected.length,
      question_id_digest: actualQuestionIdDigest
    }
  };
  const runProvenance = await buildRecallEvalRunProvenance({
    manifest: context.manifest, runtimeAttribution,
    evaluatedCount: collected.length, offset, limit,
    commitSha7: context.commitSha7, env: context.daemonLaunch.environment,
    extractionAuthority: context.extractionAuthority
  });
  const provenanceComplete = isRecallEvalRunEvidenceEligible({
    runtimeAttribution, provenance: runProvenance,
    expectedQuestionIdDigest, actualQuestionIdDigest,
    evaluatedCount: collected.length, offset, limit
  });
  const payload = assembleRecallEvalKpi({
    collected, manifest: context.manifest, variant: context.options.variant,
    runAt: context.runAt, commitSha7: context.commitSha7,
    alayaVersion: context.alayaVersion, policyShape: context.policyShape,
    simulateReport: context.simulateReport,
    sampleSize: context.sidecarQuestionCount,
    evaluatedCount: collected.length,
    recallWeightOverrides: context.recallWeightOverrides,
    embeddingProviderLabel: context.runtimeAttribution.embedding_provider_label,
    runtimeAttribution,
    datasetSha256: context.datasetSha256,
    provenanceComplete
  });
  const layout: HistoryLayout = { historyRoot: context.options.historyRoot };
  const previous = await selectRecallEvalBaseline(layout, "public", payload);
  const diff = diffKpis(payload, previous);
  payload.diff_vs_previous = buildDiffVsPrevious(payload, previous, previous?.run_at ?? "");
  return {
    runtimeAttribution, layout, payload, previous, diff,
    evidence: { runProvenance, expectedQuestionIdDigest, provenanceComplete }
  };
}

async function persistRecallEvalArtifacts(
  context: RecallEvalRunContext,
  diagnosticsSpool: RecallEvalDiagnosticsSpool,
  collected: readonly RecallEvalQuestionResult[],
  prepared: Awaited<ReturnType<typeof prepareRecallEvalArtifacts>>,
  selectionArtifact: RecallEvalSelectionBoundaryArtifact | null
): Promise<RecallEvalResult> {
  const { slug, report, findings, bundle } = await stageRecallEvalArtifacts(
    context, diagnosticsSpool, collected, prepared, selectionArtifact
  );
  const entry = await withPublishedDiagnosticsArtifact(
    bundle.diagnosticsArtifact,
    async () => {
      await context.memoryProfile?.sample({ phase: "archive_staged" });
      return writeEntry(
        prepared.layout, "public", slug, prepared.payload, report, findings, {
          sidecars: bundle.sidecars,
          fileSidecars: buildRecallEvalFileSidecars(bundle, selectionArtifact)
        }
      );
    },
    isHistoryEntryCommittedError
  );
  await sampleRecallEvalMemoryAfterCommit(context.memoryProfile, "archive_complete");
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    payload: prepared.payload,
    snapshotManifest: context.manifest,
    perQuestionDelivered: buildPerQuestionDelivered(collected),
    completion: { status: "complete", failures: [] },
    memoryProfile: { status: "disabled", failures: [] },
    ...(context.derivedEvidenceProjectionRebuild === null
      ? {}
      : { derivedEvidenceProjectionRebuild: context.derivedEvidenceProjectionRebuild })
  };
}

async function sampleRecallEvalMemoryAfterCommit(
  profile: RecallEvalMemoryProfile | null,
  phase: "archive_complete" | "cleanup_complete"
): Promise<void> {
  try {
    await profile?.sample({ phase });
  } catch (error) {
    const failure = profile?.markIncomplete(phase, error) ??
      boundLifecycleFailure(phase, error);
    process.stderr.write(
      `[recall-eval memory-profile] incomplete ${renderLifecycleFailure(failure)}\n`
    );
  }
}

async function captureCleanupError(cleanup: () => Promise<void>): Promise<unknown> {
  try {
    await cleanup();
    return undefined;
  } catch (error) {
    return error;
  }
}

function appendCompletionFailure(
  result: RecallEvalResult,
  phase: string,
  error: unknown
): RecallEvalResult {
  const failures = [
    ...result.completion.failures,
    boundLifecycleFailure(phase, error)
  ].slice(0, 8);
  return { ...result, completion: { status: "incomplete", failures } };
}

async function stageRecallEvalArtifacts(
  context: RecallEvalRunContext,
  diagnosticsSpool: RecallEvalDiagnosticsSpool,
  collected: readonly RecallEvalQuestionResult[],
  prepared: Awaited<ReturnType<typeof prepareRecallEvalArtifacts>>,
  selectionArtifact: RecallEvalSelectionBoundaryArtifact | null
) {
  const slug = buildRecallEvalArchiveSlug({
    ...context,
    ...recordedWorktreeIdentityForSlug(prepared.evidence.runProvenance.code)
  });
  const report = renderRecallEvalReport(
    prepared.payload, prepared.previous, prepared.diff
  );
  const findings = renderFindings(prepared.payload, prepared.diff);
  const bundle = await buildRecallEvalArchiveBundle({
    slug,
    historyRoot: prepared.layout.historyRoot,
    payload: prepared.payload,
    report,
    findings,
    collected,
    diagnosticsSpool,
    manifest: context.manifest,
    runtimeAttribution: context.runtimeAttribution,
    offset: context.options.offset ?? 0,
    limit: context.options.limit ?? null,
    runProvenance: prepared.evidence.runProvenance,
    expectedQuestionIdDigest: prepared.evidence.expectedQuestionIdDigest,
    provenanceComplete: prepared.evidence.provenanceComplete,
    ...(context.derivedEvidenceProjectionRebuild === null
      ? {}
      : {
          derivedEvidenceProjectionRebuild:
            context.derivedEvidenceProjectionRebuild
        }),
    ...(context.warmDerivedSnapshot === null
      ? {}
      : { warmDerivedSnapshot: context.warmDerivedSnapshot }),
    ...(selectionArtifact === null
      ? {}
      : { selectionBoundary: selectionArtifact.binding })
  });
  return { slug, report, findings, bundle };
}

function buildRecallEvalFileSidecars(
  bundle: Awaited<ReturnType<typeof buildRecallEvalArchiveBundle>>,
  selectionArtifact: RecallEvalSelectionBoundaryArtifact | null
) {
  return [{
    filename: bundle.diagnosticsFilename,
    sourcePath: bundle.diagnosticsArtifact.finalPath,
    identity: bundle.diagnosticsArtifact.identity
  }, ...(selectionArtifact === null ? [] : [{
    filename: RECALL_EVAL_SELECTION_BOUNDARY_FILENAME,
    sourcePath: selectionArtifact.sourcePath,
    identity: {
      sha256: selectionArtifact.binding.sha256,
      bytes: selectionArtifact.binding.bytes
    }
  }])];
}

function withPagerRebuildReport(
  context: RecallEvalRunContext,
  evidenceProjectionRebuild: unknown
): RecallEvalRunContext {
  if (evidenceProjectionRebuild === null || evidenceProjectionRebuild === undefined) {
    return context;
  }
  return {
    ...context,
    derivedEvidenceProjectionRebuild:
      evidenceProjectionRebuild as RecallEvalRunContext["derivedEvidenceProjectionRebuild"]
  };
}
