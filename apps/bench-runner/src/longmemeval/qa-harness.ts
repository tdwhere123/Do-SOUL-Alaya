/**
 * @anchor longmemeval-qa-harness — end-to-end QA scoring on top of REAL recall.
 *
 * Aligns the bench with how SOTA memory systems report (LLM-judge QA accuracy,
 * not retrieval R@5): the delivered top-k recall content becomes the answer
 * model's memory context, a chat model answers, and an LLM-judge grades the
 * answer against gold. The QA path is OFF by default and only runs when the
 * caller passes a `QaChatFn`; a normal recall bench never touches it, so recall
 * metrics and kpi bytes are unchanged.
 *
 * Question-type口径 follows LongMemEval's own `get_anscheck_prompt`: the judge
 * template is selected per `question_type` (preference grades against a rubric,
 * temporal tolerates day off-by-one, knowledge-update accepts the latest value,
 * abstention checks the model identified the question as unanswerable). Without
 * this split, preference questions (gold = a personalization rubric) get judged
 * as factual lookups and the whole category scores zero — measuring the answer
 * model's phrasing, not the memory system.
 *
 * Abstention (`_abs`) questions have no answer in the haystack; the correct
 * behaviour is to abstain. We route them to the abstention judge template (an
 * LLM-judge, matching the official metric) rather than a string match.
 *
 * see also: apps/bench-runner/src/longmemeval/qa-chat.ts — chat primitive
 * see also: apps/bench-runner/src/longmemeval/abstention.ts — `_abs` semantics
 */
import type { QaChatFn } from "./qa-chat.js";

/** Max chars of stitched memory context handed to the answer model. Override
 * with ALAYA_BENCH_QA_CONTEXT_CHARS to test wider aggregation delivery. */
function qaContextCharCap(): number {
  const raw = Number(process.env.ALAYA_BENCH_QA_CONTEXT_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

/** Default answer口径: ground strictly in context, abstain when truly absent. */
const ANSWER_SYSTEM_DEFAULT =
  "Answer the user's question using ONLY the provided memory context. Be concise; if the answer is genuinely not in the context, say you don't know.";
/**
 * Preference answer口径: the gold is a personalization rubric, not a fact in the
 * context. The model must turn the user's stated history/preferences into a
 * concrete tailored recommendation instead of abstaining for lack of a literal
 * lookup — otherwise the whole preference category reads as "I don't know".
 */
const ANSWER_SYSTEM_PREFERENCE =
  "You are personalizing to one user. Use their preferences and history in the memory context to give a concrete recommendation tailored to what THIS user would prefer. Ground it in their stated preferences; do not give generic advice and do not refuse.";
/**
 * Temporal answer口径: an elapsed-time/ordering answer is never a literal string
 * in the context — it must be computed from the recorded dates. Under the
 * default 口径 the model reads that as "not in the context" and abstains
 * (oracle probe 2026-06-12: half the temporal failures were "I don't know"
 * with the needed dated memories delivered). Rule shape follows Mem0's
 * evaluation ANSWER_PROMPT (resolve relative phrases against the memory's own
 * timestamp, worked example, show the calculation, latest memory wins).
 */
const ANSWER_SYSTEM_TEMPORAL =
  "Answer the user's question using ONLY the provided memory context. " +
  "Each memory is prefixed with the date it was recorded; the current date accompanies the question.\n" +
  "Rules:\n" +
  "1. Relative phrases INSIDE a memory ('yesterday', 'last week', 'a month ago') are relative to THAT memory's recorded date — resolve them to absolute dates first. Example: a memory recorded on 2023/05/04 saying 'I went to India last year' means the trip was in 2022.\n" +
  "2. For elapsed time, durations, or event ordering: list the relevant absolute dates, then compute the answer step by step from those dates and the current date.\n" +
  "3. If memories conflict, trust the most recently recorded one.\n" +
  "Commit to the computation the dates support; do not answer 'I don't know' when the relevant dated memories are present — only abstain when no relevant dated memory exists. " +
  "Show the brief date calculation, then end with the final answer in one short sentence.";
/** Temporal 口径 for a WIDE delivery: the context holds many dated memories,
 * most irrelevant. A precise date answer is hurt by extra dates unless the
 * reader first filters to the events the question is actually about. Adds a
 * relevance-filter step to the temporal rules. Gated by
 * ALAYA_BENCH_QA_TEMPORAL_ENUM, default off. */
const ANSWER_SYSTEM_TEMPORAL_ENUM =
  "Answer the user's question using ONLY the provided memory context. " +
  "Each memory is prefixed with the date it was recorded; the current date accompanies the question. " +
  "The context contains MANY dated memories, most unrelated to the question.\n" +
  "Rules:\n" +
  "1. FIRST list only the memories that are actually about the event(s) the question asks about; ignore every other dated memory. If two memories describe the same event, keep the most recently recorded one.\n" +
  "2. Relative phrases INSIDE a memory ('yesterday', 'last week') are relative to THAT memory's recorded date — resolve them to absolute dates first.\n" +
  "3. For elapsed time, durations, or ordering: take the absolute dates of ONLY the relevant events, then compute step by step against the current date.\n" +
  "Commit to the computation those dates support; only abstain when no relevant dated memory exists. " +
  "Show the short list of relevant dates and the calculation, then the final answer in one sentence.";
/** Multi-session aggregation 口径: a count/sum/compare answer is derived, never
 * a literal string, so the default 口径 makes the model abstain or under-count
 * when the components are present. General aggregation guidance (mirrors the
 * temporal 口径); default for multi-session, opt out with
 * ALAYA_BENCH_QA_AGG_PROMPT=0. */
const ANSWER_SYSTEM_AGGREGATION =
  "Answer the user's question using ONLY the provided memory context. " +
  "The question asks you to aggregate across the whole history (count, total, compare, or average), so the answer is almost never written in any single memory — you must derive it.\n" +
  "Rules:\n" +
  "1. First enumerate EVERY memory relevant to the question as a short list. The context often repeats the same underlying event across several entries — treat entries describing the same item/event as ONE and count distinct items only.\n" +
  "2. Then compute: for 'how many' count the distinct items; for 'how much/total' sum the amounts; for 'which … most/least' compare the values across all candidates; for 'average' sum then divide.\n" +
  "3. Count items even when mentioned only in passing or framed differently — an attempt, a plan, a free one, a fix all count if the question's scope includes them; prominence of the mention does not decide.\n" +
  "Commit to the total the enumerated items support; do not answer 'I don't know' when relevant memories are present — only abstain when no relevant memory exists at all. " +
  "Show the brief enumeration and calculation, then end with the final answer in one short sentence.";

/** knowledge-update 口径 (v2): the attribute has changed over time, so the
 * answer is the LATEST recorded value, not the first one found. Gated by
 * ALAYA_BENCH_QA_V2_PROMPTS so the matrix can isolate the prompt lever. */
const ANSWER_SYSTEM_KNOWLEDGE_UPDATE =
  "Answer using ONLY the provided memory context. The asked attribute or item may have been updated over time. " +
  "First gather every memory about that attribute/item, sort them by recorded date, and answer with the value from the MOST RECENT applicable memory. " +
  "Mention an older value only if the question asks for history. Do not answer with a stale value when a later update exists.";
/** factual/list 口径 (v2): a list question is wrong if partial. Forces an
 * exhaustive enumeration before the final answer. */
const ANSWER_SYSTEM_FACTUAL =
  "Answer using ONLY the provided memory context. First identify the exact memory or memories that contain the answer. " +
  "If the question asks for a list or set, enumerate ALL matching items found anywhere in the context before answering — a partial list is wrong. " +
  "Then give the final answer concisely.";
/** LoCoMo open-domain 口径 (v2): category 4 may ask for general world knowledge
 * about an entity the conversation identifies, so ONLY-context wrongly
 * suppresses the model's own knowledge. Memory anchors the entity; general
 * knowledge may answer — but never invent conversation-specific facts. */
const ANSWER_SYSTEM_LOCOMO_OPEN_DOMAIN =
  "Use the memory context to identify the entity or event the user asks about. " +
  "If the question then asks for general world knowledge about that entity, answer from your general knowledge, but never invent conversation-specific facts that the memory does not support. " +
  "If the memory context does not identify the entity, say you don't know.";

/** Judge口径: one-word yes/no, matching LongMemEval's anscheck metric. */
const JUDGE_SYSTEM =
  "You are a strict grader for a question-answering system. Follow the instruction exactly and reply with one word: yes or no.";

/** One delivered recall result with its full memory content, in rank order. */
export interface QaDeliveredCandidate {
  readonly objectId: string;
  /** Full seeded content for this object_id (empty when unmapped). */
  readonly content: string;
  /**
   * Session date this memory is from (LongMemEval `haystack_dates`). Prefixed
   * into the answer context so temporal Qs have the "then" to pair with the
   * "now"; the conversation text itself never carries an absolute date.
   */
  readonly eventDate?: string;
  /** Session this memory belongs to; surfaced in the header for cross-session
   * enumeration (aggregation) and failure-split analysis. */
  readonly sessionId?: string | null;
  /** 1-based natural recall rank of this candidate; surfaced so the reader and
   * the dump can see delivery order independent of array position. */
  readonly sourceRank?: number;
}

export interface QaQuestionInput {
  readonly questionId: string;
  /** LongMemEval `question_type`; selects the answer + judge template. */
  readonly questionType: string;
  /** Dataset-owned abstention semantics; callers classify, scorer consumes. */
  readonly isAbstention: boolean;
  readonly question: string;
  /**
   * LongMemEval `question_date` — when the question is asked, i.e. "now".
   * Temporal questions ("how many days ago…", "between X and today") are
   * unanswerable without it; passed to the answer model as the current date.
   */
  readonly questionDate: string;
  /** Gold answer / preference rubric / abstention explanation. */
  readonly goldAnswer: string;
  /** Delivered top-k candidates (rank order) with content. */
  readonly delivered: readonly QaDeliveredCandidate[];
}

export interface QaQuestionVerdict {
  readonly questionId: string;
  readonly questionType: string;
  readonly isAbstention: boolean;
  /** True when the answer matched gold (or correctly abstained). */
  readonly correct: boolean;
  readonly modelAnswer: string;
  /** Raw judge verdict text (yes/no). */
  readonly judgeVerdict: string;
  readonly contextChars: number;
}

export interface QaTypeTally {
  readonly total: number;
  readonly correct: number;
}

export interface QaAggregate {
  readonly qa_total: number;
  readonly qa_correct: number;
  readonly qa_accuracy: number;
  readonly qa_abstention_total: number;
  readonly qa_abstention_correct: number;
  /** Per `question_type` accuracy — how SOTA tables report; verifies no
   * category (e.g. preference) is silently scoring zero. */
  readonly qa_by_type: Record<string, QaTypeTally>;
}

/** Stitch delivered top-k content into a single role-blind memory context. */
export function buildQaAnswerContext(
  delivered: readonly QaDeliveredCandidate[]
): string {
  const text = delivered
    .filter((candidate) => candidate.content.length > 0)
    .map((candidate, index) => {
      const parts = [`Memory ${index + 1}`];
      if (candidate.eventDate !== undefined && candidate.eventDate.length > 0) {
        parts.push(`recorded=${candidate.eventDate}`);
      }
      if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
        parts.push(`session=${candidate.sessionId}`);
      }
      parts.push(`rank=${candidate.sourceRank ?? index + 1}`);
      return `[${parts.join(" | ")}]\n${candidate.content}`;
    })
    .join("\n\n");
  return text.slice(0, qaContextCharCap());
}

/**
 * True iff the judge said yes and not no (one-word anscheck verdict). Stricter
 * on purpose than official LongMemEval (`'yes' in resp.lower()`): the `\bno\b`
 * guard rejects an ambivalent "yes, but no" the substring check would pass.
 * Every judge template ends with "Answer yes or no only", so the ambivalent
 * case is rare and the strict reading is the safer default.
 */
export function judgeIsCorrect(verdict: string): boolean {
  return /\byes\b/iu.test(verdict) && !/\bno\b/iu.test(verdict);
}

/** Pick the answer system prompt: preference needs personalization, temporal
 * needs license to compute from dates. Abstention always keeps the default
 * (those questions must be recognized as unanswerable, not computed through). */
function v2PromptsEnabled(): boolean {
  const raw = process.env.ALAYA_BENCH_QA_V2_PROMPTS;
  return raw !== undefined && raw !== "0" && raw.toLowerCase() !== "false" && raw.toLowerCase() !== "off";
}

export function answerSystemFor(questionType: string, isAbstention: boolean): string {
  if (isAbstention) {
    // Strict: abstention never inherits a v2 prompt — the gold behaviour is to
    // say "I don't know", so the default 口径 must win even when v2 is on.
    return ANSWER_SYSTEM_DEFAULT;
  }
  if (questionType === "single-session-preference") {
    return ANSWER_SYSTEM_PREFERENCE;
  }
  if (questionType === "temporal-reasoning") {
    return process.env.ALAYA_BENCH_QA_TEMPORAL_ENUM !== undefined
      ? ANSWER_SYSTEM_TEMPORAL_ENUM
      : ANSWER_SYSTEM_TEMPORAL;
  }
  const v2 = v2PromptsEnabled();
  if (v2 && questionType === "knowledge-update") {
    return ANSWER_SYSTEM_KNOWLEDGE_UPDATE;
  }
  if (v2 && questionType === "locomo-open-domain") {
    return ANSWER_SYSTEM_LOCOMO_OPEN_DOMAIN;
  }
  // multi-session is LongMemEval's aggregation/comparison category; the
  // aggregation 口径 is the default for it (like temporal/preference), opt out
  // with ALAYA_BENCH_QA_AGG_PROMPT=0 for A/B.
  if (
    (questionType === "multi-session" ||
      questionType === "locomo-aggregation") &&
    process.env.ALAYA_BENCH_QA_AGG_PROMPT !== "0" &&
    process.env.ALAYA_BENCH_QA_AGG_PROMPT !== "off"
  ) {
    return ANSWER_SYSTEM_AGGREGATION;
  }
  if (
    v2 &&
    (questionType === "single-session-user" ||
      questionType === "single-session-assistant" ||
      questionType === "locomo-factual")
  ) {
    return ANSWER_SYSTEM_FACTUAL;
  }
  return ANSWER_SYSTEM_DEFAULT;
}

/**
 * Build the judge user prompt for one question, mirroring LongMemEval's
 * `get_anscheck_prompt`: shared contains-answer base, with per-type clauses.
 */
function buildJudgeUser(
  questionType: string,
  isAbstention: boolean,
  question: string,
  gold: string,
  answer: string
): string {
  if (isAbstention) {
    return (
      "I will give you an unanswerable question, an explanation, and a response from a model. " +
      "Please answer yes if the model correctly identifies the question as unanswerable. " +
      "The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\n" +
      `Question: ${question}\n\nExplanation: ${gold}\n\nModel Response: ${answer}\n\n` +
      "Does the model correctly identify the question as unanswerable? Answer yes or no only."
    );
  }
  if (questionType === "single-session-preference") {
    // Official LongMemEval preference rubric (deliberately lenient) + an explicit
    // clarification of that intent. The clarification is neutral for a faithful judge
    // (gpt-4o: 29/30 with and without it) but stops a stronger model (gpt-5.4-mini)
    // from silently applying a stricter-than-official bar: with it, mini's agreement
    // with the gpt-4o official-rubric verdicts rises 73%->90% while its scrambled-gold
    // rejection stays 100% (2026-06-15 calibration). Lets future baselines use a strong
    // judge faithfully instead of pinning to the older, weaker gpt-4o.
    return (
      "I will give you a question, a rubric for desired personalized response, and a response from a model. " +
      "Please answer yes if the response satisfies the desired response. Otherwise, answer no. " +
      "The model does not need to reflect all the points in the rubric. " +
      "The response is correct as long as it recalls and utilizes the user's personal information correctly. " +
      "Answer yes if the response recalls and uses the user's relevant personal information from the rubric, " +
      "even if it is not exhaustive, omits some rubric points, or also includes some general advice. " +
      "Only answer no if the response ignores the user's personal information, contradicts it, or recommends " +
      "something the rubric says the user would not prefer.\n\n" +
      `Question: ${question}\n\nRubric: ${gold}\n\nModel Response: ${answer}\n\n` +
      "Is the model response correct? Answer yes or no only."
    );
  }
  const base =
    "I will give you a question, a correct answer, and a response from a model. " +
    "Please answer yes if the response contains the correct answer. Otherwise, answer no. " +
    "If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. " +
    "If the response only contains a subset of the information required by the answer, answer no.";
  let extra = "";
  if (questionType === "temporal-reasoning") {
    extra =
      " In addition, do not penalize off-by-one errors for the number of days. " +
      "If the question asks for a number of days/weeks/months and the model makes an off-by-one error " +
      "(e.g. predicting 19 days when the answer is 18 days), the response is still correct.";
  } else if (questionType === "knowledge-update") {
    extra =
      " If the response contains some previous information along with an updated answer, " +
      "it is correct as long as the updated answer is the required one.";
  }
  return (
    base +
    extra +
    `\n\nQuestion: ${question}\n\nCorrect Answer: ${gold}\n\nModel Response: ${answer}\n\n` +
    "Is the model response correct? Answer yes or no only."
  );
}

/**
 * Score one question end-to-end: answer over delivered context, then an
 * LLM-judge with the per-type template. Pure aside from the two injected chat
 * calls, so unit tests pass a fake QaChatFn and assert wiring with zero network.
 */
export async function scoreQaQuestion(
  input: QaQuestionInput,
  chat: QaChatFn,
  // Judge with a separate model when given (the official LongMemEval metric uses
  // gpt-4o); defaults to the answer chat for backward compatibility.
  judgeChat: QaChatFn = chat
): Promise<QaQuestionVerdict> {
  const context = buildQaAnswerContext(input.delivered);
  const modelAnswer = await chat(
    answerSystemFor(input.questionType, input.isAbstention),
    // question date = "now"; temporal Qs anchor elapsed-day math against it.
    `Current date: ${input.questionDate}\n\nMemory context:\n${context}\n\nQuestion: ${input.question}\nAnswer:`
  );
  const judgeVerdict = await judgeChat(
    JUDGE_SYSTEM,
    buildJudgeUser(
      input.questionType,
      input.isAbstention,
      input.question,
      input.goldAnswer,
      modelAnswer
    )
  );
  return {
    questionId: input.questionId,
    questionType: input.questionType,
    isAbstention: input.isAbstention,
    correct: judgeIsCorrect(judgeVerdict),
    modelAnswer,
    judgeVerdict,
    contextChars: context.length
  };
}

/** Aggregate per-question verdicts into the kpi.qa_metrics block. */
export function aggregateQaVerdicts(
  verdicts: readonly QaQuestionVerdict[]
): QaAggregate {
  let correct = 0;
  let absTotal = 0;
  let absCorrect = 0;
  const byType: Record<string, { total: number; correct: number }> = {};
  for (const verdict of verdicts) {
    if (verdict.correct) correct += 1;
    if (verdict.isAbstention) {
      absTotal += 1;
      if (verdict.correct) absCorrect += 1;
    }
    const tally = (byType[verdict.questionType] ??= { total: 0, correct: 0 });
    tally.total += 1;
    if (verdict.correct) tally.correct += 1;
  }
  const total = verdicts.length;
  return {
    qa_total: total,
    qa_correct: correct,
    qa_accuracy: total === 0 ? 0 : correct / total,
    qa_abstention_total: absTotal,
    qa_abstention_correct: absCorrect,
    qa_by_type: byType
  };
}
