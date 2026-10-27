import { z } from "zod";
import { ConditionalFieldIdSchema, Sha256DigestSchema } from "./common.js";
import { QuestionTimeCaptureDomainSchema } from "./question-time.js";

export const ORDINARY_NATIVE_FIELD_RESULT_VERSION = "ordinary-native-field.v5" as const;

/** Ordinal discovery evidence, not an association grade or factual support. */
export const RecallNavigationWitnessSchema = z.object({
  contract: z.literal("native-query-navigation.v1"),
  query_digest: Sha256DigestSchema,
  view: z.enum(["original", "hint"]),
  operator: z.enum(["source_lexical", "source_vector", "memory_lexical", "bound_catalog"]),
  ordinal: z.number().int().nonnegative(),
  access_ordinal: z.number().int().nonnegative().optional(),
  native_rank: z.number().int().positive().optional(),
  /** Restricted lexical capture; does not change the factual native rank. */
  domain: QuestionTimeCaptureDomainSchema.optional(),
  reference: ConditionalFieldIdSchema,
  location: z.object({
    start_byte: z.number().int().nonnegative(),
    end_byte: z.number().int().positive()
  }).strict().refine(value => value.end_byte > value.start_byte).readonly().optional()
}).strict().readonly();

export type RecallNavigationWitness = z.infer<typeof RecallNavigationWitnessSchema>;
