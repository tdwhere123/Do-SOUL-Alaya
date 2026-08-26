import type { BenchSimulateReportMode } from "@do-soul/alaya-eval";
import {
  type BenchDaemonHandle,
  type BenchEmbeddingMode,
  type BenchRecallOptions,
  type BenchWorkspaceHandle
} from "../../../../harness/daemon.js";
import {
  buildQuestionDiagnostic,
  type LongMemEvalQuestionDiagnostic
} from "../../../diagnostics.js";
import { isAbstentionQuestionId } from "../../../diagnostics/abstention.js";
import { attachQuestionMeasurementAxes } from
  "../../../diagnostics/diagnostics-measurement-axes.js";
import { buildGoldObjectIdentities } from
  "../../../diagnostics/gold-object-identities.js";
import type { LongMemEvalGoldObjectIdentity } from
  "../../../diagnostics/gold-object-identities.js";
import { requireLongMemEvalTimestamp } from "../../../../longmemeval/ingestion/source-time.js";
import { warmLongMemEvalEmbeddingCaches } from
  "../../../provenance/embedding/embedding-cache-warmup.js";
import { writeRecallEvalPoolDump } from
  "../../../provenance/recall-eval/recall-eval-pool-dump.js";
import { extractRecallTokenEconomy } from "../../../qa/recall-token-economy.js";
import { runLongMemEvalRecallCycle } from "../../../../longmemeval/runner.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldEvidenceIds,
  deriveLongMemEvalGoldMemoryIds,
  deriveLongMemEvalGoldObjectIds,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalSidecarEntry
} from "../../../../longmemeval/runner.js";
import { deriveLongMemEvalMemoryObjectIds } from
  "../../../../longmemeval/runner/runner-helpers.js";
import type { SnapshotQuestionMeasurementOracle } from
  "../../../snapshot/measurement-oracle.js";
import type { LongMemEvalSnapshotQuestion } from
  "../../../snapshot/materialize.js";
import type { RecallEvalQuestionResult } from "../recall-eval-contract.js";

export interface RecallEvalOneQuestionInput {
  readonly daemon: BenchDaemonHandle;
  readonly workspace?: BenchWorkspaceHandle;
  readonly question: LongMemEvalSnapshotQuestion;
  readonly turnIndex: number;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
  readonly measurement: SnapshotQuestionMeasurementOracle | undefined;
  readonly onActualEmbeddingWarmupComplete?: () => Promise<void>;
}

export async function recallEvalOneQuestion(
  input: RecallEvalOneQuestionInput
): Promise<RecallEvalQuestionResult> {
  if (input.workspace !== undefined) {
    return recallEvalAttachedQuestion(input, input.workspace);
  }
  const workspace = await input.daemon.attachWorkspace({
    workspaceId: input.question.workspaceId,
    runId: input.question.runId
  });
  try {
    return await recallEvalAttachedQuestion(input, workspace);
  } finally {
    await workspace.detach();
  }
}

async function recallEvalAttachedQuestion(
  input: RecallEvalOneQuestionInput,
  workspace: BenchWorkspaceHandle
): Promise<RecallEvalQuestionResult> {
  const sidecar = buildSnapshotSidecar(input.question);
  const readiness = await warmLongMemEvalEmbeddingCaches({
    embeddingMode: input.embeddingMode,
    workspace,
    objectIds: deriveLongMemEvalMemoryObjectIds(sidecar),
    queryText: input.question.question
  });
  if ((readiness.embeddingWarmup?.pass_count ?? 0) > 0) {
    await input.onActualEmbeddingWarmupComplete?.();
  }
  const answerSessionSet = new Set(
    input.measurement?.answerSessionIds ?? input.question.answerSessionIds
  );
  const gold = resolveRecallEvalGold(input.measurement, sidecar, answerSessionSet);
  const recallCycle = await runRecallEvalQuestionCycle(
    input, workspace, gold.goldObjectIdentities
  );
  return buildRecallEvalQuestionResult(
    input, workspace, sidecar, answerSessionSet, gold, recallCycle, readiness
  );
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
  input: RecallEvalOneQuestionInput,
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

async function buildRecallEvalQuestionResult(
  input: RecallEvalOneQuestionInput,
  workspace: BenchWorkspaceHandle,
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionSet: ReadonlySet<string>,
  gold: RecallEvalGold,
  recallCycle: Awaited<ReturnType<typeof runRecallEvalQuestionCycle>>,
  readiness: Awaited<ReturnType<typeof warmLongMemEvalEmbeddingCaches>>
): Promise<RecallEvalQuestionResult> {
  const recallResult = recallCycle.scoredRecallResult;
  writeRecallEvalPoolDump(
    input.question.questionId,
    gold.goldObjectIdentities,
    recallResult.results
  );
  const scoredHits = resolveLongMemEvalHitVerdict({
    isAbstention: input.measurement?.isAbstention ??
      isAbstentionQuestionId(input.question.questionId),
    results: recallResult.results,
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
    deliveredObjectIds: buildDeliveredResults(recallResult)
      .map((result) => result.object_id)
  };
}

function buildRecallEvalDiagnostics(
  input: RecallEvalOneQuestionInput,
  recallResult: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>["scoredRecallResult"],
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  gold: RecallEvalGold,
  scoredHits: Pick<RecallEvalQuestionResult, "hitAt1" | "hitAt5" | "hitAt10">
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
    goldObjectIdentities: buildGoldObjectIdentities({ goldMemoryIds, goldEvidenceIds })
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
