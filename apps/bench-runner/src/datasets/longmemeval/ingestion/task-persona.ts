import { createHash } from "node:crypto";
import { z } from "zod";
import { AlayaError, ApprovedSemanticContextSchema, bindUtteranceAttribution, UNKNOWN_UTTERANCE_ATTRIBUTION,
  type ApprovedSemanticContext, type UtteranceAttribution } from "@do-soul/alaya-protocol";
import { assertVerifiedLongMemEvalDatasetMembership, type LoadedLongMemEvalDataset } from "./fetch.js";
import type { LongMemEvalQuestion } from "./dataset.js";

/** Bench input policy, not authentication or a Protocol identity rule. */
export const LONGMEMEVAL_TASK_PERSONA_POLICY = "longmemeval-question-local-persona-v1" as const;
export const LongMemEvalTaskPersonaPolicySchema = z.literal(LONGMEMEVAL_TASK_PERSONA_POLICY);
export const LongMemEvalPersonaSuccessorSchema = z.object({
  policy: LongMemEvalTaskPersonaPolicySchema,
  parent_snapshot: z.string().min(1), parent_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source_version: z.string().min(1).max(256)
}).strict();
export type LongMemEvalPersonaSuccessor = z.infer<typeof LongMemEvalPersonaSuccessorSchema>;

export function longMemEvalPersonaSourceVersion(parentManifestSha256: string, recordedAt: string): string {
  return `bench-persona-v1:${createHash("sha256").update(JSON.stringify([
    LONGMEMEVAL_TASK_PERSONA_POLICY, parentManifestSha256, recordedAt
  ]), "utf8").digest("hex")}`;
}

type PersonaQuestion = Pick<LongMemEvalQuestion, "question_id" | "question" | "haystack_session_ids" | "haystack_sessions">;

/** The dataset owner verifies the supported official pin and question membership.
 * No role, workspace hash or caller-supplied release string can mint this policy. */
export function createLongMemEvalTaskPersonaPolicy(dataset: LoadedLongMemEvalDataset) {
  assertVerifiedLongMemEvalDatasetMembership(dataset.promotionAuthority, {
    variant: "longmemeval_s", sha256: dataset.sha256, questions: dataset.questions
  });
  const sha256 = dataset.sha256;
  const questions = new Map<string, PersonaQuestion>();
  for (const question of dataset.questions) {
    if (questions.has(question.question_id)) throw new AlayaError("CONFLICT", "persona policy repeats a question identity");
    questions.set(question.question_id, structuredClone({ question_id: question.question_id, question: question.question,
      haystack_session_ids: question.haystack_session_ids,
      haystack_sessions: question.haystack_sessions.map(session => session.map(({ role, content }) => ({ role, content }))) }));
  }
  function question(id: string): PersonaQuestion {
    const row = questions.get(id);
    if (row === undefined) throw new AlayaError("VALIDATION", "persona question is outside the verified dataset selection");
    return row;
  }
  function attribution(row: PersonaQuestion, text: string, occurrence: string, conversation: string, role: string): UtteranceAttribution {
    if (role !== "user" && role !== "assistant") throw new AlayaError("VALIDATION", "unsupported persona outer role");
    if (Buffer.byteLength(text, "utf8") === 0) throw new AlayaError("VALIDATION", "persona attribution requires a nonempty utterance");
    return bindUtteranceAttribution({ contract: "utterance-attribution-v1", status: "captured",
      issuer_scope: `bench:longmemeval_s:${sha256}:${row.question_id}:${LONGMEMEVAL_TASK_PERSONA_POLICY}`,
      utterances: [{ occurrence_id: occurrence, conversation_ref: conversation,
        author_ref: role === "user" ? "task-presented-user" : null,
        utf8_span: [0, Buffer.byteLength(text, "utf8")] }] }, text);
  }
  return Object.freeze({
    policy: LONGMEMEVAL_TASK_PERSONA_POLICY,
    source(input: { questionId: string; sessionIndex: number; messageIndex: number; role: string; content: string }) {
      const row = question(input.questionId), sessionId = row.haystack_session_ids[input.sessionIndex];
      const original = row.haystack_sessions[input.sessionIndex]?.[input.messageIndex];
      if (!Number.isSafeInteger(input.sessionIndex) || input.sessionIndex < 0 ||
          !Number.isSafeInteger(input.messageIndex) || input.messageIndex < 0 || !sessionId ||
          original?.role !== input.role || original.content !== input.content) {
        throw new AlayaError("CONFLICT", "persona source differs from its verified original occurrence");
      }
      if (input.role !== "user" && input.role !== "assistant") {
        throw new AlayaError("VALIDATION", "unsupported persona outer role");
      }
      // Ordinary import retains empty originals; captured spans cannot be empty.
      if (Buffer.byteLength(input.content, "utf8") === 0) return UNKNOWN_UTTERANCE_ATTRIBUTION;
      return attribution(row, input.content, `session:${input.sessionIndex}:message:${input.messageIndex}`,
        `session:${input.sessionIndex}:${sessionId}`, input.role);
    },
    query(questionId: string, originalQuery: string) {
      const row = question(questionId);
      if (originalQuery !== row.question) throw new AlayaError("CONFLICT", "persona query differs from its verified original question");
      const approved_fixed_context = ApprovedSemanticContextSchema.parse({
        context_id: `bench:lme-persona-v1:${sha256}:${row.question_id}`,
        notes: `Policy ${LONGMEMEVAL_TASK_PERSONA_POLICY}; longmemeval_s SHA256 ${sha256}; question ${row.question_id}. ` +
          "LongMemEval sections 3.1-3.2 present one question-local user persona across the query and user-role outer utterances in this question's history, including distinct sessions. " +
          "conversation_ref session:<index>:<session_id> preserves actual session coordinates; query is separate. " +
          "task-presented-user means that task persona only within this issuer/question; equal author_ref alone does not establish cross-session identity. " +
          "This is not authenticated common authorship, real-person identity, statement truth, cross-question identity, source content or an answer. Assistant authors remain unbound; quoted User:/I text does not change outer authorship. Each C correspondence still needs independent source-grounded justification."
      });
      return { original_query: originalQuery, approved_fixed_context,
        attribution_context: attribution(row, originalQuery, "query", "query", "user") };
    }
  });
}
export type LongMemEvalTaskPersonaPolicy = ReturnType<typeof createLongMemEvalTaskPersonaPolicy>;

/** Shared preparation seam: omission deliberately preserves the ordinary unknown input. */
export function buildLongMemEvalQueryInput(question: Pick<LongMemEvalQuestion, "question_id" | "question">,
  options: { persona?: LongMemEvalTaskPersonaPolicy; approvedFixedContext?: ApprovedSemanticContext } = {}) {
  if (options.persona !== undefined) {
    if (options.approvedFixedContext !== undefined) throw new AlayaError("CONFLICT", "persona context cannot be replaced by caller context");
    return options.persona.query(question.question_id, question.question);
  }
  return { original_query: question.question, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    ...(options.approvedFixedContext === undefined ? {} : { approved_fixed_context: options.approvedFixedContext }) };
}
