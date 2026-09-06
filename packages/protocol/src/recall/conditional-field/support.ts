import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import { ConditionalFieldIdSchema, SchemaVersionSchema } from "./common.js";

export const ClaimStateSchema = z.enum(["supported", "refuted", "conflict", "unknown"]);

export const WitnessSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    witness_id: ConditionalFieldIdSchema,
    premises: z.array(ConditionalFieldIdSchema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    cost: NonNegativeIntSchema,
    complete: z.boolean()
  })
  .strict()
  .readonly();

export const SupportRecordSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    proposition_id: ConditionalFieldIdSchema,
    claim: ClaimStateSchema,
    witnesses: z.array(WitnessSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const PropositionSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    proposition_id: ConditionalFieldIdSchema,
    kind: BoundedLabelSchema,
    arguments: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export type ClaimState = z.infer<typeof ClaimStateSchema>;
export type Witness = z.infer<typeof WitnessSchema>;
export type SupportRecord = z.infer<typeof SupportRecordSchema>;
export type Proposition = z.infer<typeof PropositionSchema>;
