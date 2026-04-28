import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { ObjectKind } from "./object-kind.js";

const conflictEdgeTypeValues = [
  "incompatible_with",
  "exception_to",
  "supersedes",
  "overrides_within_scope",
  "supports",
  "derives_from"
] as const;

export const ConflictEdgeType = {
  INCOMPATIBLE_WITH: "incompatible_with",
  EXCEPTION_TO: "exception_to",
  SUPERSEDES: "supersedes",
  OVERRIDES_WITHIN_SCOPE: "overrides_within_scope",
  SUPPORTS: "supports",
  DERIVES_FROM: "derives_from"
} as const;

export const ConflictEdgeTypeSchema = z.enum(conflictEdgeTypeValues);

export const ConflictMatrixEdgeSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.CONFLICT_MATRIX_EDGE),
    source_claim_id: NonEmptyStringSchema,
    target_claim_id: NonEmptyStringSchema,
    edge_type: ConflictEdgeTypeSchema,
    created_at: IsoDatetimeStringSchema,
    workspace_id: NonEmptyStringSchema
  })
  .readonly();

export type ConflictEdgeType = z.infer<typeof ConflictEdgeTypeSchema>;
export type ConflictMatrixEdge = z.infer<typeof ConflictMatrixEdgeSchema>;
