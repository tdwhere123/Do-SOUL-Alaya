import { z } from "zod";
import {
  CanonicalD0DispositionSchema,
  RecallOriginPlaneSchema
} from "@do-soul/alaya-protocol";

const RecallDiagnosticObjectKindSchema = z.enum([
  "memory_entry",
  "evidence_capsule",
  "synthesis_capsule"
]);

export const CanonicalD0CandidateDiagnosticSchema = z.object({
  schema_version: z.literal(1),
  ranking_authority: z.literal("d0_prefix"),
  d0_receipt_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  candidate_key: z.string().min(1),
  object_id: z.string().min(1),
  object_kind: RecallDiagnosticObjectKindSchema,
  created_at: z.string().min(1),
  dimension: z.string().min(1),
  origin_plane: RecallOriginPlaneSchema,
  admission_planes: z.array(z.string().min(1)).readonly(),
  plane_first_admitted: z.string().min(1),
  plane_winning_admission: z.string().min(1),
  admission_attempts: z.tuple([]).readonly(),
  final_rank: z.number().int().positive().nullable(),
  post_rank: z.number().int().positive().nullable(),
  in_final_packet: z.boolean(),
  eviction_reason: z.string().min(1).nullable(),
  dropped_reason: z.string().min(1).nullable(),
  within_budget: z.boolean(),
  source_channels: z.array(z.string().min(1)).readonly(),
  d0_disposition: CanonicalD0DispositionSchema,
  legacy_selection: z.object({
    fusion: z.literal("not_applicable"),
    deep_head: z.literal("not_applicable"),
    coverage: z.literal("not_applicable")
  }).strict().readonly()
}).strict().readonly();
