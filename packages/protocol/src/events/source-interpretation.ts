import { z } from "zod";
import { BoundedIdSchema, IsoDatetimeStringSchema } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { AuthorizedScopesAdmissionSchema } from "../governance/active-constraints-policy.js";

export const SourceInterpretationEventTypeSchema = z.enum(["source.interpretation.invalidated"]);

/** Caller-reported grounds for retiring a hypothesis; these do not certify source truth. */
export const SourceInterpretationErrorBasisSchema = z.object({
  reason: z.string().trim().min(1).max(2048),
  basis_ref: BoundedIdSchema.optional()
}).strict().readonly();
const SourceInterpretationInvalidationProvenanceSchema = z.object({
  reporter_id: BoundedIdSchema,
  principal: BoundedIdSchema.optional(),
  preparation_handle: BoundedIdSchema.optional()
}).strict().readonly();
const SourceInterpretationInvalidationSourceSchema = z.object({
  source_id: BoundedIdSchema,
  source_version: BoundedIdSchema,
  content_digest: Sha256DigestSchema
}).strict().readonly();

export const SourceInterpretationInvalidationSchema = z.object({
  workspace_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  source_interpretation_id: Sha256DigestSchema,
  source: SourceInterpretationInvalidationSourceSchema,
  error_basis: SourceInterpretationErrorBasisSchema,
  provenance: SourceInterpretationInvalidationProvenanceSchema,
  authorized_scopes: AuthorizedScopesAdmissionSchema
}).strict().readonly();

export const SourceInterpretationInvalidationResultSchema = z.object({
  status: z.enum(["invalidated", "already_invalidated"]),
  source_interpretation_id: Sha256DigestSchema,
  evidence_object_id: BoundedIdSchema
}).strict().readonly();

export const SourceInterpretationInvalidatedPayloadSchema = z.object({
  ...SourceInterpretationInvalidationSchema.unwrap().shape,
  evidence_object_id: BoundedIdSchema,
  from_state: z.literal("active"),
  to_state: z.literal("archived"),
  semantic_status: z.literal("unreviewed"),
  occurred_at: IsoDatetimeStringSchema
}).strict().readonly();

export type SourceInterpretationInvalidation = z.infer<typeof SourceInterpretationInvalidationSchema>;
export type SourceInterpretationInvalidationResult = z.infer<typeof SourceInterpretationInvalidationResultSchema>;
