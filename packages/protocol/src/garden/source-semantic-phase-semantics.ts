import { z } from "zod";
import { SourceIndexLexicalBindingSchema } from "../recall/source-index-lexical.js";
import { BoundedIdSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceIndexProfileSchema, SourceIndexTargetSchema } from "../recall/source-index.js";

const Completion = z.enum(["complete", "partial", "unavailable", "not_run"]);
const SourceSemanticPhaseResourcesSchema = z.object({ work: NonNegativeIntSchema, memory_bytes: NonNegativeIntSchema,
  native_bytes: NonNegativeIntSchema, sql_internal_work: z.literal("unknown") }).strict().readonly();
const SourceSemanticRoutePreparationSchema = z.object({
  status: z.enum(["ready", "unavailable", "failed", "not_requested"]), reason: z.string().nullable(),
  navigation_digest: Sha256DigestSchema.nullable(),
  selected: z.object({ selection_revision: NonNegativeIntSchema, config_id: Sha256DigestSchema,
    profile_id: Sha256DigestSchema, profile: SourceIndexProfileSchema }).strict().readonly().nullable(),
  method: z.enum(["not_run", "local_inference", "external_api"]), submitted_inputs: NonNegativeIntSchema,
  token_count: NonNegativeIntSchema.nullable(), external_api_attempts: NonNegativeIntSchema.nullable(),
  binding_work: z.enum(["not_run", "unknown"]), execution_work: z.enum(["not_run", "unknown"]), elapsed_ms: z.number().nonnegative().nullable()
}).strict().readonly();
/** Primary slots always describe original navigation; supplemental slots describe a distinct hint. */
export const SourceSemanticQueryPreparationSchema = SourceSemanticRoutePreparationSchema.unwrap().extend({
  supplemental: z.array(SourceSemanticRoutePreparationSchema).min(1).max(1).readonly().optional()
}).strict().readonly();
export type SourceSemanticQueryPreparation = z.infer<typeof SourceSemanticQueryPreparationSchema>;
export const SourceSemanticVectorBindingSchema = z.object({ workspace_id: BoundedIdSchema, selection_revision: NonNegativeIntSchema,
  config_id: Sha256DigestSchema, profile_id: Sha256DigestSchema, generation_id: Sha256DigestSchema,
  source_epoch: NonNegativeIntSchema, dimensions: NonNegativeIntSchema }).strict().readonly();
const VectorState = z.union([
  z.object({ status: z.enum(["ready", "partial", "valid_empty"]), binding: SourceSemanticVectorBindingSchema }).strict().readonly(),
  z.object({ status: z.enum(["unknown", "unbound", "unavailable"]), reason: z.string() }).strict().readonly()
]);
const LexicalRank = z.object({ rank: NonNegativeIntSchema, lane: z.enum(["unicode61", "trigram"]),
  lane_rank: NonNegativeIntSchema, bm25: z.number().finite() }).strict().readonly();
export const SourceSemanticQueryWindowSchema = z.object({ window_id: Sha256DigestSchema, start_byte: NonNegativeIntSchema,
  end_byte: NonNegativeIntSchema, content_digest: Sha256DigestSchema }).strict().readonly();
const Tokenization = z.object({ policy: z.literal("source-index-fts.v1"), binding_digest: Sha256DigestSchema,
  cjk_state: z.enum(["uninitialized", "loading", "ready", "unavailable"]), terms: z.array(z.string()).readonly(),
  unicode61_terms: z.array(z.string()).readonly(), trigram_terms: z.array(z.string()).readonly(),
  lexical_binding: SourceIndexLexicalBindingSchema.optional() }).strict().readonly();
export const SourceSemanticAcquisitionSchema = z.object({
  policy: z.literal("source-index-interleaved-prefix.v1"), navigation_digest: Sha256DigestSchema.nullable(),
  completion: Completion,
  nominations: z.array(z.object({ source: SourceIndexTargetSchema, lexical: z.array(LexicalRank).readonly(),
    vector: z.object({ rank: NonNegativeIntSchema, cosine: z.number().finite(), window: SourceSemanticQueryWindowSchema }).strict().readonly().nullable()
  }).strict().readonly()).max(16).readonly(),
  accounting: z.object({ attempted: NonNegativeIntSchema, admitted: NonNegativeIntSchema, duplicate: NonNegativeIntSchema,
    rejected: NonNegativeIntSchema, scope_denied: NonNegativeIntSchema, native_unknown: NonNegativeIntSchema,
    resource_refused: NonNegativeIntSchema, stale: NonNegativeIntSchema, nomination_limit: NonNegativeIntSchema }).strict().readonly(),
  resources: SourceSemanticPhaseResourcesSchema,
  resource_refusals: z.array(z.object({ stage: z.enum(["input", "lexical", "vector", "admission", "nomination"]),
    phase: z.string() }).strict().readonly()).readonly(),
  lexical: z.object({ completion: Completion, index_coverage: z.literal("partial"), reason: z.string().nullable(),
    limitations: z.array(z.string()).readonly(), tokenization: Tokenization.nullable() }).strict().readonly(),
  vector: z.object({ completion: Completion, state: VectorState.nullable(), reason: z.string().nullable(),
    inspected_windows: NonNegativeIntSchema, invalid_windows: NonNegativeIntSchema,
    validation: z.enum(["not_run", "validated", "invalid", "not_applicable"]), ranking: z.literal("exact_over_inspected_subset"),
    input: z.union([
      z.object({ status: z.literal("available"), profile_id: Sha256DigestSchema, input_digest: Sha256DigestSchema }).strict().readonly(),
      z.object({ status: z.literal("unavailable"), reason: z.string() }).strict().readonly()
    ]) }).strict().readonly(),
  limitations: z.array(z.string()).readonly()
}).strict().readonly();
const SourceSemanticRouteAcquisitionSchema = z.object({
  policy: z.literal("source-index-interleaved-prefix.v1"),
  status: z.enum(["executed", "not_run", "failed"]), reason: z.string().nullable(),
  allowance: z.object({ max_attempts: NonNegativeIntSchema, max_roots: NonNegativeIntSchema,
    max_vector_windows: NonNegativeIntSchema }).strict().readonly(),
  budget: z.object({ work_units: NonNegativeIntSchema, memory_bytes: NonNegativeIntSchema }).strict().readonly(),
  result: SourceSemanticAcquisitionSchema.nullable(),
  accounting: z.enum(["complete", "partial", "not_run"])
}).strict().readonly();
export const SourceSemanticAcquisitionPhaseSchema = SourceSemanticRouteAcquisitionSchema.unwrap().extend({
  supplemental: z.array(SourceSemanticRouteAcquisitionSchema).min(1).max(1).readonly().optional()
}).strict().readonly();
export type SourceSemanticAcquisitionPhase = z.infer<typeof SourceSemanticAcquisitionPhaseSchema>;
export function sourceSemanticAcquisitionNotRun(reason: string): SourceSemanticAcquisitionPhase {
  return { policy: "source-index-interleaved-prefix.v1", status: "not_run", reason,
    allowance: { max_attempts: 0, max_roots: 0, max_vector_windows: 0 },
    budget: { work_units: 0, memory_bytes: 0 }, result: null, accounting: "not_run" };
}
export function unavailableSourceQueryPreparation(reason: string, status: "unavailable" | "not_requested" = "unavailable"):
  SourceSemanticQueryPreparation {
  return { status, reason, navigation_digest: null, selected: null, method: "not_run", submitted_inputs: 0,
    token_count: null, external_api_attempts: 0, binding_work: "not_run", execution_work: "not_run",
    elapsed_ms: status === "not_requested" ? 0 : null };
}

export type SourceSemanticAcquisition = z.infer<typeof SourceSemanticAcquisitionSchema>;
export const SourceSemanticPhaseAccountingSchema = z.object({
  observation: SourceSemanticPhaseResourcesSchema.nullable(),
  completion: z.literal("included_in_worker_work_not_separately_measured"),
  native_cpu: z.literal("unknown"), deadline: z.literal("soft_quarantine_until_exit")
}).strict().readonly();
export type SourceSemanticPhaseAccounting = z.infer<typeof SourceSemanticPhaseAccountingSchema>;
/** Expanded meaning remains authoritative; public wire admission is a separate, non-transforming schema. */
export const SourceSemanticExecutionPhasesSchema = z.object({
  contract: z.literal("source-semantic-execution-v3"), query_preparation: SourceSemanticQueryPreparationSchema,
  acquisition: SourceSemanticAcquisitionPhaseSchema, semantic_generation_attempts: z.literal(0)
}).strict().readonly();
export type SourceSemanticExecutionPhases = z.infer<typeof SourceSemanticExecutionPhasesSchema>;
