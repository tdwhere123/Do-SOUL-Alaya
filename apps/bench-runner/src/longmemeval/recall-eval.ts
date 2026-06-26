import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  renderFindings,
  renderReport,
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
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind,
  type BenchRecallOptions,
  type BenchTokenMetrics,
  type BenchWorkspaceHandle
} from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";

// bench-only: ALAYA_RECALL_EVAL_EMBEDDING=env turns on the embedding stream vs the snapshot's stored vectors.
function recallEvalEmbeddingMode(): BenchEmbeddingMode {
  return process.env.ALAYA_RECALL_EVAL_EMBEDDING === "env" ? "env" : "disabled";
}
function recallEvalEmbeddingProviderKind(): BenchEmbeddingProviderKind {
  return recallEvalEmbeddingMode() === "env" ? "local_onnx" : "openai";
}
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
  RECALL_EVAL_ARCHIVE_MARKER,
  selectRecallEvalBaseline
} from "./recall-eval-archive.js";
import { assembleRecallEvalKpi } from "./recall-eval-kpi.js";
import { extractRecallTokenEconomy } from "./recall-token-economy.js";
import { runLongMemEvalRecallCycle } from "./runner.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalSidecarEntry
} from "./runner.js";
import {
  assertSnapshotVersionMatch,
  readSnapshotManifest,
  readSnapshotSidecar,
  restoreSnapshotToDataDir,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotQuestion
} from "./snapshot.js";
import type { LongMemEvalVariant } from "./dataset.js";

/**
 * @anchor longmemeval-recall-eval
 *
 * Layer 2+3 (fast, every iteration). Restores a seeded-DB snapshot into a
 * working dataDirRoot, attaches the daemon to it, and runs PURE Layer-3 recall
 * per question — no LLM, no extraction, no materialization. Minutes for 100Q.
 *
 * It re-uses the seed-time scoring sidecar persisted alongside the snapshot, so
 * it never re-runs the seed loop. Recall-derived KPI fields (r_at_*, per-plane,
 * per-hop, per-edge-type, recall_token_economy, token_economy,
 * edge_proposal_rate) are computed from this run's recall; gate-only fields
 * (seed_extraction_path / seed_truncation / embedding warmup) are INHERITED
 * from the snapshot manifest's extraction provenance, marked
 * provenance-inherited, never recomputed.
 *
 * cross-file: apps/bench-runner/src/longmemeval/snapshot.ts (produce/restore)
 * cross-file: apps/bench-runner/src/longmemeval/runner.ts (shared scoring +
 *   recall cycle the slow path also uses)
 * cross-file: apps/bench-runner/src/longmemeval/recall-eval-archive.ts
 *   (RECALL_EVAL_ARCHIVE_MARKER — the fast-loop archive discriminator)
 */

export interface RecallEvalOptions {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly historyRoot: string;
  readonly policyShape?: BenchPolicyShape;
  readonly simulateReport?: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  /**
   * Override the restore directory (tests). Production allocates an mkdtemp
   * working copy so the frozen snapshot is never mutated by appended
   * delivery / lens events.
   */
  readonly dataDirRoot?: string;
}

export interface RecallEvalResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly payload: KpiPayload;
  readonly snapshotManifest: LongMemEvalSnapshotManifest;
  // invariant: questionId -> delivered object_ids in rank order; rank-identical
  // across two runs on a fixed snapshot (asserted in recall-eval-snapshot.test.ts).
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
  // Delivered object_ids in rank order (rank 1 first). Surfaced so a
  // determinism test can prove randomUUID never perturbs ordering at rank
  // granularity, not just hit/miss. cross-file: recall-eval-snapshot.test.ts
  readonly deliveredObjectIds: readonly string[];
}

interface RecallEvalRunContext {
  readonly options: RecallEvalOptions;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly window: readonly LongMemEvalSnapshotQuestion[];
  readonly sidecarQuestionCount: number;
  readonly dataDirRoot: string;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly recallOptions: BenchRecallOptions;
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
}

/**
 * Run the recall-only feedback loop against a seeded-DB snapshot. Restores a
 * working copy, asserts the snapshot's code/migration version matches the
 * running binary, then recalls + scores every persisted question and emits the
 * normal KPI artifact for the recall-derived fields.
 */
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
  const collected = await executeRecallEvalRun(context);
  return writeRecallEvalArtifacts(context, collected);
}

async function prepareRecallEvalRun(
  options: RecallEvalOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
): Promise<RecallEvalRunContext> {
  const manifest = readSnapshotManifest(options.snapshotDbPath);
  const sidecarFile = readSnapshotSidecar(options.snapshotDbPath);
  const dataDirRoot =
    options.dataDirRoot ?? (await mkdtemp(join(tmpdir(), "alaya-recall-eval-")));
  restoreSnapshotToDataDir({
    snapshotDbPath: options.snapshotDbPath,
    dataDirRoot
  });
  assertSnapshotVersionMatch(manifest, join(dataDirRoot, "alaya.db"));
  return {
    options,
    manifest,
    window: selectRecallEvalWindow(sidecarFile.questions, options),
    sidecarQuestionCount: sidecarFile.questions.length,
    dataDirRoot,
    policyShape: options.policyShape ?? "stress",
    simulateReport: options.simulateReport ?? "none",
    recallOptions: {
      maxResults: 10,
      conflictAwareness: (options.policyShape ?? "stress") === "stress"
    },
    alayaVersion: resolveBenchRunnerVersion(),
    commitSha7: resolveBenchCommitSha7(),
    runAt: new Date(),
    recallWeightOverrides
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
  } finally {
    await daemon.shutdown();
  }
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

function writeRecallEvalProgress(
  questionIndex: number,
  totalQuestions: number,
  questionId: string,
  result: RecallEvalQuestionResult
): void {
  process.stdout.write(
    `[recall-eval ${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} ` +
      `R@5=${result.hitAt5 ? "✓" : "✗"} latency=${result.latencyMs}ms\n`
  );
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
    recallWeightOverrides: context.recallWeightOverrides
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

async function persistRecallEvalArtifacts(
  context: RecallEvalRunContext,
  collected: readonly RecallEvalQuestionResult[],
  layout: HistoryLayout,
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>
): Promise<RecallEvalResult> {
  const slug = buildRecallEvalSlug(context);
  const entry = await writeEntry(
    layout,
    "public",
    slug,
    payload,
    renderReport(payload, previous, diff),
    renderFindings(payload, diff)
  );
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

function buildRecallEvalSlug(context: RecallEvalRunContext): string {
  return entrySlug(
    context.runAt,
    context.commitSha7,
    `${benchArchiveDiscriminator(context.policyShape, context.simulateReport)}-${RECALL_EVAL_ARCHIVE_MARKER}`
  );
}

function buildPerQuestionDelivered(
  collected: readonly RecallEvalQuestionResult[]
): ReadonlyMap<string, readonly string[]> {
  return new Map<string, readonly string[]>(
    collected.map((result) => [result.questionId, result.deliveredObjectIds] as const)
  );
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
    simulateReport: input.simulateReport,
    goldMemoryIds,
    turnIndex: input.turnIndex,
    questionText: input.question.question
  });
}

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
  const scoredHits = resolveLongMemEvalHitVerdict({
    isAbstention: isAbstentionQuestionId(input.question.questionId),
    results,
    sidecar,
    answerSessionIds: answerSessionSet
  });
  return {
    questionId: input.question.questionId,
    hitAt1: scoredHits.hitAt1,
    hitAt5: scoredHits.hitAt5,
    hitAt10: scoredHits.hitAt10,
    firstTier: scoredHits.firstTier,
    latencyMs: recallCycle.scoredRecallLatencyMs,
    degradationReason: recallResult.degradation_reason ?? null,
    diagnostics: buildRecallEvalDiagnostics(input, recallResult, goldMemoryIds, scoredHits),
    tokenMetrics: await workspace.queryTokenMetrics(),
    recallTokenEconomy: extractRecallTokenEconomy(recallResult),
    edgeProposalKpiRows: await workspace.queryEdgeProposalKpiRows(),
    deliveredObjectIds: buildDeliveredResults(recallResult).map((result) => result.object_id)
  };
}

function buildRecallEvalDiagnostics(
  input: Parameters<typeof recallEvalOneQuestion>[0],
  recallResult: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>["scoredRecallResult"],
  goldMemoryIds: readonly string[],
  scoredHits: Pick<
    RecallEvalQuestionResult,
    "hitAt1" | "hitAt5" | "hitAt10"
  >
): LongMemEvalQuestionDiagnostic {
  return buildQuestionDiagnostic({
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
    embeddingMode: recallEvalEmbeddingMode()
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
