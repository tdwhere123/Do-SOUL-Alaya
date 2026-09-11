import { z } from "zod";
import { BOUNDED_DEFAULT_ARRAY_MAX } from "../../shared/schema-primitives.js";
import {
  ConditionalFieldIdSchema,
  FacetModeSchema,
  MilligradeSchema,
  Sha256DigestSchema
} from "./common.js";

export const FacetObligationRequirednessSchema = z.enum(["required", "optional"]);
export const FacetObligationPredicateSchema = z.enum(["threshold"]);

export const QueryFacetObligationSchema = z
  .object({
    obligation_id: ConditionalFieldIdSchema,
    domain_id: ConditionalFieldIdSchema,
    predicate: FacetObligationPredicateSchema.default("threshold"),
    requiredness: FacetObligationRequirednessSchema,
    threshold_milligrades: MilligradeSchema,
    cap_contract_id: Sha256DigestSchema.optional(),
    witness_compatibility: FacetModeSchema.default("same_path"),
    version: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export const QueryFacetObligationListSchema = z
  .array(QueryFacetObligationSchema)
  .max(BOUNDED_DEFAULT_ARRAY_MAX)
  .readonly()
  .superRefine((rows, context) => {
    const keys = rows.map((row) => `${row.obligation_id}\0${row.domain_id}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "facet obligation identities must be unique"
      });
    }
  });

export type FacetObligationRequiredness = z.infer<typeof FacetObligationRequirednessSchema>;
export type FacetObligationPredicate = z.infer<typeof FacetObligationPredicateSchema>;
export type QueryFacetObligation = z.infer<typeof QueryFacetObligationSchema>;
