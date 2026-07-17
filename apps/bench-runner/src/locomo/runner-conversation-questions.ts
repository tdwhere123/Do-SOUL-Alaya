import { appendFileSync } from "node:fs";
import type { BenchRecallTokenEconomy } from "../harness/recall/recall-diagnostics-schema.js";
import { monotonicElapsedMs, monotonicNowNs } from "../shared/monotonic.js";
import type { BenchEmbeddingMode, BenchWorkspaceHandle } from "../harness/daemon.js";
import {
  buildQuestionDiagnostic,
  type LongMemEvalQuestionDiagnostic
} from "../longmemeval/diagnostics.js";
import {
  scoreQaQuestion,
  type QaDeliveredCandidate,
  type QaQuestionVerdict
} from "../longmemeval/qa/qa-harness.js";
import { selectRelevantMemories } from "../longmemeval/qa/qa-llm-filter.js";
import { buildQaSupportPack } from "../longmemeval/qa/qa-support-pack.js";
import { resolveQaDeliveryBudget } from "../longmemeval/runner/question/runner-question.js";
import { extractRecallTokenEconomy } from "../longmemeval/qa/recall-token-economy.js";
import type { LocomoQa, LocomoSample } from "./dataset.js";
import type { LocomoRunOptions } from "./runner-types.js";
import type { LocomoSeededConversation } from "./runner-conversation-seed.js";
import {
  buildLocomoQuestionId,
  hasLocomoRetrievalEvidence,
  isLocomoAbstentionQa,
  readPositiveEnv,
  resolveLocomoGoldMemoryIds,
  resolveLocomoQaGoldAnswer,
  resolveLocomoQaQuestionType,
  shouldRunLocomoRecall
} from "./runner-utils.js";

export interface LocomoConversationQuestionResults {
  readonly qaCount: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly hitAt10: number;
  readonly tierHot: number;
  readonly tierWarm: number;
  readonly tierCold: number;
  readonly latencies: readonly number[];
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly recallTokenEconomySamples: readonly BenchRecallTokenEconomy[];
  readonly qaVerdicts: readonly QaQuestionVerdict[];
  readonly qaCategoryRows: readonly { category: number; correct: boolean }[];
}

interface MutableConversationQuestionResults {
  qaCount: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
  tierHot: number;
  tierWarm: number;
  tierCold: number;
  readonly latencies: number[];
  readonly questionDiagnostics: LongMemEvalQuestionDiagnostic[];
  readonly recallTokenEconomySamples: BenchRecallTokenEconomy[];
  readonly qaVerdicts: QaQuestionVerdict[];
  readonly qaCategoryRows: { category: number; correct: boolean }[];
}

interface QaResult {
  readonly latencyMs: number;
  readonly pointers: ReadonlyArray<{ readonly object_id: string; readonly relevance_score: number }>;
  readonly degradationReason: string | null;
  readonly recallResult: unknown;
}

export async function runLocomoConversationQuestions(input: {
  readonly workspace: BenchWorkspaceHandle;
  readonly conversation: LocomoSample;
  readonly opts: LocomoRunOptions;
  readonly seeded: LocomoSeededConversation;
  readonly embeddingMode: BenchEmbeddingMode;
}): Promise<LocomoConversationQuestionResults> {
  const state = createQuestionResults();
  for (let qaIndex = 0; qaIndex < input.conversation.qa.length; qaIndex += 1) {
    const qa = input.conversation.qa[qaIndex];
    if (qa === undefined) continue;
    await runLocomoQuestion(input, state, qa, qaIndex);
  }
  return state;
}

function createQuestionResults(): MutableConversationQuestionResults {
  return {
    qaCount: 0,
    hitAt1: 0,
    hitAt5: 0,
    hitAt10: 0,
    tierHot: 0,
    tierWarm: 0,
    tierCold: 0,
    latencies: [],
    questionDiagnostics: [],
    recallTokenEconomySamples: [],
    qaVerdicts: [],
    qaCategoryRows: []
  };
}

async function runLocomoQuestion(
  input: Parameters<typeof runLocomoConversationQuestions>[0],
  state: MutableConversationQuestionResults,
  qa: LocomoQa,
  qaIndex: number
): Promise<void> {
  const context = buildQuestionContext(input, qa, qaIndex);
  if (!context.shouldRunRecall) return;
  if (context.missingDiaIds.length > 0) {
    process.stderr.write(
      `[locomo] ${context.questionId}: ${context.missingDiaIds.length} unmaterialized gold dia_id(s); ` +
        `scoring on present gold (${context.missingDiaIds.join(", ")})\n`
    );
  }
  const result = await runQuestion(input.workspace, qa);
  // exclude from the retrieval denominator only when ZERO gold materialized
  if (context.retrievalScorable && context.goldMemoryIds.length > 0) {
    recordRetrievalOutcome(input, state, context, result);
  }
  if (input.opts.qa !== undefined) {
    await recordQaOutcome(input, state, context, result);
  }
}

function buildQuestionContext(
  input: Parameters<typeof runLocomoConversationQuestions>[0],
  qa: LocomoQa,
  qaIndex: number
) {
  const questionId = buildLocomoQuestionId(input.conversation.sample_id, qaIndex);
  const evidenceSet = new Set(qa.evidence);
  const retrievalScorable = hasLocomoRetrievalEvidence(qa);
  const { goldMemoryIds, missingDiaIds } = retrievalScorable
    ? resolveLocomoGoldMemoryIds({
        evidenceSet,
        memoryIdsByDiaId: input.seeded.memoryIdsByDiaId
      })
    : { goldMemoryIds: [], missingDiaIds: [] };
  return {
    qa,
    questionId,
    evidenceSet,
    isAbstention: isLocomoAbstentionQa(qa),
    retrievalScorable,
    shouldRunRecall: shouldRunLocomoRecall(qa, input.opts),
    goldMemoryIds,
    missingDiaIds
  };
}

function recordRetrievalOutcome(
  input: Parameters<typeof runLocomoConversationQuestions>[0],
  state: MutableConversationQuestionResults,
  context: ReturnType<typeof buildQuestionContext>,
  result: QaResult
): void {
  const hits = computeRetrievalHits(input.seeded, context.evidenceSet, result);
  recordRecallCounts(state, result, hits);
  state.questionDiagnostics.push(
    buildQuestionDiagnostic({
      questionId: context.questionId,
      goldMemoryIds: context.goldMemoryIds,
      answerSessionIds: [...context.evidenceSet],
      deliveredResults: toDeliveredResults(result),
      hitAt1: hits.hit1,
      hitAt5: hits.hit5,
      hitAt10: hits.hit10,
      isAbstention: false,
      degradationReason: result.degradationReason,
      recallResult: result.recallResult,
      embeddingMode: input.embeddingMode
    })
  );
  recordRecallTokenEconomy(state, result.recallResult);
}

function computeRetrievalHits(
  seeded: LocomoSeededConversation,
  evidenceSet: ReadonlySet<string>,
  result: QaResult
): { readonly hit1: boolean; readonly hit5: boolean; readonly hit10: boolean } {
  const ranked = result.pointers
    .slice(0, 10)
    .map((pointer) => seeded.diaIdByMemoryId.get(pointer.object_id));
  return {
    hit1: ranked[0] !== undefined && evidenceSet.has(ranked[0]),
    hit5: ranked
      .slice(0, 5)
      .some((dia) => dia !== undefined && evidenceSet.has(dia)),
    hit10: ranked.some((dia) => dia !== undefined && evidenceSet.has(dia))
  };
}

function recordRecallCounts(
  state: MutableConversationQuestionResults,
  result: QaResult,
  hits: { readonly hit1: boolean; readonly hit5: boolean; readonly hit10: boolean }
): void {
  state.qaCount += 1;
  state.latencies.push(result.latencyMs);
  if (hits.hit1) state.hitAt1 += 1;
  if (hits.hit5) state.hitAt5 += 1;
  if (hits.hit10) state.hitAt10 += 1;
  const firstScore = result.pointers[0]?.relevance_score ?? 0;
  if (firstScore >= 0.7) state.tierHot += 1;
  else if (firstScore >= 0.4) state.tierWarm += 1;
  else state.tierCold += 1;
}

function recordRecallTokenEconomy(
  state: MutableConversationQuestionResults,
  recallResult: unknown
): void {
  const tokenEconomySample = extractRecallTokenEconomy(recallResult);
  if (tokenEconomySample !== null) {
    state.recallTokenEconomySamples.push(tokenEconomySample);
  }
}

async function recordQaOutcome(
  input: Parameters<typeof runLocomoConversationQuestions>[0],
  state: MutableConversationQuestionResults,
  context: ReturnType<typeof buildQuestionContext>,
  result: QaResult
): Promise<void> {
  const qaConfig = input.opts.qa;
  if (qaConfig === undefined) return;
  const widePool = buildWideQaPool(input.seeded, result);
  const questionType = resolveLocomoQaQuestionType(context.qa);
  const delivered = await selectDeliveredQaCandidates(
    context.qa.question,
    questionType,
    widePool,
    qaConfig
  );
  const qaVerdict = await scoreQaQuestion(
    buildQaQuestionInput(input, context, questionType, delivered),
    qaConfig.chat,
    qaConfig.judgeChat ?? qaConfig.chat
  );
  state.qaVerdicts.push(qaVerdict);
  state.qaCategoryRows.push({ category: context.qa.category, correct: qaVerdict.correct });
  const hitAt5 = context.retrievalScorable
    ? computeRetrievalHits(input.seeded, context.evidenceSet, result).hit5
    : null;
  writeQaDumpIfRequested(context, hitAt5, delivered, qaVerdict);
}

function buildWideQaPool(
  seeded: LocomoSeededConversation,
  result: QaResult
): QaDeliveredCandidate[] {
  return result.pointers.map((pointer, index) => {
    const date = seeded.dateByMemoryId.get(pointer.object_id);
    return {
      objectId: pointer.object_id,
      content: seeded.contentByMemoryId.get(pointer.object_id) ?? "",
      sessionId: seeded.sessionByMemoryId.get(pointer.object_id) ?? null,
      sourceRank: index + 1,
      ...(date === undefined || date === null ? {} : { eventDate: date })
    };
  });
}

async function selectDeliveredQaCandidates(
  question: string,
  questionType: string,
  widePool: readonly QaDeliveredCandidate[],
  qaConfig: NonNullable<LocomoRunOptions["qa"]>
): Promise<QaDeliveredCandidate[]> {
  let delivered = await applyQaLlmFilter(question, widePool, qaConfig);
  if (process.env.ALAYA_BENCH_QA_SUPPORT_PACK !== undefined) {
    delivered = buildQaSupportPack({
      questionType,
      selected: delivered,
      widePool,
      maxDeliver: readPositiveEnv("ALAYA_BENCH_QA_SUPPORT_PACK_MAX", 16)
    });
  }
  return delivered;
}

async function applyQaLlmFilter(
  question: string,
  widePool: readonly QaDeliveredCandidate[],
  qaConfig: NonNullable<LocomoRunOptions["qa"]>
): Promise<QaDeliveredCandidate[]> {
  if (process.env.ALAYA_BENCH_QA_LLM_FILTER === undefined) return [...widePool];
  const filterK = readPositiveEnv("ALAYA_BENCH_QA_LLM_FILTER_K", 30);
  const filterM = readPositiveEnv("ALAYA_BENCH_QA_LLM_FILTER_M", 8);
  const selected = await selectRelevantMemories(
    question,
    widePool.slice(0, filterK),
    filterM,
    qaConfig.chat
  );
  return selected.length > 0 ? selected : [...widePool];
}

function buildQaQuestionInput(
  input: Parameters<typeof runLocomoConversationQuestions>[0],
  context: ReturnType<typeof buildQuestionContext>,
  questionType: string,
  delivered: readonly QaDeliveredCandidate[]
) {
  return {
    questionId: context.questionId,
    questionType,
    isAbstention: context.isAbstention,
    question: context.qa.question,
    questionDate: input.seeded.conversationNowDate,
    goldAnswer: resolveLocomoQaGoldAnswer(context.qa),
    delivered
  };
}

function writeQaDumpIfRequested(
  context: ReturnType<typeof buildQuestionContext>,
  hitAt5: boolean | null,
  delivered: readonly QaDeliveredCandidate[],
  qaVerdict: QaQuestionVerdict
): void {
  if (process.env.ALAYA_BENCH_QA_DUMP === undefined) return;
  appendFileSync(
    process.env.ALAYA_BENCH_QA_DUMP,
    JSON.stringify({
      questionId: context.questionId,
      category: context.qa.category,
      hitAt5,
      question: context.qa.question,
      goldAnswer: String(context.qa.answer),
      modelAnswer: qaVerdict.modelAnswer,
      correct: qaVerdict.correct,
      delivered: delivered.slice(0, 5).map((d) => ({
        objectId: d.objectId,
        content: d.content.replace(/\s+/gu, " ").slice(0, 200)
      }))
    }) + "\n"
  );
}

async function runQuestion(
  workspace: BenchWorkspaceHandle,
  qa: LocomoQa
): Promise<QaResult> {
  const { deliverK } = resolveQaDeliveryBudget(resolveLocomoQaQuestionType(qa));
  const recallStart = monotonicNowNs();
  const recallResult = await workspace.recall(qa.question, { maxResults: deliverK });
  const latencyMs = monotonicElapsedMs(recallStart);
  const pointers = recallResult.results.slice(0, deliverK).map((pointer) => ({
    object_id: pointer.object_id,
    relevance_score: pointer.relevance_score
  }));
  return {
    latencyMs,
    pointers,
    degradationReason: recallResult.degradation_reason ?? null,
    recallResult
  };
}

function toDeliveredResults(result: QaResult) {
  return result.pointers.map((pointer, index) => ({
    object_id: pointer.object_id,
    rank: index + 1,
    relevance_score: pointer.relevance_score
  }));
}
