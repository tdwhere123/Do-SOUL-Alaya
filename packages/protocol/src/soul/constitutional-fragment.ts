import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../schema-primitives.js";

export const ConstitutionalFragmentCategorySchema = z.enum([
  "hard_constraint",
  "baseline_policy",
  "operational_principle"
]);
export const ConstitutionalFragmentIdSchema = NonEmptyStringSchema.brand<"ConstitutionalFragmentId">();

export const ConstitutionalFragmentSchema = z
  .object({
    fragment_id: ConstitutionalFragmentIdSchema,
    workspace_id: NonEmptyStringSchema,
    category: ConstitutionalFragmentCategorySchema,
    content: NonEmptyStringSchema,
    authority_source: NonEmptyStringSchema,
    immutable: z.literal(true),
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ConstitutionalFragmentRegistrationSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    category: ConstitutionalFragmentCategorySchema,
    content: NonEmptyStringSchema,
    authority_source: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export function listConstitutionalFragmentIdentityParts(
  registration: Readonly<ConstitutionalFragmentRegistration>
): readonly [string, ConstitutionalFragmentCategory, string, string] {
  return Object.freeze([
    registration.workspace_id,
    registration.category,
    registration.authority_source,
    registration.content
  ]) as readonly [string, ConstitutionalFragmentCategory, string, string];
}

export type ConstitutionalFragmentCategory = z.infer<
  typeof ConstitutionalFragmentCategorySchema
>;
export type ConstitutionalFragmentId = z.infer<typeof ConstitutionalFragmentIdSchema>;
export type ConstitutionalFragment = z.infer<typeof ConstitutionalFragmentSchema>;
export type ConstitutionalFragmentRegistration = z.infer<
  typeof ConstitutionalFragmentRegistrationSchema
>;
