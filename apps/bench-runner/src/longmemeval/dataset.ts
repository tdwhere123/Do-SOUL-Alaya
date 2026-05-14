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
