/**
 * @anchor longmemeval-qa-harness — end-to-end QA scoring on top of REAL recall.
 *
 * Aligns the bench with how SOTA memory systems report (LLM-judge QA accuracy,
 * not retrieval R@5): the delivered top-k recall content becomes the answer
 * model's memory context, a chat model answers, and a strict LLM-judge grades
 * the answer against gold. The QA path is OFF by default and only runs when the
 * caller passes a `QaChatFn`; a normal recall bench never touches it, so recall
 * metrics and kpi bytes are unchanged.
 *
 * Abstention (`_abs`) questions have no gold answer in the haystack; the correct
 * behaviour is to abstain. We reuse the abstention id predicate and score an
 * abstention question CORRECT iff the answer model abstains (says it does not
 * know) — matching abstention.ts intent (abstain = correct) without a judge call.
 *
 * see also: apps/bench-runner/src/longmemeval/qa-chat.ts — chat primitive
 * see also: apps/bench-runner/src/longmemeval/abstention.ts — `_abs` semantics
 * see also: .do-it/a-qa-probe.mjs — verified reference (answer + judge prompts)
 */
import type { QaChatFn } from "./qa-chat.js";
import { isAbstentionQuestionId } from "./abstention.js";

/** Max chars of stitched memory context handed to the answer model. */
const QA_CONTEXT_CHAR_CAP = 20_000;

const ANSWER_SYSTEM =
  "Answer the user's question using ONLY the provided memory context. Be concise; if the answer is absent, say you don't know.";
const JUDGE_SYSTEM =
  "You are a strict grader. Reply with exactly one word: CORRECT or WRONG.";

/** One delivered recall result with its full memory content, in rank order. */
export interface QaDeliveredCandidate {
  readonly objectId: string;
  /** Full seeded content for this object_id (empty when unmapped). */
  readonly content: string;
}

export interface QaQuestionInput {
  readonly questionId: string;
  readonly question: string;
  /** Gold answer; empty/undefined for abstention questions. */
  readonly goldAnswer: string;
  /** Delivered top-k candidates (rank order) with content. */
  readonly delivered: readonly QaDeliveredCandidate[];
}

export interface QaQuestionVerdict {
  readonly questionId: string;
  readonly isAbstention: boolean;
  /** True when the answer matched gold (or correctly abstained). */
  readonly correct: boolean;
  readonly modelAnswer: string;
  /** Raw judge verdict text; null for abstention (no judge call). */
  readonly judgeVerdict: string | null;
  readonly contextChars: number;
}

export interface QaAggregate {
  readonly qa_total: number;
  readonly qa_correct: number;
  readonly qa_accuracy: number;
  readonly qa_abstention_total: number;
  readonly qa_abstention_correct: number;
}

/** Stitch delivered top-k content into a single role-blind memory context. */
export function buildQaAnswerContext(
  delivered: readonly QaDeliveredCandidate[]
): string {
  const text = delivered
    .map((candidate) => candidate.content)
    .filter((content) => content.length > 0)
    .join("\n\n");
  return text.slice(0, QA_CONTEXT_CHAR_CAP);
}

/** True iff the answer text reads as an abstention ("I don't know"). */
export function answerAbstains(answer: string): boolean {
  return /\b(?:i\s+do\s*n['’]?t\s+know|i\s+don['’]?t\s+know|not?\s+(?:mentioned|stated|provided|available|present|in\s+the\s+(?:memory|context))|no\s+information|cannot\s+(?:answer|determine|find)|unable\s+to\s+(?:answer|determine))\b/iu.test(
    answer
  );
}

/** True iff the judge said CORRECT and did NOT say WRONG (probe parity). */
export function judgeIsCorrect(verdict: string): boolean {
  return /\bCORRECT\b/iu.test(verdict) && !/\bWRONG\b/iu.test(verdict);
}

/**
 * Score one question end-to-end: answer over delivered context, then judge
 * (answerable) or check abstention (`_abs`). Pure aside from the two injected
 * chat calls, so unit tests pass a fake QaChatFn and assert wiring with zero
 * network.
 */
export async function scoreQaQuestion(
  input: QaQuestionInput,
  chat: QaChatFn
): Promise<QaQuestionVerdict> {
  const context = buildQaAnswerContext(input.delivered);
  const modelAnswer = await chat(
    ANSWER_SYSTEM,
    `Memory context:\n${context}\n\nQuestion: ${input.question}\nAnswer:`
  );
  const isAbstention = isAbstentionQuestionId(input.questionId);
  if (isAbstention) {
    // abstention.ts intent: abstaining is the correct behaviour. No judge call.
    return {
      questionId: input.questionId,
      isAbstention: true,
      correct: answerAbstains(modelAnswer),
      modelAnswer,
      judgeVerdict: null,
      contextChars: context.length
    };
  }
  const judgeVerdict = await chat(
    JUDGE_SYSTEM,
    `Question: ${input.question}\nGold answer: ${input.goldAnswer}\nModel answer: ${modelAnswer}\nDoes the model answer match the gold answer's meaning?`
  );
  return {
    questionId: input.questionId,
    isAbstention: false,
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
  for (const verdict of verdicts) {
    if (verdict.correct) correct += 1;
    if (verdict.isAbstention) {
      absTotal += 1;
      if (verdict.correct) absCorrect += 1;
    }
  }
  const total = verdicts.length;
  return {
    qa_total: total,
    qa_correct: correct,
    qa_accuracy: total === 0 ? 0 : correct / total,
    qa_abstention_total: absTotal,
    qa_abstention_correct: absCorrect
  };
}
