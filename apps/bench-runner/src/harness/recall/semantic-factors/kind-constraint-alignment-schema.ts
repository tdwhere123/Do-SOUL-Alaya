import { z } from "zod";
import {
  KIND_PROJECTION_AUTHORITY,
  KindProjectionSchema,
  KindProjectionStatusSchema
} from "@do-soul/alaya-protocol";

export const KindConstraintAlignmentReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal("kind_constraint_alignment_v1"),
  authority: z.literal(KIND_PROJECTION_AUTHORITY),
  status: KindProjectionStatusSchema,
  answer_variable_id: z.string(),
  answer_kind_constraint: z.string(),
  evidence_graph_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  alignments: z.array(z.object({
    variable_id: z.string(),
    factor_id: z.string(),
    answer_identity: z.string(),
    kind_identity: z.string(),
    projection_digest: z.string()
  }).readonly()).readonly(),
  projections: z.array(KindProjectionSchema).readonly(),
  receipt_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u)
}).readonly();
