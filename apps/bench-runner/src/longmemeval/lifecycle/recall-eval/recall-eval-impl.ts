import {
  buildDiffVsPrevious,
  diffKpis,
  isHistoryEntryCommittedError,
  renderFindings,
  writeEntry,
  type BenchSimulateReportMode,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchEmbeddingMode,
  type BenchRecallOptions,
  type BenchWorkspaceHandle
} from "../../../harness/daemon.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../../../harness/recall/recall-weight-overrides.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  type LongMemEvalQuestionDiagnostic
} from "../../diagnostics.js";
import { isAbstentionQuestionId } from "../../diagnostics/abstention.js";
import { assembleRecallEvalKpi } from "../../recall-eval-kpi.js";
import { attachQuestionMeasurementAxes } from "../../diagnostics/diagnostics-measurement-axes.js";
import { buildGoldObjectIdentities } from
  "../../diagnostics/gold-object-identities.js";
import { buildPerQuestionDelivered, buildRecallEvalArchiveSlug } from
  "../../kpi/recall-eval-archive.js";
import { selectRecallEvalBaseline } from "./recall-eval-archive-impl.js";
import { extractRecallTokenEconomy } from "../../qa/recall-token-economy.js";
import { runLongMemEvalRecallCycle } from "../../runner.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldEvidenceIds,
  deriveLongMemEvalGoldMemoryIds,
  deriveLongMemEvalGoldObjectIds,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalSidecarEntry
} from "../../runner.js";
import type { LongMemEvalGoldObjectIdentity } from
  "../../diagnostics/gold-object-identities.js";
import {
  snapshotQuestionIdDigest,
  type LongMemEvalSnapshotQuestion
} from "../../snapshot/materialize.js";
import { finalizeOwnedTempRoot } from "../owned-temp-root.js";
import { throwLifecycleErrors } from "../errors.js";
import { writeRecallEvalProgress } from "./recall-eval-progress.js";
import { buildRecallEvalArchiveBundle } from "../../provenance/recall-eval/recall-eval-archive-bundle.js";
import {
  buildRecallEvalRunProvenance,
  isRecallEvalRunEvidenceEligible
} from "../../provenance/recall-eval/recall-eval-run.js";
import { writeRecallEvalPoolDump } from "../../provenance/recall-eval/recall-eval-pool-dump.js";
import { withPublishedDiagnosticsArtifact } from
  "../../measurement/artifact-transaction.js";
import { requireLongMemEvalTimestamp } from "../../ingestion/source-time.js";
import {
  prepareRecallEvalRunContext,
  type RecallEvalRunContext
} from "./recall-eval-run-context.js";
import { renderRecallEvalReport } from "../../kpi/recall-eval-report.js";
import {
  captureRecallEvalQuestion,
  finalizeRecallEvalSelectionBoundarySpool,
  RECALL_EVAL_SELECTION_BOUNDARY_FILENAME,
  type RecallEvalSelectionBoundaryArtifact
} from "./recall-eval-selection-replay.js";
import { warmLongMemEvalEmbeddingCaches } from "../../provenance/embedding/embedding-cache-warmup.js";
import { deriveLongMemEvalMemoryObjectIds } from "../../runner/runner-helpers.js";
import type { SnapshotQuestionMeasurementOracle } from
  "../../snapshot/measurement-oracle.js";
import type { RecallEvalOptions, RecallEvalQuestionResult, RecallEvalResult } from "./recall-eval-contract.js";
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

  const context = await prepareRecallEvalRunContext(options, recallWeightOverrides);
  let succeeded = false;
  let result: RecallEvalResult | undefined;
  let primaryError: unknown;
  try {
    const collected = await executeRecallEvalRun(context);
    const selectionArtifact =
      await finalizeRecallEvalSelectionBoundarySpool(context.selectionBoundarySpool);
    result = await writeRecallEvalArtifacts(context, collected, selectionArtifact);
    succeeded = true;
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await Promise.all([
      finalizeOwnedTempRoot(
        { path: context.dataDirRoot, owned: context.ownsDataDirRoot },
        succeeded
      ),
      context.selectionBoundarySpool?.dispose()
    ]);
  } catch (error) {
    cleanupError = error;
  }
  throwLifecycleErrors("recall-eval lifecycle failed", [primaryError, cleanupError]);
  if (result === undefined) throw new Error("recall-eval produced no result");
  return result;
}

async function executeRecallEvalRun(
  context: RecallEvalRunContext
): Promise<readonly RecallEvalQuestionResult[]> {
  const collected: RecallEvalQuestionResult[] = [];
  const daemon = await startBenchDaemon({
    dataDirRoot: context.dataDirRoot,
    embeddingMode: context.daemonLaunch.embeddingMode,
    embeddingProviderKind: context.daemonLaunch.embeddingProviderKind,
    recallWeightOverrides: context.recallWeightOverrides
  }, context.daemonLaunch);
  let primaryError: unknown;
  try {
    for (let i = 0; i < context.window.length; i += 1) {
      const question = context.window[i];
      if (question === undefined) continue;
      const result = await captureRecallEvalQuestion(
        context.selectionBoundarySpool, question.questionId,
        (selectionBoundaryObserver) => recallEvalOneQuestion({
          daemon, question, turnIndex: i + 1,
          embeddingMode: context.daemonLaunch.embeddingMode,
          recallOptions: recallOptionsForQuestion(
            context,
            question.question,
            selectionBoundaryObserver
          ),
          simulateReport: context.simulateReport,
          measurement: context.measurementForQuestion?.(question.questionId)
        })
      );
      collected.push(result);
      writeRecallEvalProgress(i, context.window.length, question.questionId, result);
    }
  } catch (error) {
    primaryError = error;
  }
  let shutdownError: unknown;
  try {
    await daemon.shutdown();
  } catch (error) {
    shutdownError = error;
  }
  throwLifecycleErrors("recall-eval daemon lifecycle failed", [primaryError, shutdownError]);
  return collected;
}

function recallOptionsForQuestion(
  context: RecallEvalRunContext,
  questionText: string,
  selectionBoundaryObserver: BenchRecallOptions["selectionBoundaryObserver"]
): BenchRecallOptions {
  if (context.querySemanticFactorCache === null) {
    return selectionBoundaryObserver === undefined
      ? context.recallOptions
      : { ...context.recallOptions, selectionBoundaryObserver };
  }
  const capture = context.querySemanticFactorCache.captures_by_source_text.get(questionText);
  if (capture === undefined) {
    throw new Error("query semantic factor cache lost a required query source");
  }
  return {
    ...context.recallOptions,
    ...(selectionBoundaryObserver === undefined ? {} : { selectionBoundaryObserver }),
    querySemanticFactorFormationCapture: capture
  };
}

async function writeRecallEvalArtifacts(
  context: RecallEvalRunContext,
  collected: readonly RecallEvalQuestionResult[],
  selectionArtifact: RecallEvalSelectionBoundaryArtifact | null
): Promise<RecallEvalResult> {
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
  return persistRecallEvalArtifacts(
    { ...context, runtimeAttribution }, collected, layout, payload, previous, diff,
    { runProvenance, expectedQuestionIdDigest, provenanceComplete },
    selectionArtifact
  );
}

async function persistRecallEvalArtifacts(
  context: RecallEvalRunContext,
  collected: readonly RecallEvalQuestionResult[],
  layout: HistoryLayout,
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>,
  evidence: Readonly<{
    runProvenance: Awaited<ReturnType<typeof buildRecallEvalRunProvenance>>;
    expectedQuestionIdDigest: string;
    provenanceComplete: boolean;
  }>,
  selectionArtifact: RecallEvalSelectionBoundaryArtifact | null
): Promise<RecallEvalResult> {
  const slug = buildRecallEvalArchiveSlug(context);
  const report = renderRecallEvalReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);
  const bundle = await buildRecallEvalArchiveBundle({
    slug, historyRoot: layout.historyRoot, payload, report, findings, collected,
    manifest: context.manifest,
    runtimeAttribution: context.runtimeAttribution,
    offset: context.options.offset ?? 0,
    limit: context.options.limit ?? null,
    runProvenance: evidence.runProvenance,
    expectedQuestionIdDigest: evidence.expectedQuestionIdDigest,
    provenanceComplete: evidence.provenanceComplete,
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
  const entry = await withPublishedDiagnosticsArtifact(
    bundle.diagnosticsArtifact,
    () => writeEntry(
      layout, "public", slug, payload, report, findings, {
        sidecars: bundle.sidecars,
        fileSidecars: [{
          filename: bundle.diagnosticsFilename,
          sourcePath: bundle.diagnosticsArtifact.finalPath
        }, ...(selectionArtifact === null ? [] : [{
          filename: RECALL_EVAL_SELECTION_BOUNDARY_FILENAME,
          sourcePath: selectionArtifact.sourcePath,
          identity: {
            sha256: selectionArtifact.binding.sha256,
            bytes: selectionArtifact.binding.bytes
          }
        }])]
      }
    ),
    isHistoryEntryCommittedError
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    payload,
    snapshotManifest: context.manifest,
    perQuestionDelivered: buildPerQuestionDelivered(collected),
    ...(context.derivedEvidenceProjectionRebuild === null
      ? {}
      : {
          derivedEvidenceProjectionRebuild:
            context.derivedEvidenceProjectionRebuild
        })
  };
}

async function recallEvalOneQuestion(input: {
  readonly daemon: BenchDaemonHandle;
  readonly question: LongMemEvalSnapshotQuestion;
  readonly turnIndex: number;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
  readonly measurement: SnapshotQuestionMeasurementOracle | undefined;
}): Promise<RecallEvalQuestionResult> {
  const workspace = await input.daemon.attachWorkspace({
    workspaceId: input.question.workspaceId,
    runId: input.question.runId
  });
  try {
    const sidecar = buildSnapshotSidecar(input.question);
    const readiness = await warmLongMemEvalEmbeddingCaches({
      embeddingMode: input.embeddingMode,
      workspace,
      objectIds: deriveLongMemEvalMemoryObjectIds(sidecar),
      queryText: input.question.question
    });
    const answerSessionSet = new Set(
      input.measurement?.answerSessionIds ?? input.question.answerSessionIds
    );
    const gold = resolveRecallEvalGold(input.measurement, sidecar, answerSessionSet);
    const recallCycle = await runRecallEvalQuestionCycle(
      input,
      workspace,
      gold.goldObjectIdentities
    );
    return await buildRecallEvalQuestionResult(
      input,
      workspace,
      sidecar,
      answerSessionSet,
      gold,
      recallCycle,
      readiness
    );
  } finally {
    await workspace.detach();
  }
}

function buildSnapshotSidecar(
  question: LongMemEvalSnapshotQuestion
): Map<string, LongMemEvalSidecarEntry> {
  const sidecar = new Map<string, LongMemEvalSidecarEntry>();
  for (const entry of question.sidecar) {
    sidecar.set(buildLongMemEvalSidecarKey(entry.objectKind, entry.objectId), {
      objectId: entry.objectId,
      objectKind: entry.objectKind,
      sessionId: entry.sessionId,
      hasAnswer: entry.hasAnswer,
      ...(entry.sourceRounds === undefined
        ? {}
        : { sourceRounds: entry.sourceRounds.map((source) => ({ ...source })) })
    });
  }
  return sidecar;
}

async function runRecallEvalQuestionCycle(
  input: Parameters<typeof recallEvalOneQuestion>[0],
  workspace: BenchWorkspaceHandle,
  goldObjectIdentities: readonly LongMemEvalGoldObjectIdentity[]
) {
  return runLongMemEvalRecallCycle({
    daemon: workspace,
    query: input.question.question,
    recallOptions: input.recallOptions,
    referenceTime: requireLongMemEvalTimestamp(input.question.questionDate),
    simulateReport: input.simulateReport,
    goldObjectIdentities,
    turnIndex: input.turnIndex,
    questionText: input.question.question
  });
}

// Probe-only (ALAYA_RECALL_EVAL_POOL_DUMP=path): append per-question fused pool ranks so an offline
// doc2query probe can join content from the DB and re-rank. No content here (recall-eval sidecar lacks it).
async function buildRecallEvalQuestionResult(
  input: Parameters<typeof recallEvalOneQuestion>[0],
  workspace: BenchWorkspaceHandle,
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionSet: ReadonlySet<string>,
  gold: RecallEvalGold,
  recallCycle: Awaited<ReturnType<typeof runRecallEvalQuestionCycle>>,
  readiness: Awaited<ReturnType<typeof warmLongMemEvalEmbeddingCaches>>
): Promise<RecallEvalQuestionResult> {
  const recallResult = recallCycle.scoredRecallResult;
  const results = recallResult.results;
  writeRecallEvalPoolDump(
    input.question.questionId,
    gold.goldObjectIdentities,
    results
  );
  const scoredHits = resolveLongMemEvalHitVerdict({
    isAbstention: input.measurement?.isAbstention ??
      isAbstentionQuestionId(input.question.questionId),
    results,
    sidecar,
    answerSessionIds: answerSessionSet,
    recallResult,
    embeddingMode: input.embeddingMode
  });
  return {
    questionId: input.question.questionId,
    hitAt1: scoredHits.hitAt1,
    hitAt5: scoredHits.hitAt5,
    hitAt10: scoredHits.hitAt10,
    firstTier: scoredHits.firstTier,
    latencyMs: recallCycle.scoredRecallLatencyMs,
    degradationReason: recallResult.degradation_reason ?? null,
    diagnostics: buildRecallEvalDiagnostics(
      input, recallResult, sidecar, gold, scoredHits
    ),
    tokenMetrics: await workspace.queryTokenMetrics(),
    recallTokenEconomy: extractRecallTokenEconomy(recallResult),
    edgeProposalKpiRows: await workspace.queryEdgeProposalKpiRows(),
    embeddingWarmup: readiness.embeddingWarmup,
    queryEmbeddingWarmup: readiness.queryEmbeddingWarmup,
    documentEmbeddingWarmupLatencyMs: readiness.documentWarmupLatencyMs,
    deliveredObjectIds: buildDeliveredResults(recallResult).map((result) => result.object_id)
  };
}

function buildRecallEvalDiagnostics(
  input: Parameters<typeof recallEvalOneQuestion>[0],
  recallResult: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>["scoredRecallResult"],
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  gold: RecallEvalGold,
  scoredHits: Pick<
    RecallEvalQuestionResult,
    "hitAt1" | "hitAt5" | "hitAt10"
  >
): LongMemEvalQuestionDiagnostic {
  const diagnostic = buildQuestionDiagnostic({
    questionId: input.question.questionId,
    goldMemoryIds: gold.goldMemoryIds,
    goldEvidenceIds: gold.goldEvidenceIds,
    goldObjectIds: gold.goldObjectIds,
    answerSessionIds: input.measurement?.answerSessionIds ??
      input.question.answerSessionIds,
    deliveredResults: buildDeliveredResults(recallResult),
    activeConstraintResults: buildActiveConstraintResults(recallResult),
    hitAt1: scoredHits.hitAt1,
    hitAt5: scoredHits.hitAt5,
    hitAt10: scoredHits.hitAt10,
    isAbstention: input.measurement?.isAbstention ??
      isAbstentionQuestionId(input.question.questionId),
    degradationReason: recallResult.degradation_reason ?? null,
    recallResult,
    embeddingMode: input.embeddingMode,
    seedDropReasons: input.question.answerSeedDropReasons
  });
  return attachQuestionMeasurementAxes(diagnostic, {
    answer: input.measurement?.answer ?? "",
    answerSessionIds: input.measurement?.answerSessionIds ??
      input.question.answerSessionIds,
    sourceDatesBySession: input.measurement?.sourceDatesBySession ?? new Map(),
    deliveredResults: diagnostic.delivered_results,
    candidates: diagnostic.candidates,
    sidecar: input.measurement?.sidecar ?? sidecar,
    isAbstention: input.measurement?.isAbstention ?? diagnostic.is_abstention
  });
}

interface RecallEvalGold {
  readonly goldMemoryIds: readonly string[];
  readonly goldEvidenceIds: readonly string[];
  readonly goldObjectIds: readonly string[];
  readonly goldObjectIdentities: readonly LongMemEvalGoldObjectIdentity[];
}

function resolveRecallEvalGold(
  measurement: SnapshotQuestionMeasurementOracle | undefined,
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionSet: ReadonlySet<string>
): RecallEvalGold {
  if (measurement !== undefined) {
    return {
      goldMemoryIds: measurement.goldMemoryIds,
      goldEvidenceIds: measurement.goldEvidenceIds,
      goldObjectIds: measurement.goldObjectIds,
      goldObjectIdentities: measurement.goldObjectIdentities
    };
  }
  const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(sidecar, answerSessionSet);
  const goldEvidenceIds = deriveLongMemEvalGoldEvidenceIds(sidecar, answerSessionSet);
  return {
    goldMemoryIds,
    goldEvidenceIds,
    goldObjectIds: deriveLongMemEvalGoldObjectIds(sidecar, answerSessionSet),
    goldObjectIdentities: buildGoldObjectIdentities({
      goldMemoryIds,
      goldEvidenceIds
    })
  };
}

function buildDeliveredResults(
  recallResult: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>["scoredRecallResult"]
) {
  return recallResult.results.slice(0, 10).map((pointer, index) => ({
    object_id: pointer.object_id,
    object_kind: pointer.object_kind,
    rank: index + 1,
    relevance_score: pointer.relevance_score,
    score_factors: pointer.score_factors ?? null
  }));
}

function buildActiveConstraintResults(
  recallResult: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>["scoredRecallResult"]
) {
  return (recallResult.active_constraints ?? []).map((constraint, index) => ({
    object_id: constraint.object_id,
    rank: index + 1
  }));
}
