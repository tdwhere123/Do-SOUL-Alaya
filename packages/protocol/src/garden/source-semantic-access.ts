import { z } from "zod";
import { BoundedIdSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceIndexProfileSchema, SourceIndexTargetSchema } from "../recall/source-index.js";

const Completion = z.enum(["complete", "partial", "unavailable", "not_run"]);
const Resources = z.object({ work: NonNegativeIntSchema, memory_bytes: NonNegativeIntSchema,
  native_bytes: NonNegativeIntSchema, sql_internal_work: z.literal("unknown") }).strict().readonly();
export const SourceSemanticQueryPreparationSchema = z.object({
  status: z.enum(["ready", "unavailable", "failed", "not_requested"]), reason: z.string().nullable(),
  navigation_digest: Sha256DigestSchema.nullable(),
  selected: z.object({ selection_revision: NonNegativeIntSchema, config_id: Sha256DigestSchema,
    profile_id: Sha256DigestSchema, profile: SourceIndexProfileSchema }).strict().readonly().nullable(),
  method: z.enum(["not_run", "local_inference", "external_api"]), submitted_inputs: NonNegativeIntSchema,
  token_count: NonNegativeIntSchema.nullable(), external_api_attempts: NonNegativeIntSchema.nullable(),
  binding_work: z.enum(["not_run", "unknown"]), execution_work: z.enum(["not_run", "unknown"]), elapsed_ms: z.number().nonnegative().nullable()
}).strict().readonly();
export type SourceSemanticQueryPreparation = z.infer<typeof SourceSemanticQueryPreparationSchema>;
const Binding = z.object({ workspace_id: BoundedIdSchema, selection_revision: NonNegativeIntSchema,
  config_id: Sha256DigestSchema, profile_id: Sha256DigestSchema, generation_id: Sha256DigestSchema,
  source_epoch: NonNegativeIntSchema, dimensions: NonNegativeIntSchema }).strict().readonly();
const VectorState = z.union([
  z.object({ status: z.enum(["ready", "partial", "valid_empty"]), binding: Binding }).strict().readonly(),
  z.object({ status: z.enum(["unknown", "unbound", "unavailable"]), reason: z.string() }).strict().readonly()
]);
const LexicalRank = z.object({ rank: NonNegativeIntSchema, lane: z.enum(["unicode61", "trigram"]),
  lane_rank: NonNegativeIntSchema, bm25: z.number().finite() }).strict().readonly();
const Window = z.object({ window_id: Sha256DigestSchema, start_byte: NonNegativeIntSchema,
  end_byte: NonNegativeIntSchema, content_digest: Sha256DigestSchema }).strict().readonly();
const Tokenization = z.object({ policy: z.literal("source-index-fts.v1"), binding_digest: Sha256DigestSchema,
  cjk_state: z.enum(["uninitialized", "loading", "ready", "unavailable"]), terms: z.array(z.string()).readonly(),
  unicode61_terms: z.array(z.string()).readonly(), trigram_terms: z.array(z.string()).readonly() }).strict().readonly();
export const SourceSemanticAcquisitionSchema = z.object({
  policy: z.literal("source-index-interleaved-prefix.v1"), navigation_digest: Sha256DigestSchema.nullable(),
  completion: Completion,
  nominations: z.array(z.object({ source: SourceIndexTargetSchema, lexical: z.array(LexicalRank).readonly(),
    vector: z.object({ rank: NonNegativeIntSchema, cosine: z.number().finite(), window: Window }).strict().readonly().nullable()
  }).strict().readonly()).max(16).readonly(),
  accounting: z.object({ attempted: NonNegativeIntSchema, admitted: NonNegativeIntSchema, duplicate: NonNegativeIntSchema,
    rejected: NonNegativeIntSchema, scope_denied: NonNegativeIntSchema, native_unknown: NonNegativeIntSchema,
    resource_refused: NonNegativeIntSchema, stale: NonNegativeIntSchema, nomination_limit: NonNegativeIntSchema }).strict().readonly(),
  resources: Resources,
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
export const SourceSemanticAcquisitionPhaseSchema = z.object({
  policy: z.literal("source-index-interleaved-prefix.v1"),
  status: z.enum(["executed", "not_run", "failed"]), reason: z.string().nullable(),
  allowance: z.object({ max_attempts: NonNegativeIntSchema, max_roots: NonNegativeIntSchema,
    max_vector_windows: NonNegativeIntSchema }).strict().readonly(),
  budget: z.object({ work_units: NonNegativeIntSchema, memory_bytes: NonNegativeIntSchema }).strict().readonly(),
  result: SourceSemanticAcquisitionSchema.nullable(),
  accounting: z.enum(["complete", "partial", "not_run"])
}).strict().readonly();
export type SourceSemanticAcquisitionPhase = z.infer<typeof SourceSemanticAcquisitionPhaseSchema>;
export function sourceSemanticAcquisitionNotRun(reason: string): SourceSemanticAcquisitionPhase {
  return { policy: "source-index-interleaved-prefix.v1", status: "not_run", reason,
    allowance: { max_attempts: 0, max_roots: 0, max_vector_windows: 0 },
    budget: { work_units: 0, memory_bytes: 0 }, result: null, accounting: "not_run" };
}
/** No model generation is performed by the native access owner. Inference is a separate phase. */
const SourceSemanticExecutionPhasesSchema = z.object({
  contract: z.literal("source-semantic-execution-v2"),
  query_preparation: SourceSemanticQueryPreparationSchema,
  acquisition: SourceSemanticAcquisitionPhaseSchema,
  semantic_generation_attempts: z.literal(0)
}).strict().readonly();
export const SourceSemanticExecutionSchema = z.union([
  z.literal("native_reasoning_only"), SourceSemanticExecutionPhasesSchema
]);
export type SourceSemanticExecution = z.infer<typeof SourceSemanticExecutionSchema>;
type ExecutionPhases = z.infer<typeof SourceSemanticExecutionPhasesSchema>;

/** The literal implies only these canonical phase receipts, never zero native read/solver work. */
function nativeReasoningPhases(): ExecutionPhases {
  return { contract: "source-semantic-execution-v2",
    query_preparation: unavailableSourceQueryPreparation("operation_does_not_prepare", "not_requested"),
    acquisition: sourceSemanticAcquisitionNotRun("operation_does_not_acquire"), semantic_generation_attempts: 0 };
}

/** Exact canonical equality preserves nonstandard reasons, resources and unknown measurements. */
export function isNativeReasoningOnlyExecution(execution: SourceSemanticExecution): boolean {
  if (execution === "native_reasoning_only") return true;
  const canonical = nativeReasoningPhases();
  const preparation = execution.query_preparation, acquisition = execution.acquisition;
  return Object.keys(execution).length === Object.keys(canonical).length
    && execution.contract === canonical.contract && execution.semantic_generation_attempts === 0
    && Object.keys(preparation).length === Object.keys(canonical.query_preparation).length
    && Object.entries(canonical.query_preparation).every(([key, value]) =>
      preparation[key as keyof SourceSemanticQueryPreparation] === value)
    && Object.keys(acquisition).length === Object.keys(canonical.acquisition).length
    && acquisition.policy === canonical.acquisition.policy && acquisition.status === "not_run"
    && acquisition.reason === canonical.acquisition.reason && acquisition.result === null
    && acquisition.accounting === "not_run"
    && Object.keys(acquisition.allowance).length === Object.keys(canonical.acquisition.allowance).length
    && Object.entries(canonical.acquisition.allowance).every(([key, value]) =>
      acquisition.allowance[key as keyof typeof acquisition.allowance] === value)
    && Object.keys(acquisition.budget).length === Object.keys(canonical.acquisition.budget).length
    && Object.entries(canonical.acquisition.budget).every(([key, value]) =>
      acquisition.budget[key as keyof typeof acquisition.budget] === value);
}

/** Expand only current-request execution; frozen access provenance is not execution of this request. */
export function sourceSemanticExecutionPhases(execution: SourceSemanticExecution): ExecutionPhases {
  return execution === "native_reasoning_only" ? nativeReasoningPhases() : execution;
}

export function sourceSemanticExecution(preparation?: SourceSemanticQueryPreparation,
  acquisition?: SourceSemanticAcquisitionPhase): SourceSemanticExecution {
  const canonical = nativeReasoningPhases();
  const phases: ExecutionPhases = { ...canonical, query_preparation: preparation ?? canonical.query_preparation,
    acquisition: acquisition ?? canonical.acquisition };
  return isNativeReasoningOnlyExecution(phases) ? "native_reasoning_only" : phases;
}

export function unavailableSourceQueryPreparation(reason: string, status: "unavailable" | "not_requested" = "unavailable"):
  SourceSemanticQueryPreparation {
  return { status, reason, navigation_digest: null, selected: null, method: "not_run", submitted_inputs: 0,
    token_count: null, external_api_attempts: 0, binding_work: "not_run", execution_work: "not_run",
    elapsed_ms: status === "not_requested" ? 0 : null };
}

export const SourceSemanticAccessPolicySchema = z.enum(["query-conditioned-v1", "canonical-v1"]);
/** Task-local navigation text; it cannot supply query semantics or durable source meaning. */
export const SourceSemanticAccessHintSchema = z.string().min(1).max(1024)
  .refine(value => value.trim().length > 0, "access hint must contain text");

export function refineSourceSemanticAccessHint(input: Readonly<{
  access_hint?: string; access_policy?: z.infer<typeof SourceSemanticAccessPolicySchema>; source_handle?: string;
}>, context: z.RefinementCtx): void {
  if (input.access_hint !== undefined && (input.source_handle !== undefined || input.access_policy === "canonical-v1")) {
    context.addIssue({ code: "custom", path: ["access_hint"],
      message: "access hint requires query-conditioned preparation without a source handle" });
  }
}
/** An explicit native read extent belongs to a current source tuple, not to its rank or text. */
export const SourceSemanticPreviewExtentsSchema = z.array(z.object({
  source_id: BoundedIdSchema, source_version: BoundedIdSchema, record_id: Sha256DigestSchema,
  byte_extent: z.number().int().min(1).max(4096)
}).strict().readonly()).min(1).max(64).readonly().superRefine((rows, ctx) => {
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (ids.has(row.source_id)) ctx.addIssue({ code: "custom", path: [index], message: "duplicate source preview tuple" });
    ids.add(row.source_id);
  }
});
export type SourceSemanticPreviewExtents = z.infer<typeof SourceSemanticPreviewExtentsSchema>;
const SourceSemanticAccessStoppingReasonSchema = z.enum([
  "budget", "source_limit", "interpretation_limit", "unavailable", "source_tail"
]);
export const SourceSemanticAccessSignalSchema = z.object({
  source_text_score: z.number().min(0).max(1).nullable(),
  interpretation_reading_score: z.number().min(0).max(1),
  reading: z.object({ query_alternative: NonNegativeIntSchema, query_frame: BoundedIdSchema,
    source_frame: BoundedIdSchema }).strict().readonly().optional()
}).strict().readonly();

/** Access scores are local lexical observations, never assertion or proof grades. Array order is the frozen access order. */
export const SourceSemanticAccessReceiptSchema = z.object({
  // Invariant §25: v2 required phase/provenance fields are a protocol major. Historic v1 is rejected,
  // never upgraded with missing-field defaults. Retained readers may remove that rejection at archive retirement.
  contract: z.literal("source-semantic-access-v2", {
    error: "Historic Source access v1 is unsupported by live/retained v2 execution; explicitly recreate the preparation"
  }),
  preparation: SourceSemanticQueryPreparationSchema,
  acquisition: SourceSemanticAcquisitionPhaseSchema,
  phase_accounting: z.object({
    /** Null is unmeasured, never zero execution. */
    observation: Resources.nullable(),
    completion: z.literal("included_in_worker_work_not_separately_measured"),
    native_cpu: z.literal("unknown"), deadline: z.literal("soft_quarantine_until_exit")
  }).strict().readonly(),
  policy: SourceSemanticAccessPolicySchema,
  input_id: Sha256DigestSchema,
  pool_id: Sha256DigestSchema,
  source_preview_extents: SourceSemanticPreviewExtentsSchema.optional(),
  observed_source_count: NonNegativeIntSchema,
  observed_interpretation_count: NonNegativeIntSchema,
  source_candidates: z.array(z.object({
    source_id: BoundedIdSchema, record_id: Sha256DigestSchema,
    read_bytes: NonNegativeIntSchema, body_bytes: NonNegativeIntSchema.nullable(), complete: z.boolean(),
    signal: SourceSemanticAccessSignalSchema
  }).strict().readonly()).max(64).readonly(),
  interpretation_candidates: z.array(z.object({
    interpretation_id: Sha256DigestSchema, record_id: Sha256DigestSchema,
    signal: SourceSemanticAccessSignalSchema
  }).strict().readonly()).max(64).readonly(),
  trace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preparation_page"), source_offset: NonNegativeIntSchema,
      interpretation_offset: NonNegativeIntSchema, omitted_source_count: NonNegativeIntSchema,
      omitted_interpretation_count: NonNegativeIntSchema }).strict().readonly(),
    z.object({ kind: z.literal("library_selection"), omitted_source_count: NonNegativeIntSchema,
      omitted_interpretation_count: NonNegativeIntSchema }).strict().readonly()
  ]),
  unvisited_sources: z.boolean(),
  unvisited_interpretations: z.boolean(),
  stopping_reasons: z.array(SourceSemanticAccessStoppingReasonSchema).max(5).readonly()
}).strict().readonly().superRefine((access, ctx) => {
  for (const source of access.source_candidates) {
    const extent = access.source_preview_extents?.find(row => row.source_id === source.source_id);
    if (access.source_preview_extents !== undefined &&
        (extent?.record_id !== source.record_id || source.read_bytes > extent.byte_extent)) {
      ctx.addIssue({ code: "custom", message: "access observation exceeds bound source preview extent" });
    }
    if (source.body_bytes === null ? source.read_bytes !== 0 || source.complete
      : source.read_bytes > source.body_bytes || source.complete && source.read_bytes !== source.body_bytes) {
      ctx.addIssue({ code: "custom", message: "access source completeness contradicts its byte extent" });
    }
  }
  // Native traces omit all other observed rows, including earlier pages.
  if (access.trace.omitted_source_count !== access.observed_source_count - access.source_candidates.length
    || access.trace.omitted_interpretation_count !== access.observed_interpretation_count - access.interpretation_candidates.length) {
    ctx.addIssue({ code: "custom", message: "access trace omitted counts contradict its observed pool" });
  }
  if (access.trace.kind === "preparation_page"
    && (access.trace.source_offset + access.source_candidates.length > access.observed_source_count
      || access.trace.interpretation_offset + access.interpretation_candidates.length > access.observed_interpretation_count)) {
    ctx.addIssue({ code: "custom", message: "access preparation offsets exceed its observed pool" });
  }
});

export type SourceSemanticAccessPolicy = z.infer<typeof SourceSemanticAccessPolicySchema>;
export type SourceSemanticAccessSignal = z.infer<typeof SourceSemanticAccessSignalSchema>;
export type SourceSemanticAccessReceipt = z.infer<typeof SourceSemanticAccessReceiptSchema>;
