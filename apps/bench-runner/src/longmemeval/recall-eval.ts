import { dirname } from "node:path";
import {
  buildDiffVsPrevious,
  diffKpis,
  renderFindings,
  writeEntry,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type EdgeProposalKpiEventRow,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../shared/version.js";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchRecallOptions,
  type BenchTokenMetrics,
  type BenchWorkspaceHandle
} from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  type LongMemEvalQuestionDiagnostic
} from "./diagnostics.js";
import { isAbstentionQuestionId } from "./abstention.js";
import {
  selectRecallEvalBaseline
} from "./recall-eval-archive.js";
import { assembleRecallEvalKpi } from "./recall-eval-kpi.js";
import { attachQuestionMeasurementAxes } from "./diagnostics-measurement-axes.js";
import {
  buildPerQuestionDelivered,
  buildRecallEvalArchiveSlug
} from "./kpi/recall-eval-archive.js";
import { extractRecallTokenEconomy } from "./recall-token-economy.js";
import { runLongMemEvalRecallCycle } from "./runner.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalSidecarEntry
} from "./runner.js";
import type { LongMemEvalSnapshotManifest, LongMemEvalSnapshotQuestion } from "./snapshot.js";
import type { LongMemEvalVariant } from "./dataset.js";
import { finalizeOwnedTempRoot } from "./lifecycle/owned-temp-root.js";
import { throwLifecycleErrors } from "./lifecycle/errors.js";
import { writeRecallEvalProgress } from "./lifecycle/recall-eval-progress.js";
import { writeRecallEvalRankIdentity } from "./provenance/recall-eval-rank-identity.js";
import { writeRecallEvalRunProvenance } from "./provenance/recall-eval-run.js";
import { writeRecallEvalPoolDump } from "./provenance/recall-eval-pool-dump.js";
import { requireLongMemEvalTimestamp } from "./ingestion/source-time.js";
import {
  prepareRecallEvalDataDir,
  buildRecallEvalRuntimeAttribution,
  recallEvalEmbeddingMode,
  recallEvalEmbeddingProviderLabel,
  recallEvalEmbeddingProviderKind
} from "./lifecycle/recall-eval-runtime.js";
import { loadRecallEvalSnapshot } from "./snapshot/recall-eval-loader.js";
import { renderRecallEvalReport } from "./kpi/recall-eval-report.js";
import { prepareRecallEvalRestoredDb } from "./snapshot/recall-eval-db.js";
import { restoreLegacySnapshotToDataDir } from "./snapshot/legacy-substrate.js";

export interface RecallEvalOptions {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly historyRoot: string;
  readonly policyShape?: BenchPolicyShape;
  readonly simulateReport?: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  /** Override the restore directory in tests. */
  readonly dataDirRoot?: string;
  readonly legacySnapshot?: boolean;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly legacyManifestSha256?: string;
  readonly legacyDatasetSha256?: string;
}
export interface RecallEvalResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly payload: KpiPayload;
  readonly snapshotManifest: LongMemEvalSnapshotManifest;
  readonly perQuestionDelivered: ReadonlyMap<string, readonly string[]>;
}
export interface RecallEvalQuestionResult {
  readonly questionId: string;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  readonly tokenMetrics: BenchTokenMetrics;
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
  readonly edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
  readonly deliveredObjectIds: readonly string[];
}
interface RecallEvalRunContext {
  readonly options: RecallEvalOptions;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly window: readonly LongMemEvalSnapshotQuestion[];
  readonly sidecarQuestionCount: number;
  readonly dataDirRoot: string;
  readonly ownsDataDirRoot: boolean;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly recallOptions: BenchRecallOptions;
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly runtimeAttribution: Awaited<ReturnType<typeof buildRecallEvalRuntimeAttribution>>;
  readonly datasetSha256: string | null;
}
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

  const context = await prepareRecallEvalRun(options, recallWeightOverrides);
  let succeeded = false;
  let result: RecallEvalResult | undefined;
  let primaryError: unknown;
  try {
    const collected = await executeRecallEvalRun(context);
    result = await writeRecallEvalArtifacts(context, collected);
    succeeded = true;
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await finalizeOwnedTempRoot(
      { path: context.dataDirRoot, owned: context.ownsDataDirRoot },
      succeeded
    );
  } catch (error) {
    cleanupError = error;
  }
  throwLifecycleErrors("recall-eval lifecycle failed", [primaryError, cleanupError]);
  if (result === undefined) throw new Error("recall-eval produced no result");
  return result;
}

async function prepareRecallEvalRun(
  options: RecallEvalOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
): Promise<RecallEvalRunContext> {
  const bundle = await loadRecallEvalSnapshot(options);
  const { manifest, sidecar: sidecarFile } = bundle;
  const commitSha7 = resolveBenchCommitSha7();
  const runtimeAttribution = await buildRecallEvalRuntimeAttribution(
    manifest,
    process.env,
    commitSha7,
    {
      snapshotManifestSha256: bundle.snapshotManifestSha256,
      datasetSha256: bundle.datasetSha256
    }
  );
  const window = selectRecallEvalWindow(sidecarFile.questions, options);
  const alayaVersion = resolveBenchRunnerVersion();
  const dataDir = await prepareRecallEvalDataDir({
    snapshotDbPath: options.snapshotDbPath,
    requestedRoot: options.dataDirRoot,
    ...(options.legacySnapshot === true
      ? { restoreSnapshot: (dataDirRoot: string) => restoreLegacySnapshotToDataDir({
          snapshotDbPath: options.snapshotDbPath,
          dataDirRoot,
          manifest
        }) }
      : { artifactIntegrity: manifest.artifact_integrity }),
    validateRestoredDb: (dbPath) => prepareRecallEvalRestoredDb({
      manifest,
      restoredDbPath: dbPath,
      legacySnapshot: options.legacySnapshot === true
    })
  });
  return {
    options,
    manifest,
    window,
    sidecarQuestionCount: sidecarFile.questions.length,
    dataDirRoot: dataDir.path,
    ownsDataDirRoot: dataDir.owned,
    policyShape: options.policyShape ?? "stress",
    simulateReport: options.simulateReport ?? "none",
    recallOptions: {
      maxResults: Number(process.env.ALAYA_RECALL_EVAL_MAX_RESULTS) || 10,
      conflictAwareness: (options.policyShape ?? "stress") !== "chat"
    },
    alayaVersion,
    commitSha7,
    runAt: new Date(),
    recallWeightOverrides,
    runtimeAttribution,
    datasetSha256: resolveRecallEvalDatasetSha(bundle)
  };
}

async function executeRecallEvalRun(
  context: RecallEvalRunContext
): Promise<readonly RecallEvalQuestionResult[]> {
  const collected: RecallEvalQuestionResult[] = [];
  const daemon = await startBenchDaemon({
    dataDirRoot: context.dataDirRoot,
    embeddingMode: recallEvalEmbeddingMode(),
    embeddingProviderKind: recallEvalEmbeddingProviderKind(),
    recallWeightOverrides: context.recallWeightOverrides
  });
  let primaryError: unknown;
  try {
    for (let i = 0; i < context.window.length; i += 1) {
      const question = context.window[i];
      if (question === undefined) continue;
      const result = await recallEvalOneQuestion({
        daemon,
        question,
        turnIndex: i + 1,
        recallOptions: context.recallOptions,
        simulateReport: context.simulateReport
      });
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

function selectRecallEvalWindow(
  questions: readonly LongMemEvalSnapshotQuestion[],
  options: RecallEvalOptions
): readonly LongMemEvalSnapshotQuestion[] {
  const offset = Math.max(0, options.offset ?? 0);
  const sliceEnd = options.limit !== undefined ? offset + options.limit : questions.length;
  return questions.slice(offset, sliceEnd);
}

async function writeRecallEvalArtifacts(
  context: RecallEvalRunContext,
  collected: readonly RecallEvalQuestionResult[]
): Promise<RecallEvalResult> {
  const payload = assembleRecallEvalKpi({
    collected,
    manifest: context.manifest,
    variant: context.options.variant,
    runAt: context.runAt,
    commitSha7: context.commitSha7,
    alayaVersion: context.alayaVersion,
    policyShape: context.policyShape,
    simulateReport: context.simulateReport,
    sampleSize: context.sidecarQuestionCount,
    evaluatedCount: context.window.length,
    recallWeightOverrides: context.recallWeightOverrides,
    embeddingProviderLabel: recallEvalEmbeddingProviderLabel(),
    runtimeAttribution: context.runtimeAttribution,
    datasetSha256: context.datasetSha256
  });
  const layout: HistoryLayout = { historyRoot: context.options.historyRoot };
  const previous = await selectRecallEvalBaseline(layout, "public", {
    split: payload.split,
    policyShape: context.policyShape,
    simulateReport: context.simulateReport,
    embeddingProvider: payload.embedding_provider
  });
  const diff = diffKpis(payload, previous);
  payload.diff_vs_previous = buildDiffVsPrevious(
    payload,
    previous,
    previous?.run_at ?? ""
  );
  return persistRecallEvalArtifacts(context, collected, layout, payload, previous, diff);
}

function resolveRecallEvalDatasetSha(
  bundle: Awaited<ReturnType<typeof loadRecallEvalSnapshot>>
): string | null {
  if (bundle.datasetSha256 !== null) return bundle.datasetSha256;
  if (bundle.manifest.dataset_sha256 !== undefined) return bundle.manifest.dataset_sha256;
  const revision = bundle.manifest.extraction_provenance?.dataset_revision;
  return revision !== undefined && /^[a-f0-9]{64}$/u.test(revision) ? revision : null;
}

async function persistRecallEvalArtifacts(
  context: RecallEvalRunContext,
  collected: readonly RecallEvalQuestionResult[],
  layout: HistoryLayout,
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>
): Promise<RecallEvalResult> {
  const slug = buildRecallEvalArchiveSlug(context);
  const entry = await writeEntry(
    layout,
    "public",
    slug,
    payload,
    renderRecallEvalReport(payload, previous, diff),
    renderFindings(payload, diff)
  );
  await writeRecallEvalRankIdentity(dirname(entry.kpiPath), collected, {
    expectedQuestionCount: context.manifest.question_count,
    expectedQuestionIdDigest: context.manifest.question_id_digest ?? null,
    requireFullSnapshotMatch:
      context.manifest.attribution?.status === "attributed" &&
      context.options.offset === undefined &&
      context.options.limit === undefined
  });
  await writeRecallEvalRunProvenance(dirname(entry.kpiPath), {
    manifest: context.manifest,
    runtimeAttribution: context.runtimeAttribution,
    evaluatedCount: context.window.length,
    offset: context.options.offset ?? 0,
    limit: context.options.limit ?? null,
    commitSha7: context.commitSha7,
    env: process.env
  });
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    payload,
    snapshotManifest: context.manifest,
    perQuestionDelivered: buildPerQuestionDelivered(collected)
  };
}

async function recallEvalOneQuestion(input: {
  readonly daemon: BenchDaemonHandle;
  readonly question: LongMemEvalSnapshotQuestion;
  readonly turnIndex: number;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
}): Promise<RecallEvalQuestionResult> {
  const workspace = await input.daemon.attachWorkspace({
    workspaceId: input.question.workspaceId,
    runId: input.question.runId
  });
  try {
    const sidecar = buildSnapshotSidecar(input.question);
    const answerSessionSet = new Set(input.question.answerSessionIds);
    const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(sidecar, answerSessionSet);
    const recallCycle = await runRecallEvalQuestionCycle(input, workspace, goldMemoryIds);
    return await buildRecallEvalQuestionResult(
      input,
      workspace,
      sidecar,
      answerSessionSet,
      goldMemoryIds,
      recallCycle
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
      hasAnswer: entry.hasAnswer
    });
  }
  return sidecar;
}

async function runRecallEvalQuestionCycle(
  input: Parameters<typeof recallEvalOneQuestion>[0],
  workspace: BenchWorkspaceHandle,
  goldMemoryIds: readonly string[]
) {
  return runLongMemEvalRecallCycle({
    daemon: workspace,
    query: input.question.question,
    recallOptions: input.recallOptions,
    referenceTime: requireLongMemEvalTimestamp(input.question.questionDate),
    simulateReport: input.simulateReport,
    goldMemoryIds,
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
  goldMemoryIds: readonly string[],
  recallCycle: Awaited<ReturnType<typeof runRecallEvalQuestionCycle>>
): Promise<RecallEvalQuestionResult> {
  const recallResult = recallCycle.scoredRecallResult;
  const results = recallResult.results;
  writeRecallEvalPoolDump(input.question.questionId, goldMemoryIds, results);
  const scoredHits = resolveLongMemEvalHitVerdict({
    isAbstention: isAbstentionQuestionId(input.question.questionId),
    results,
    sidecar,
    answerSessionIds: answerSessionSet,
    recallResult,
    embeddingMode: recallEvalEmbeddingMode()
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
      input, recallResult, sidecar, goldMemoryIds, scoredHits
    ),
    tokenMetrics: await workspace.queryTokenMetrics(),
    recallTokenEconomy: extractRecallTokenEconomy(recallResult),
    edgeProposalKpiRows: await workspace.queryEdgeProposalKpiRows(),
    deliveredObjectIds: buildDeliveredResults(recallResult).map((result) => result.object_id)
  };
}

function buildRecallEvalDiagnostics(
  input: Parameters<typeof recallEvalOneQuestion>[0],
  recallResult: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>["scoredRecallResult"],
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  goldMemoryIds: readonly string[],
  scoredHits: Pick<
    RecallEvalQuestionResult,
    "hitAt1" | "hitAt5" | "hitAt10"
  >
): LongMemEvalQuestionDiagnostic {
  const diagnostic = buildQuestionDiagnostic({
    questionId: input.question.questionId,
    goldMemoryIds,
    answerSessionIds: input.question.answerSessionIds,
    deliveredResults: buildDeliveredResults(recallResult),
    activeConstraintResults: buildActiveConstraintResults(recallResult),
    hitAt1: scoredHits.hitAt1,
    hitAt5: scoredHits.hitAt5,
    hitAt10: scoredHits.hitAt10,
    isAbstention: isAbstentionQuestionId(input.question.questionId),
    degradationReason: recallResult.degradation_reason ?? null,
    recallResult,
    embeddingMode: recallEvalEmbeddingMode(),
    seedDropReasons: input.question.answerSeedDropReasons
  });
  return attachQuestionMeasurementAxes(diagnostic, {
    answer: "",
    answerSessionIds: input.question.answerSessionIds,
    sourceDatesBySession: new Map(),
    deliveredResults: diagnostic.delivered_results,
    candidates: diagnostic.candidates,
    sidecar,
    isAbstention: diagnostic.is_abstention
  });
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
