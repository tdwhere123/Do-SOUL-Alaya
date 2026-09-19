import { z } from "zod";
import { BoundedLabelSchema } from "../../shared/schema-primitives.js";
import { Sha256DigestSchema } from "./common.js";

export const SOURCE_SEMANTIC_CONTEXT_CONTRACT = "source-semantic-context-v2" as const;

export const SourceSemanticEvaluationContextSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_CONTEXT_CONTRACT),
  h_id: Sha256DigestSchema,
  q_id: Sha256DigestSchema,
  a_id: Sha256DigestSchema,
  k_version: BoundedLabelSchema,
  lowering_version: BoundedLabelSchema
}).strict().readonly();

export type SourceSemanticEvaluationContext = z.infer<typeof SourceSemanticEvaluationContextSchema>;
