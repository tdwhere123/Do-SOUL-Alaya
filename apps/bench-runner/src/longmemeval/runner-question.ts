import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
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
import { buildLongMemEvalQuestionResult } from "./runner-question-result.js";

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

export async function runLongMemEvalQuestion(
  input: LongMemEvalQuestionRunInput
): Promise<LongMemEvalWorkerResult> {
  const profileEnabled = isBenchProfileEnabled();
  const phase = createPhaseTimer();
  const workspace: BenchWorkspaceHandle = await runQuestionPhase(
    phase,
    "workspace_attach",
    () =>
      input.daemon.attachWorkspace({
        workspaceId: `lme-${input.question.question_id.slice(0, 8)}`,
        runId: `run-${input.question.question_id.slice(0, 8)}`
      })
  );
  try {
    return await runLongMemEvalQuestionInWorkspace(input, workspace, phase);
  } finally {
    await runQuestionPhase(phase, "workspace_detach", () => workspace.detach());
    if (profileEnabled) {
      process.stderr.write(
        `[bench_profile] question=${input.question.question_id} ${phase.format()}\n`
      );
    }
  }
}

async function runLongMemEvalQuestionInWorkspace(
  input: LongMemEvalQuestionRunInput,
  workspace: BenchWorkspaceHandle,
  phase: ReturnType<typeof createPhaseTimer>
): Promise<LongMemEvalWorkerResult> {
  const seedState = await runQuestionPhase(phase, "seed_loop", () =>
    seedLongMemEvalQuestion({
      workspace,
      question: input.question,
      seedRunner: input.seedRunner,
      qaChat: input.qaChat
    })
  );
  const { embeddingWarmup, queryEmbeddingWarmup } = await runQuestionPhase(
    phase,
    "embedding_warmup",
    () => warmQuestionEmbeddingCaches(input, workspace, seedState.sidecar)
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
  const recallCycle = await runQuestionPhase(phase, "recall", () =>
    runLongMemEvalRecallCycle({
      daemon: workspace,
      query: input.question.question,
      recallOptions: input.recallOptions,
      simulateReport: input.simulateReport,
      goldMemoryIds,
      turnIndex: input.turnIndex,
      questionText: input.question.question
    })
  );
  return await buildTimedQuestionResult({
    input,
    workspace,
    phase,
    seedState,
    goldMemoryIds,
    recallCycle,
    embeddingWarmup,
    queryEmbeddingWarmup
  });
}

export function isAnswersWithEdgesEnabled(): boolean {
  return true;
}

async function buildTimedQuestionResult(input: {
  readonly input: LongMemEvalQuestionRunInput;
  readonly workspace: BenchWorkspaceHandle;
  readonly phase: ReturnType<typeof createPhaseTimer>;
  readonly seedState: Awaited<ReturnType<typeof seedLongMemEvalQuestion>>;
  readonly goldMemoryIds: readonly string[];
  readonly recallCycle: Awaited<ReturnType<typeof runLongMemEvalRecallCycle>>;
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
}): Promise<LongMemEvalWorkerResult> {
  return await runQuestionPhase(input.phase, "kpi_query", () =>
    buildLongMemEvalQuestionResult({
      daemon: input.input.daemon,
      workspace: input.workspace,
      question: input.input.question,
      seedState: input.seedState,
      goldMemoryIds: input.goldMemoryIds,
      recallCycle: input.recallCycle,
      embeddingWarmup: input.embeddingWarmup,
      queryEmbeddingWarmup: input.queryEmbeddingWarmup,
      captureSnapshot: input.input.captureSnapshot,
      qaChat: input.input.qaChat,
      qaJudgeChat: input.input.qaJudgeChat,
      embeddingMode: input.input.embeddingMode
    })
  );
}

async function warmQuestionEmbeddingCaches(
  input: LongMemEvalQuestionRunInput,
  workspace: Awaited<ReturnType<BenchDaemonHandle["attachWorkspace"]>>,
  sidecar: Parameters<typeof deriveLongMemEvalMemoryObjectIds>[0]
): Promise<{
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
}> {
  if (input.embeddingMode !== "env") {
    return { embeddingWarmup: null, queryEmbeddingWarmup: null };
  }
  return {
    embeddingWarmup: await workspace.warmEmbeddingCache(
      deriveLongMemEvalMemoryObjectIds(sidecar)
    ),
    queryEmbeddingWarmup: await workspace.warmQueryEmbeddingCache([
      input.question.question
    ])
  };
}

async function runCoherenceEdgesIfEnabled(
  input: LongMemEvalQuestionRunInput,
  workspace: Awaited<ReturnType<BenchDaemonHandle["attachWorkspace"]>>,
  members: readonly { readonly memoryId: string; readonly sessionId: string }[]
): Promise<void> {
  if (
    input.embeddingMode !== "env" ||
    process.env.ALAYA_EXP_COHERENCE_EDGES !== "1"
  ) {
    return;
  }
  const summary = await workspace.accrueCoherenceCoRecall(members, {
    floor: Number(process.env.ALAYA_EXP_COHERENCE_FLOOR ?? "0.6"),
    capPerNode: Number(process.env.ALAYA_EXP_COHERENCE_CAP ?? "3"),
    crossSessionOnly: process.env.ALAYA_EXP_COHERENCE_XSESSION !== "0"
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
  members: readonly { readonly memoryId: string; readonly sessionId: string }[]
): Promise<void> {
  // Flood/answers_with is always on; only embeddingMode gates bench edge mint.
  if (input.embeddingMode !== "env") {
    return;
  }
  const summary = await workspace.accrueAnswersWithCoRelevance(members, {
    bar: Number(process.env.ALAYA_EXP_ANSWERS_WITH_BAR ?? "3"),
    capPerNode: Number(process.env.ALAYA_EXP_ANSWERS_WITH_CAP ?? "3"),
    crossSessionOnly: process.env.ALAYA_EXP_ANSWERS_WITH_XSESSION !== "0"
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
