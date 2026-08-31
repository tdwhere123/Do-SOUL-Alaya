import { z } from "zod";

export const LongMemEvalTurnSchema = z.object({
  role: z.string(),
  content: z.string(),
  has_answer: z.boolean().optional()
});
export type LongMemEvalTurn = z.infer<typeof LongMemEvalTurnSchema>;

export const LongMemEvalQuestionSchema = z.object({
  question_id: z.string(),
  question_type: z.string(),
  question: z.string(),
  answer: z.union([z.string(), z.number()]).transform((v) => String(v)),
  question_date: z.string(),
  haystack_session_ids: z.array(z.string()),
  haystack_dates: z.array(z.string()),
  // Each session is an array of turns
  haystack_sessions: z.array(z.array(LongMemEvalTurnSchema)),
  answer_session_ids: z.array(z.string())
});
export type LongMemEvalQuestion = z.infer<typeof LongMemEvalQuestionSchema>;

export const LongMemEvalVariant = z.enum([
  "longmemeval_oracle",
  "longmemeval_s",
  "longmemeval_m"
]);
export type LongMemEvalVariant = z.infer<typeof LongMemEvalVariant>;

/**
 * @anchor longmemeval-round — extraction unit for the bench seed path.
 *
 * A haystack session is a flat array of `{role, content}` MESSAGES. The
 * production POST_TURN_EXTRACT path extracts per ROUND — one user message
 * plus its assistant response — never per bare message: a lone message
 * gives the extractor no context to resolve pronouns/dates, and the
 * LongMemEval paper finds round granularity optimal for storage.
 *
 * `messageIndices` keeps the source message indices the round covers so the
 * scoring sidecar can stay correct (the evidence ref records exactly which
 * messages a round materialized from). `hasAnswer` is true iff ANY message
 * in the round is answer-bearing — so an answer message is never orphaned
 * from the sidecar by being merged into a round.
 */
export interface LongMemEvalRound {
  /** Combined, role-labelled content of every message in the round. */
  readonly content: string;
  /** Source message indices (in session order) this round covers. */
  readonly messageIndices: readonly number[];
  /** True iff any covered message has has_answer === true. */
  readonly hasAnswer: boolean;
}

export interface LongMemEvalRoundMessage {
  readonly message_id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

export function buildLongMemEvalRoundMessages(
  session: readonly LongMemEvalTurn[],
  round: LongMemEvalRound,
  idPrefix: string
): readonly LongMemEvalRoundMessage[] {
  return Object.freeze(round.messageIndices.map((messageIndex) => {
    const message = session[messageIndex];
    if (message === undefined) throw new Error(`missing round message ${messageIndex}`);
    return Object.freeze({
      message_id: `${idPrefix}-m${messageIndex}`,
      role: conversationRole(message.role),
      content: message.content
    });
  }));
}

/**
 * Pair a session's messages into rounds. A round is a consecutive
 * (user message, assistant message) pair. Edge cases handled without ever
 * dropping content:
 *   - messages that do not strictly alternate (two user messages in a row,
 *     a leading assistant message): a message that cannot pair with the
 *     next one as a user→assistant exchange becomes its own single-message
 *     round.
 *   - a trailing unpaired message: its own single-message round.
 * Every message lands in exactly one round.
 */
export function pairSessionIntoRounds(
  session: readonly LongMemEvalTurn[]
): readonly LongMemEvalRound[] {
  const rounds: LongMemEvalRound[] = [];
  let i = 0;
  while (i < session.length) {
    const first = session[i];
    if (first === undefined) {
      i += 1;
      continue;
    }
    const second = session[i + 1];
    const pairs =
      second !== undefined &&
      isUserRole(first.role) &&
      !isUserRole(second.role);
    if (pairs && second !== undefined) {
      rounds.push({
        content: `${roleLabel(first.role)}: ${first.content}\n${roleLabel(second.role)}: ${second.content}`,
        messageIndices: [i, i + 1],
        hasAnswer: first.has_answer === true || second.has_answer === true
      });
      i += 2;
      continue;
    }
    // Non-alternating or trailing message: its own single-message round.
    rounds.push({
      content: `${roleLabel(first.role)}: ${first.content}`,
      messageIndices: [i],
      hasAnswer: first.has_answer === true
    });
    i += 1;
  }
  return rounds;
}

function isUserRole(role: string): boolean {
  return role.trim().toLowerCase() === "user";
}

function roleLabel(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "assistant") return "Assistant";
  return role.trim().length === 0 ? "Message" : role.trim();
}

function conversationRole(role: string): "user" | "assistant" {
  const normalized = role.trim().toLowerCase();
  if (normalized === "user" || normalized === "assistant") return normalized;
  throw new Error(`unsupported LongMemEval conversation role: ${role}`);
}
