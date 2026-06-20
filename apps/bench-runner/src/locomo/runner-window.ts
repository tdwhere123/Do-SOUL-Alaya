import type { PerScenarioRow } from "@do-soul/alaya-eval";
import type { BenchDaemonHandle, BenchEmbeddingMode } from "../harness/daemon.js";
import { startBenchDaemon } from "../harness/daemon.js";
import type { CompileSeedRunner } from "../longmemeval/compile-seed.js";
import type { LongMemEvalQuestionDiagnostic } from "../longmemeval/diagnostics.js";
import { QaChatError } from "../longmemeval/qa-chat.js";
import type { LocomoSample } from "./dataset.js";
import { runOneConversation, type ConversationResult } from "./runner-conversation.js";
import type { LocomoRunOptions } from "./runner-types.js";

export interface LocomoConversationAggregate {
  readonly perScenario: PerScenarioRow[];
  readonly questionDiagnostics: LongMemEvalQuestionDiagnostic[];
  readonly latencies: number[];
  readonly conversationResults: ConversationResult[];
  tierHot: number;
  tierWarm: number;
  tierCold: number;
  totalHitAt1: number;
  totalHitAt5: number;
  totalHitAt10: number;
  totalQa: number;
  conversationFailures: number;
}

export async function runLocomoConversationWindow(input: {
  readonly window: readonly LocomoSample[];
  readonly opts: LocomoRunOptions;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly seedRunner: CompileSeedRunner;
}): Promise<LocomoConversationAggregate> {
  const aggregate = createLocomoConversationAggregate();
  const daemon = await startLocomoDaemon(input.embeddingMode, input.opts);
  try {
    await collectLocomoConversations({ ...input, aggregate, daemon });
    logConversationFailures(aggregate.conversationFailures, input.window.length);
    return aggregate;
  } finally {
    await daemon.shutdown();
  }
}

function createLocomoConversationAggregate(): LocomoConversationAggregate {
  return {
    perScenario: [],
    questionDiagnostics: [],
    latencies: [],
    conversationResults: [],
    tierHot: 0,
    tierWarm: 0,
    tierCold: 0,
    totalHitAt1: 0,
    totalHitAt5: 0,
    totalHitAt10: 0,
    totalQa: 0,
    conversationFailures: 0
  };
}

async function startLocomoDaemon(
  embeddingMode: BenchEmbeddingMode,
  opts: LocomoRunOptions
): Promise<BenchDaemonHandle> {
  const benchRunId = `locomo-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return await startBenchDaemon({
    workspaceId: `${benchRunId}-default`,
    runId: `${benchRunId}-default-run`,
    embeddingMode,
    ...(opts.embeddingProviderKind === undefined
      ? {}
      : { embeddingProviderKind: opts.embeddingProviderKind })
  });
}

async function collectLocomoConversations(input: {
  readonly window: readonly LocomoSample[];
  readonly opts: LocomoRunOptions;
  readonly seedRunner: CompileSeedRunner;
  readonly daemon: BenchDaemonHandle;
  readonly aggregate: LocomoConversationAggregate;
}): Promise<void> {
  for (let i = 0; i < input.window.length; i += 1) {
    const conversation = input.window[i];
    if (conversation === undefined) continue;
    await runConversationOrRecordFailure(input, conversation, i);
  }
}

async function runConversationOrRecordFailure(
  input: {
    readonly window: readonly LocomoSample[];
    readonly opts: LocomoRunOptions;
    readonly seedRunner: CompileSeedRunner;
    readonly daemon: BenchDaemonHandle;
    readonly aggregate: LocomoConversationAggregate;
  },
  conversation: LocomoSample,
  index: number
): Promise<void> {
  try {
    const convResult = await runOneConversation(
      input.daemon,
      input.seedRunner,
      conversation,
      input.opts
    );
    addConversationResult(input.aggregate, conversation, convResult);
    writeConversationProgress(index, input.window.length, conversation, convResult);
  } catch (err) {
    if (!(err instanceof QaChatError)) throw err;
    input.aggregate.conversationFailures += 1;
    process.stderr.write(
      `[${index + 1}/${input.window.length}] ${conversation.sample_id} FAILED - ` +
        `skipped: ${err.message}\n`
    );
  }
}

function addConversationResult(
  aggregate: LocomoConversationAggregate,
  conversation: LocomoSample,
  convResult: ConversationResult
): void {
  aggregate.conversationResults.push(convResult);
  aggregate.totalQa += convResult.qaCount;
  aggregate.totalHitAt1 += convResult.hitAt1;
  aggregate.totalHitAt5 += convResult.hitAt5;
  aggregate.totalHitAt10 += convResult.hitAt10;
  aggregate.tierHot += convResult.tierHot;
  aggregate.tierWarm += convResult.tierWarm;
  aggregate.tierCold += convResult.tierCold;
  aggregate.questionDiagnostics.push(...convResult.questionDiagnostics);
  aggregate.latencies.push(...convResult.latencies);
  aggregate.perScenario.push(buildScenarioRow(conversation, convResult));
}

function buildScenarioRow(
  conversation: LocomoSample,
  convResult: ConversationResult
): PerScenarioRow {
  return {
    id: conversation.sample_id,
    version: 1,
    hit_at_5: convResult.qaCount > 0 && convResult.hitAt5 / convResult.qaCount >= 0.5,
    tier: dominantTier(convResult)
  };
}

function dominantTier(convResult: ConversationResult): PerScenarioRow["tier"] {
  if (
    convResult.tierHot >= convResult.tierWarm &&
    convResult.tierHot >= convResult.tierCold
  ) {
    return "hot";
  }
  return convResult.tierWarm >= convResult.tierCold ? "warm" : "cold";
}

function writeConversationProgress(
  index: number,
  total: number,
  conversation: LocomoSample,
  convResult: ConversationResult
): void {
  process.stdout.write(
    `[${index + 1}/${total}] ${conversation.sample_id} ` +
      `qa=${convResult.qaCount} ` +
      `R@5=${((convResult.hitAt5 / Math.max(1, convResult.qaCount)) * 100).toFixed(1)}%\n`
  );
}

function logConversationFailures(failures: number, total: number): void {
  if (failures === 0) return;
  process.stdout.write(
    `[locomo] ${failures}/${total} conversation(s) failed and were skipped.\n`
  );
}
