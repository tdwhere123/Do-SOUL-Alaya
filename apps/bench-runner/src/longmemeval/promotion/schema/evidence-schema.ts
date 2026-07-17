import { z } from "zod";
import { LongMemEvalSelectionContractIdentitySchema } from "@do-soul/alaya-eval";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ArtifactRoleSchema = z.enum([
  "kpi",
  "report",
  "findings",
  "rank_identity",
  "run_provenance",
  "recall_eval_diagnostics"
]);

export const RecallEvalPromotionManifestSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval_evidence_bundle"),
  profile: z.literal("recall_eval"),
  run: z.object({
    slug: z.string().min(1),
    bench_name: z.literal("public"),
    split: z.literal("longmemeval-s"),
    run_at: z.string().min(1),
    alaya_commit: z.string().regex(/^[a-f0-9]{7}$/u),
    dataset_sha256: Sha256Schema,
    selection_manifest_sha256: z.null(),
    question_id_digest: Sha256Schema,
    selection_contract: LongMemEvalSelectionContractIdentitySchema,
    candidate_pool_complete: z.literal(true),
    provenance_complete: z.literal(true)
  }).strict(),
  evidence_status: z.literal("complete"),
  artifacts: z.array(z.object({
    role: ArtifactRoleSchema,
    path: z.string().min(1),
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative()
  }).strict()).readonly(),
  bundle_sha256: Sha256Schema
}).strict();

export const RecallEvalRankIdentitySchema = z.object({
  schema_version: z.literal(2),
  snapshot_binding: z.object({
    expected_question_count: z.number().int().positive(),
    expected_question_id_digest: Sha256Schema
  }).strict(),
  replay: z.object({
    question_count: z.number().int().positive(),
    question_id_digest: Sha256Schema,
    full_snapshot_match: z.literal(true)
  }).strict(),
  questions: z.array(z.object({
    question_id: z.string().min(1),
    delivered_objects: z.array(z.object({
      object_id: z.string().min(1),
      object_kind: z.string().min(1)
    }).strict()).readonly()
  }).strict()).readonly()
}).strict();

export type RecallEvalPromotionManifest = z.infer<
  typeof RecallEvalPromotionManifestSchema
>;
export type RecallEvalRankIdentity = z.infer<typeof RecallEvalRankIdentitySchema>;
