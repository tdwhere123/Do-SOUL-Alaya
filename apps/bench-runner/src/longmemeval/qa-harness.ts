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
import { isAbstentionQuestionId } from "./abstention.js";

/** Max chars of stitched memory context handed to the answer model. */
const QA_CONTEXT_CHAR_CAP = 20_000;

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
 * with the needed dated memories delivered).
 */
const ANSWER_SYSTEM_TEMPORAL =
  "Answer the user's question using ONLY the provided memory context. " +
  "Each memory is prefixed with the date it was recorded; the current date accompanies the question. " +
  "For elapsed time, durations, dates, or event ordering: find the relevant memories, resolve relative phrases ('yesterday', 'last week') against that memory's recorded date, and COMPUTE the answer from those dates. " +
  "Commit to the computation the dates support instead of saying you don't know; only abstain when no relevant dated memory exists. Be concise.";

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
}

export interface QaQuestionInput {
  readonly questionId: string;
  /** LongMemEval `question_type`; selects the answer + judge template. */
  readonly questionType: string;
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
    .map((candidate) =>
      candidate.eventDate !== undefined && candidate.eventDate.length > 0
        ? `[Recorded on ${candidate.eventDate}]\n${candidate.content}`
        : candidate.content
    )
    .join("\n\n");
  return text.slice(0, QA_CONTEXT_CHAR_CAP);
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
function answerSystemFor(questionType: string, isAbstention: boolean): string {
  if (isAbstention) {
    return ANSWER_SYSTEM_DEFAULT;
  }
  if (questionType === "single-session-preference") {
    return ANSWER_SYSTEM_PREFERENCE;
  }
  if (questionType === "temporal-reasoning") {
    return ANSWER_SYSTEM_TEMPORAL;
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
    return (
      "I will give you a question, a rubric for desired personalized response, and a response from a model. " +
      "Please answer yes if the response satisfies the desired response. Otherwise, answer no. " +
      "The model does not need to reflect all the points in the rubric. " +
      "The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\n" +
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
  chat: QaChatFn
): Promise<QaQuestionVerdict> {
  const context = buildQaAnswerContext(input.delivered);
  const isAbstention = isAbstentionQuestionId(input.questionId);
  const modelAnswer = await chat(
    answerSystemFor(input.questionType, isAbstention),
    // question date = "now"; temporal Qs anchor elapsed-day math against it.
    `Current date: ${input.questionDate}\n\nMemory context:\n${context}\n\nQuestion: ${input.question}\nAnswer:`
  );
  const judgeVerdict = await chat(
    JUDGE_SYSTEM,
    buildJudgeUser(
      input.questionType,
      isAbstention,
      input.question,
      input.goldAnswer,
      modelAnswer
    )
  );
  return {
    questionId: input.questionId,
    questionType: input.questionType,
    isAbstention,
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
