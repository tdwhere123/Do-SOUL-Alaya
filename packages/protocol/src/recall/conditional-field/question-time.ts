import { z } from "zod";
import { IsoDatetimeStringSchema } from "../../shared/schema-primitives.js";

/** Declared question-and-clock-only producer; this is a hypothesis, never a source filter. */
export const QUESTION_TIME_PROPOSAL_PRODUCER_ID = "alaya.query.question-time.v1";
/** Omission means unrestricted capture; a rank is local to its explicit domain. */
export const QuestionTimeCaptureDomainSchema = z.literal("question_time");
export const QuestionTimePreferenceSchema = z.object({
  interpretation_clock: IsoDatetimeStringSchema,
  intervals: z.array(z.object({ start: z.iso.date(), end: z.iso.date() }).strict()
    .refine(value => value.start <= value.end, "calendar interval must be ordered").readonly()).max(32).readonly()
}).strict().readonly();
export type QuestionTimePreference = z.infer<typeof QuestionTimePreferenceSchema>;
