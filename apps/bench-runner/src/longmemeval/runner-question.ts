import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchEdgeFormationMember,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchRecallOptions,
  BenchTokenMetrics,
  BenchWorkspaceHandle,
  BenchDaemonHandle
} from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import {
  createPhaseTimer,
  isBenchProfileEnabled
} from "./runner-question-delivery.js";
export {
  WIDE_QA_DELIVERY_QUESTION_TYPES,
  buildQaDeliveredCandidates,
  dedupeQaDeliveredCandidates,
  resolveQaDeliveryBudget,
  shouldDedupQaDelivery
} from "./runner-question-delivery.js";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import type {
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReportSideEffectSnapshot
} from "./diagnostics.js";
import type { LongMemEvalQuestion } from "./dataset.js";
import type { CompileSeedRunner } from "./compile-seed.js";
import {
  deriveLongMemEvalGoldMemoryIds,
  deriveLongMemEvalMemoryObjectIds,
  runLongMemEvalRecallCycle,
  type LongMemEvalReportSimulationStats
} from "./runner-helpers.js";
import type { QaQuestionVerdict } from "./qa-harness.js";
import type { LongMemEvalSnapshotQuestion } from "./snapshot.js";
import type { QaChatFn } from "./qa-chat.js";
import { seedLongMemEvalQuestion } from "./runner-question-seeding.js";
import type { LongMemEvalQuestionSeedState } from
  "./runner-question-seeding.js";
import {
  buildLongMemEvalQuestionResult,
  buildLongMemEvalSnapshotQuestion
} from "./runner-question-result.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from "./selection/question-runtime-identity.js";
import { requireLongMemEvalTimestamp } from "./ingestion/source-time.js";
import { warmLongMemEvalEmbeddingCaches } from "./embedding-cache-warmup.js";
import { resolveLongMemEvalEdgeFormationConfig } from
  "./edge-formation-config.js";

export interface LongMemEvalWorkerResult {
  readonly questionId: string;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly seedTurnsTruncated: number;
  readonly answerTurnsTruncated: number;
  readonly seedCharsClipped: number;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  readonly reportUsageStats: LongMemEvalReportSimulationStats;
  readonly reportSideEffectSnapshot: LongMemEvalReportSideEffectSnapshot;
  readonly tokenMetrics: BenchTokenMetrics;
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
  readonly edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
  readonly snapshotQuestion?: LongMemEvalSnapshotQuestion;
  readonly qaVerdict?: QaQuestionVerdict;
}

export interface LongMemEvalQuestionRunInput {
  readonly daemon: BenchDaemonHandle;
  readonly question: LongMemEvalQuestion;
  readonly turnIndex: number;
  readonly seedRunner: CompileSeedRunner;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: "none" | "gold-only" | "mixed" | "always-used";
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly captureSnapshot: boolean;
  readonly qaChat?: QaChatFn;
  readonly qaJudgeChat?: QaChatFn;
}

export interface LongMemEvalPreparedQuestion {
  readonly questionId: string;
  readonly phase: ReturnType<typeof createPhaseTimer>;
  readonly seedState: LongMemEvalQuestionSeedState;
  readonly goldMemoryIds: readonly string[];
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  readonly snapshotQuestion: LongMemEvalSnapshotQuestion;
}

export async function runLongMemEvalQuestion(
  input: LongMemEvalQuestionRunInput
): Promise<LongMemEvalWorkerResult> {
  const phase = createPhaseTimer();
  try {
    return await withQuestionWorkspace(input, phase, async (workspace) => {
      const prepared = await prepareLongMemEvalQuestionInWorkspace(
        input,
        workspace,
        phase
      );
      return completeLongMemEvalQuestionInWorkspace(input, workspace, prepared);
    });
  } finally {
    writeQuestionProfile(input.question.question_id, phase);
  }
}

export async function prepareLongMemEvalQuestion(
  input: LongMemEvalQuestionRunInput
): Promise<LongMemEvalPreparedQuestion> {
  const phase = createPhaseTimer();
  try {
    return await withQuestionWorkspace(input, phase, (workspace) =>
      prepareLongMemEvalQuestionInWorkspace(input, workspace, phase));
  } catch (error) {
    writeQuestionProfile(input.question.question_id, phase);
    throw error;
  }
}

export async function runPreparedLongMemEvalQuestion(
  input: LongMemEvalQuestionRunInput,
  prepared: LongMemEvalPreparedQuestion
): Promise<LongMemEvalWorkerResult> {
  if (prepared.questionId !== input.question.question_id) {
    throw new Error("prepared LongMemEval question identity mismatch");
  }
  try {
    return await withQuestionWorkspace(input, prepared.phase, (workspace) =>
      completeLongMemEvalQuestionInWorkspace(input, workspace, prepared));
  } finally {
    writeQuestionProfile(input.question.question_id, prepared.phase);
  }
}

async function withQuestionWorkspace<T>(
  input: LongMemEvalQuestionRunInput,
  phase: ReturnType<typeof createPhaseTimer>,
  action: (workspace: BenchWorkspaceHandle) => Promise<T>
): Promise<T> {
  const identity = buildLongMemEvalQuestionRuntimeIdentity(input.question.question_id);
  const workspace: BenchWorkspaceHandle = await runQuestionPhase(
    phase,
    "workspace_attach",
    () =>
      input.daemon.attachWorkspace({
        workspaceId: identity.workspaceId,
        runId: identity.runId
      })
  );
  try {
    return await action(workspace);
  } finally {
    await runQuestionPhase(phase, "workspace_detach", () => workspace.detach());
  }
}

async function prepareLongMemEvalQuestionInWorkspace(
  input: LongMemEvalQuestionRunInput,
  workspace: BenchWorkspaceHandle,
  phase: ReturnType<typeof createPhaseTimer>
): Promise<LongMemEvalPreparedQuestion> {
  const seedState = await runQuestionPhase(phase, "seed_loop", () =>
    seedLongMemEvalQuestion({
      workspace,
      question: input.question,
      seedRunner: input.seedRunner,
      qaChat: input.qaChat,
      seedFormationMode: input.captureSnapshot
        ? "treatment_neutral"
        : "diagnostic_warmup"
    })
  );
  const { embeddingWarmup, queryEmbeddingWarmup } = await runQuestionPhase(
    phase,
    "embedding_warmup",
    () => warmLongMemEvalEmbeddingCaches({
      embeddingMode: input.embeddingMode,
      workspace,
      objectIds: deriveLongMemEvalMemoryObjectIds(seedState.sidecar),
      queryText: input.question.question
    })
  );
  await runQuestionPhase(phase, "edge_plane", () =>
    input.daemon.runEdgePlanePassIfConfigured()
  );
  await runCoherenceEdgesIfEnabled(input, workspace, seedState.coherenceMembers);
  await runAnswersWithEdgesIfEnabled(input, workspace, seedState.coherenceMembers);
  const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(
    seedState.sidecar,
    seedState.answerSessionSet
  );
  return {
    questionId: input.question.question_id,
    phase,
    seedState,
    goldMemoryIds,
    embeddingWarmup,
    queryEmbeddingWarmup,
    snapshotQuestion: buildLongMemEvalSnapshotQuestion({
      question: input.question,
      workspace,
      seedState
    })
  };
}

async function completeLongMemEvalQuestionInWorkspace(
  input: LongMemEvalQuestionRunInput,
  workspace: BenchWorkspaceHandle,
  prepared: LongMemEvalPreparedQuestion
): Promise<LongMemEvalWorkerResult> {
  const recallCycle = await runQuestionPhase(prepared.phase, "recall", () =>
    runQuestionRecallCycle(input, workspace, prepared.goldMemoryIds)
  );
  return await buildTimedQuestionResult({
    input,
    workspace,
    prepared,
    recallCycle
  });
}

function runQuestionRecallCycle(
  input: LongMemEvalQuestionRunInput,
  workspace: BenchWorkspaceHandle,
  goldMemoryIds: readonly string[]
): ReturnType<typeof runLongMemEvalRecallCycle> {
  return runLongMemEvalRecallCycle({
    daemon: workspace,
    query: input.question.question,
    recallOptions: input.recallOptions,
    referenceTime: requireLongMemEvalTimestamp(input.question.question_date),
    simulateReport: input.simulateReport,
    goldMemoryIds,
    turnIndex: input.turnIndex,
    questionText: input.question.question
  });
}

export function isAnswersWithEdgesEnabled(): boolean {
  return true;
}

async function buildTimedQuestionResult(input: {
  readonly input: LongMemEvalQuestionRunInput;
  readonly workspace: BenchWorkspaceHandle;
  readonly prepared: LongMemEvalPreparedQuestion;
  readonly recallCycle: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>;
}): Promise<LongMemEvalWorkerResult> {
  return await runQuestionPhase(input.prepared.phase, "kpi_query", () =>
    buildLongMemEvalQuestionResult({
      daemon: input.input.daemon,
      workspace: input.workspace,
      question: input.input.question,
      seedState: input.prepared.seedState,
      goldMemoryIds: input.prepared.goldMemoryIds,
      recallCycle: input.recallCycle,
      embeddingWarmup: input.prepared.embeddingWarmup,
      queryEmbeddingWarmup: input.prepared.queryEmbeddingWarmup,
      captureSnapshot: input.input.captureSnapshot,
      qaChat: input.input.qaChat,
      qaJudgeChat: input.input.qaJudgeChat,
      embeddingMode: input.input.embeddingMode
    })
  );
}

function writeQuestionProfile(
  questionId: string,
  phase: ReturnType<typeof createPhaseTimer>
): void {
  if (!isBenchProfileEnabled()) return;
  process.stderr.write(`[bench_profile] question=${questionId} ${phase.format()}\n`);
}

async function runCoherenceEdgesIfEnabled(
  input: LongMemEvalQuestionRunInput,
  workspace: Awaited<ReturnType<BenchDaemonHandle["attachWorkspace"]>>,
  members: readonly BenchEdgeFormationMember[]
): Promise<void> {
  const config = resolveLongMemEvalEdgeFormationConfig(process.env).coherence;
  if (
    input.embeddingMode !== "env" ||
    !config.enabled
  ) {
    return;
  }
  const summary = await workspace.accrueCoherenceCoRecall(members, {
    floor: config.floor,
    capPerNode: config.capPerNode,
    crossSessionOnly: config.crossSessionOnly
  });
  console.error(
    `[coherence-edges] q=${input.question.question_id} ` +
      `coherent=${summary.coherentPairs} kept=${summary.keptPairs} ` +
      `minted=${summary.minted}`
  );
}

async function runAnswersWithEdgesIfEnabled(
  input: LongMemEvalQuestionRunInput,
  workspace: Awaited<ReturnType<BenchDaemonHandle["attachWorkspace"]>>,
  members: readonly BenchEdgeFormationMember[]
): Promise<void> {
  // Flood/answers_with is always on; only embeddingMode gates bench edge mint.
  if (input.embeddingMode !== "env") {
    return;
  }
  const config = resolveLongMemEvalEdgeFormationConfig(process.env).answersWith;
  const summary = await workspace.accrueAnswersWithCoRelevance(members, {
    bar: config.bar,
    capPerNode: config.capPerNode,
    crossSessionOnly: config.crossSessionOnly
  });
  console.error(
    `[answers-with-edges] q=${input.question.question_id} ` +
      `co_relevant=${summary.coRelevantPairs} kept=${summary.keptPairs} ` +
      `minted=${summary.minted}`
  );
}

async function runQuestionPhase<T>(
  phase: ReturnType<typeof createPhaseTimer>,
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const start = phase.tick();
  try {
    return await action();
  } finally {
    phase.record(name, start);
  }
}
