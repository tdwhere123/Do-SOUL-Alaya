import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import type { BenchTokenMetrics } from "../harness/daemon.js";
import type {
  BenchDaemonHandle,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchWorkspaceHandle
} from "../harness/daemon.js";
import type { LongMemEvalQuestionDiagnostic } from "../longmemeval/diagnostics.js";
import type { QaQuestionVerdict } from "../longmemeval/qa-harness.js";
import type { CompileSeedRunner } from "../longmemeval/compile-seed.js";
import type { LocomoSample } from "./dataset.js";
import type { LocomoRunOptions } from "./runner-types.js";
import {
  runLocomoConversationQuestions,
  type LocomoConversationQuestionResults
} from "./runner-conversation-questions.js";
import {
  seedLocomoConversation,
  type LocomoSeededConversation
} from "./runner-conversation-seed.js";
import { shouldRunLocomoRecall } from "./runner-utils.js";

export interface ConversationResult {
  readonly qaCount: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly hitAt10: number;
  readonly tierHot: number;
  readonly tierWarm: number;
  readonly tierCold: number;
  readonly latencies: readonly number[];
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  readonly recallTokenEconomySamples: readonly BenchRecallTokenEconomy[];
  readonly tokenMetrics: BenchTokenMetrics;
  readonly qaVerdicts: readonly QaQuestionVerdict[];
  readonly qaCategoryRows: readonly { category: number; correct: boolean }[];
}

export async function runOneConversation(
  daemon: BenchDaemonHandle,
  seedRunner: CompileSeedRunner,
  conversation: LocomoSample,
  opts: LocomoRunOptions
): Promise<ConversationResult> {
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const workspace = await attachLocomoWorkspace(daemon, conversation);
  try {
    const seeded = await seedLocomoConversation({ workspace, seedRunner, conversation });
    const warmup = await warmLocomoConversation(workspace, daemon, seeded, conversation, opts);
    const questions = await runLocomoConversationQuestions({
      workspace,
      conversation,
      opts,
      seeded,
      embeddingMode
    });
    const tokenMetrics = await workspace.queryTokenMetrics();
    return buildConversationResult(questions, warmup, tokenMetrics);
  } finally {
    await workspace.detach();
  }
}

async function attachLocomoWorkspace(
  daemon: BenchDaemonHandle,
  conversation: LocomoSample
): Promise<BenchWorkspaceHandle> {
  return daemon.attachWorkspace({
    workspaceId: `locomo-${conversation.sample_id}`,
    runId: `run-${conversation.sample_id}`
  });
}

async function warmLocomoConversation(
  workspace: BenchWorkspaceHandle,
  daemon: BenchDaemonHandle,
  seeded: LocomoSeededConversation,
  conversation: LocomoSample,
  opts: LocomoRunOptions
): Promise<Pick<ConversationResult, "embeddingWarmup" | "queryEmbeddingWarmup">> {
  const recallQuestions = conversation.qa.filter((qa) => shouldRunLocomoRecall(qa, opts));
  const embeddingWarmup =
    opts.embeddingMode === "env"
      ? await workspace.warmEmbeddingCache(seeded.allSeededMemoryIds)
      : null;
  const queryEmbeddingWarmup =
    opts.embeddingMode === "env"
      ? await workspace.warmQueryEmbeddingCache(recallQuestions.map((qa) => qa.question))
      : null;
  await daemon.runEdgePlanePassIfConfigured();
  return { embeddingWarmup, queryEmbeddingWarmup };
}

function buildConversationResult(
  questions: LocomoConversationQuestionResults,
  warmup: Pick<ConversationResult, "embeddingWarmup" | "queryEmbeddingWarmup">,
  tokenMetrics: BenchTokenMetrics
): ConversationResult {
  return {
    ...questions,
    ...warmup,
    tokenMetrics
  };
}
