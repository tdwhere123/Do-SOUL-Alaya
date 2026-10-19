import { z } from "zod";
import { AlayaError, RequestBudgetSchema, SourceSemanticAccessPolicySchema } from "@do-soul/alaya-protocol";

const Policy = SourceSemanticAccessPolicySchema;
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** A private bench diagnostic. It never changes the public recall contract. */
export const SourceAccessDiagnosticConfigSchema = z.object({
  contract: z.literal("source-access-diagnostic-config-v1"),
  source_run_root: z.string().min(1),
  prepared_path: z.string().min(1),
  expected_question_ids: z.array(z.string().min(1)).min(1).max(20),
  policies: z.tuple([z.literal("query-conditioned-v1"), z.literal("canonical-v1")]),
  budget: RequestBudgetSchema,
  limits: z.object({
    max_total_work: z.number().int().positive(),
    max_pages: z.number().int().positive().max(800),
    max_pages_per_observation: z.number().int().positive().max(32),
    max_wall_ms: z.number().int().positive(),
    max_output_bytes: z.number().int().min(144 * 1024),
    max_disk_bytes: z.number().int().min(256 * 1024)
  }).strict()
}).strict();
export type SourceAccessDiagnosticConfig = z.infer<typeof SourceAccessDiagnosticConfigSchema>;

const ArtifactRef = z.object({ path: z.string().min(1), identity: Digest }).strict();
const AttemptEvidence = z.object({ page_number: z.number().int().nonnegative(),
  started: ArtifactRef, result: ArtifactRef.nullable(), page: ArtifactRef.nullable() }).strict();
export type SourceAccessArtifactRef = z.infer<typeof ArtifactRef>;

export const SourceAccessDiagnosticRowSchema = z.object({
  question_id: z.string().min(1),
  index: z.number().int().nonnegative().nullable(),
  policy: Policy,
  status: z.enum(["observed", "partial", "failed", "unattempted"]),
  reason: z.string().nullable(),
  page_paths: z.array(z.string()),
  attempt_paths: z.array(z.string()),
  attempt_evidence: z.array(AttemptEvidence),
  attempted_pages: z.number().int().nonnegative(),
  settled_pages: z.number().int().nonnegative(),
  unresolved_attempts: z.number().int().nonnegative(),
  pool_id: z.string().nullable(),
  observed_source_count: z.number().int().nonnegative().nullable(),
  retained_source_count: z.number().int().nonnegative(),
  unretained_observed_sources: z.number().int().nonnegative().nullable(),
  unvisited_sources: z.boolean().nullable(),
  incomplete_source_bodies: z.number().int().nonnegative(),
  source_read_bytes: z.number().int().nonnegative(),
  stopping_reasons: z.array(z.string()),
  initial_logical_work: z.number().int().nonnegative(),
  continuation_logical_work: z.number().int().nonnegative(),
  native_work: z.number().int().nonnegative(),
  logical_work: z.number().int().nonnegative(),
  native_bytes: z.number().int().nonnegative(),
  wall_ms: z.number().nonnegative()
}).strict();
export type SourceAccessDiagnosticRow = z.infer<typeof SourceAccessDiagnosticRowSchema>;

export const SourceAccessDiagnosticObservationSchema = z.object({
  contract: z.literal("source-access-diagnostic-observation-v2"),
  config: SourceAccessDiagnosticConfigSchema,
  freeze_identity: Digest.nullable(),
  prepared_identity: Digest.nullable(),
  implementation_revision: z.string().min(1).nullable(),
  start_artifact: ArtifactRef,
  rows: z.array(SourceAccessDiagnosticRowSchema),
  status: z.enum(["complete", "stopped"]),
  stop_reason: z.string().nullable(),
  total_pages: z.number().int().nonnegative(),
  attempted_pages: z.number().int().nonnegative(),
  settled_pages: z.number().int().nonnegative(),
  unresolved_attempts: z.number().int().nonnegative(),
  total_logical_work: z.number().int().nonnegative(),
  output_bytes_before_summary: z.number().int().nonnegative(),
  observation_bytes: z.number().int().nonnegative(),
  output_bytes: z.number().int().nonnegative(),
  source_disk_bytes: z.number().int().nonnegative().nullable(),
  disk_bytes_before_summary: z.number().int().nonnegative(),
  disk_bytes_peak_observed: z.number().int().nonnegative(),
  disk_bytes_at_stop: z.number().int().nonnegative().nullable(),
  disk_admission_snapshot_bytes: z.number().int().nonnegative().nullable(),
  disk_limit_scope: z.literal("checkpointed_snapshot_reservation_not_hard_cap"),
  wall_limit_scope: z.literal("checkpointed_not_hard_deadline"),
  summary_reserved_bytes: z.number().int().positive(),
  wall_ms: z.number().nonnegative(),
  provider_calls: z.literal(0),
  embedding_calls: z.literal(0),
  public_recall: z.literal("not_exercised"),
  delivered_top5: z.literal("not_exercised"),
  proof: z.literal("not_exercised"),
  payload: z.literal("not_exercised"),
  first_exposure: z.literal("not_exercised")
}).strict();
export type SourceAccessDiagnosticObservation = z.infer<typeof SourceAccessDiagnosticObservationSchema>;

const PoolMetric = z.enum(["hit", "miss", "unknown"]);
export const SourceAccessDiagnosticEvaluationSchema = z.object({
  contract: z.literal("source-access-diagnostic-evaluation-v2"),
  observation_identity: Digest,
  freeze_identity: Digest.nullable(),
  rows: z.array(z.object({
    question_id: z.string().min(1), index: z.number().int().nonnegative().nullable(), policy: Policy,
    status: z.enum(["measured", "unknown", "unattempted"]), reason: z.string().nullable(),
    observation_status: SourceAccessDiagnosticRowSchema.shape.status,
    attempted_pages: z.number().int().nonnegative(),
    first_gold_source_rank: z.number().int().positive().nullable(),
    first_gold_session_rank: z.number().int().positive().nullable(),
    source_rank_unit: z.literal("source_root"),
    session_rank_unit: z.literal("distinct_session"),
    pool_k_unit: z.literal("source_root"),
    rank_censored: z.boolean(),
    discovery_complete: z.boolean().nullable(),
    pool_at_5: PoolMetric, pool_at_20: PoolMetric, pool_at_30: PoolMetric, pool_at_50: PoolMetric
  }).strict()),
  summary: z.array(z.object({ policy: Policy, k: z.union([z.literal(5), z.literal(20), z.literal(30), z.literal(50)]),
    denominator: z.number().int().positive(), hits: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(),
    unattempted: z.number().int().nonnegative(),
    unknown_before_attempt: z.number().int().nonnegative(),
    unknown_after_attempt: z.number().int().nonnegative(),
    pool_k_unit: z.literal("source_root")
  }).strict()),
  provider_calls: z.literal(0), embedding_calls: z.literal(0),
  public_recall: z.literal("not_exercised"), delivered_top5: z.literal("not_exercised"),
  proof: z.literal("not_exercised"), payload: z.literal("not_exercised"),
  first_exposure: z.literal("not_exercised")
}).strict();
export type SourceAccessDiagnosticEvaluation = z.infer<typeof SourceAccessDiagnosticEvaluationSchema>;

export const NOT_EXERCISED = {
  provider_calls: 0, embedding_calls: 0, public_recall: "not_exercised",
  delivered_top5: "not_exercised", proof: "not_exercised", payload: "not_exercised",
  first_exposure: "not_exercised"
} as const;

export class UnverifiedProviderCallEvidenceError extends AlayaError {
  public constructor(message: string) {
    super("CONFLICT", message);
    this.name = "UnverifiedProviderCallEvidenceError";
  }
}

/**
 * The diagnostic envelope's literal zero is admissible only when the native
 * execution receipt itself reports zero external attempts. A nullable count is
 * unknown evidence, not observed zero, and must reject the run instead of being
 * promoted to zero.
 */
export function assertNoProviderCalls(attempts: number | null): void {
  if (attempts !== 0) {
    throw new UnverifiedProviderCallEvidenceError(
      "native execution receipt does not verify zero diagnostic provider calls"
    );
  }
}
