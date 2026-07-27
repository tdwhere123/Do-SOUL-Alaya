import { z } from "zod";

export const BenchEvidenceEmbeddingStatusSchema = z.enum([
  "not_requested",
  "not_applicable",
  "returned",
  "failed"
]);

export const BenchEvidenceEmbeddingFailureClassSchema = z.enum([
  "provider_unavailable",
  "query_embedding_failed",
  "candidate_embedding_failed",
  "service_error"
]);

export const BenchAnswerRerankStatusSchema = z.enum([
  "not_requested",
  "not_applicable",
  "returned",
  "failed"
]);

export const BenchAnswerRerankFailureClassSchema = z.enum([
  "invalid_score_count",
  "invalid_score_value",
  "service_error"
]);

export const RecallMultiSeedGraphFanInDiagnosticsSchema = z
  .object({
    distinct_seeds: z.number().int().nonnegative(),
    candidates_per_seed_p50: z.number().nonnegative(),
    candidates_per_seed_p95: z.number().nonnegative(),
    dedup_collisions: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

const RecallPacketPlanDecisionSchema = z
  .object({
    status: z.enum(["not_attempted", "rejected", "accepted"]),
    challenger_candidate_key: z.string().min(1).nullable(),
    victim_candidate_key: z.string().min(1).nullable(),
    reason: z.string().min(1).nullable()
  })
  .strict()
  .readonly();

export const RecallPacketPlanTraceSchema = z
  .object({
    schema_version: z.literal(1),
    assessment_path: z.enum(["legacy", "snapshot"]),
    baseline_candidate_keys: z.array(z.string().min(1)).readonly(),
    planned_candidate_keys: z.array(z.string().min(1)).readonly().nullable(),
    actual_candidate_keys: z.array(z.string().min(1)).readonly(),
    decision: RecallPacketPlanDecisionSchema
  })
  .strict()
  .readonly();

export type BenchRecallPacketPlanTrace = z.infer<
  typeof RecallPacketPlanTraceSchema
>;
