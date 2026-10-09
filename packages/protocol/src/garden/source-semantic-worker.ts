import { z } from "zod";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import { SourceSemanticGenerationTaskSummarySchema, sourceSemanticGenerationTaskSummary } from "./source-semantic-generation-task.js";
import { SourceSemanticAccessPolicySchema, SourceSemanticAccessReceiptSchema, SourceSemanticPreviewExtentsSchema } from "./source-semantic-access.js";
import { SourceRecordIdentitySchema } from "../recall/field-contract/source-span.js";
import { SourceDisclosureSchema, type SourceDisclosure } from "../recall/source-disclosure.js";
import { UtteranceAttributionSchema } from "../conversation/utterance-attribution.js";
import { BoundedIdSchema, BoundedLabelSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { SourceReferenceCatalogSchema, SOURCE_REFERENCE_MAX_ASSERTIONS } from "../evidence/source-reference.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceSemanticQuerySchema } from "../recall/conditional-field/semantic-query.js";
import { SourceSemanticCorrespondenceSchema } from "../recall/conditional-field/semantic-correspondence.js";
import { SourceSemanticEvaluationContextSchema } from "../recall/conditional-field/interpretation-context.js";
import { ContinuationSchema, InformationIndexSchema, SOURCE_SEMANTIC_PROOF_OBJECT_KIND,
  indexEntryCacheKey } from "../recall/conditional-field/index-view.js";
import {
  SourceSemanticAssertionLocationSchema, SourceSemanticInterpretationSchema, SourceSemanticOutcomeSchema, SourceSemanticReasoningResultSchema
} from "./source-semantic-interpretation.js";

/** Native evidence selection occupies roots and reserves their complete support packages. */
export const SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP = 32 as const;
export const SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET = 5 as const;
export const SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX = 5 as const;
export const SOURCE_SEMANTIC_LIBRARY_INTERPRETATION_PAGE = 16 as const;
export const SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION = "source-semantic-library-v6" as const;
export const SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION = 7 as const;
export const SOURCE_SEMANTIC_LIBRARY_OCCUPANCY = "source_gold_root_identity" as const;
export const SOURCE_SEMANTIC_LIBRARY_TIE_POLICY = "canonical_identity" as const;

// Generic enumeration policies describe the ordinary field route. Library order
// is carried by its versioned order contract and frozen membership lease instead.
export const SourceSemanticLibraryContinuationSchema = ContinuationSchema.unwrap().extend({
  result_version: z.literal(SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION),
  enumeration_policy: z.never().optional()
}).readonly();

export const SOURCE_SEMANTIC_COVERAGE_STATES = [
  "complete", "open", "truncated", "unexercised"
] as const;

export const SourceSemanticCoverageSchema = z.object({
  discovery: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  source_interpretation: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  query_semantics: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  semantic_correspondence: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  conditional_computation: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES),
  payload: z.enum(SOURCE_SEMANTIC_COVERAGE_STATES)
}).strict().readonly();

/** Semantic admission is independent of raw-source discovery and delivery. */
export const SourceSemanticQueryUnavailableReasonSchema = z.enum([
  "absent", "invalid", "unsupported_producer", "producer_failure", "producer_outcome_unknown", "cache_unavailable"
]);
export type SourceSemanticQueryUnavailableReason = z.infer<typeof SourceSemanticQueryUnavailableReasonSchema>;
export const SourceSemanticQueryStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("admitted"), query_semantics_id: Sha256DigestSchema }).strict().readonly(),
  z.object({ status: z.literal("unavailable"), reason: SourceSemanticQueryUnavailableReasonSchema }).strict().readonly()
]);
export type SourceSemanticQueryStatus = z.infer<typeof SourceSemanticQueryStatusSchema>;

type QueryRequestRefinement = Readonly<{
  query_semantics?: z.infer<typeof SourceSemanticQuerySchema>;
  query_semantics_unavailable?: Exclude<SourceSemanticQueryUnavailableReason, "absent">;
  original_query?: string; query_handle?: string;
}>;
type QueryRequestRefinementContext = { addIssue(issue: { code: "custom"; message: string }): void };

/** Shared public/worker request rules; a declaration cannot stand in for admitted meaning. */
export function refineSourceSemanticQueryRequest(request: QueryRequestRefinement, context: QueryRequestRefinementContext,
  requireRecallAnchor = false): void {
  if (requireRecallAnchor && request.query_handle === undefined && request.original_query === undefined) {
    context.addIssue({ code: "custom", message: "recall requires a query handle or original query" });
  }
  if (request.query_semantics !== undefined && request.query_semantics_unavailable !== undefined) {
    context.addIssue({ code: "custom", message: "query semantics and an unavailable producer declaration are mutually exclusive" });
  }
}

export const SourceSemanticHandleDescriptorSchema = z.object({
  interpretation_id: Sha256DigestSchema,
  source_id: BoundedIdSchema,
  source_version: BoundedIdSchema,
  content_digest: Sha256DigestSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  generation_task: SourceSemanticGenerationTaskSummarySchema.optional(),
  interpretation: SourceSemanticInterpretationSchema.optional(),
  source_disclosure: SourceDisclosureSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.interpretation !== undefined && canonicalJson(value.generation_task ?? null) !== canonicalJson(
    value.interpretation.generation_task === undefined ? null : sourceSemanticGenerationTaskSummary(value.interpretation.generation_task))) {
    context.addIssue({ code: "custom", path: ["generation_task"], message: "descriptor task differs from its interpretation" });
  }
  if (value.interpretation !== undefined && value.source_disclosure === undefined) {
    context.addIssue({ code: "custom", path: ["source_disclosure"], message: "delivered interpretation requires disclosure" });
  }
}).readonly();

export const SourceSemanticWorkerWorkSchema = z.object({
  native_work: z.number().int().nonnegative(),
  logical_work: z.number().int().nonnegative().optional(),
  native_bytes: z.number().int().nonnegative(),
  logical_memory_bytes: z.number().int().nonnegative(),
  rss_bytes: z.number().int().nonnegative()
}).strict().readonly();

const PrepareSourceRequestSchema = z.object({
  kind: z.literal("prepare_source"),
  source_id: BoundedIdSchema,
  budget: RequestBudgetSchema
}).strict().readonly();

const PrepareQueryRequestSchema = z.object({
  kind: z.literal("prepare_query"),
  access_policy: SourceSemanticAccessPolicySchema.optional(),
  source_preview_extents: SourceSemanticPreviewExtentsSchema.optional(),
  original_query: z.string().min(1).max(8192),
  query_semantics: SourceSemanticQuerySchema.optional(),
  query_semantics_unavailable: SourceSemanticQueryUnavailableReasonSchema.exclude(["absent"]).optional(),
  source_handle: BoundedIdSchema.optional(),
  continuation_handle: BoundedIdSchema.optional(),
  budget: RequestBudgetSchema
}).strict().superRefine(refineSourceSemanticQueryRequest).readonly();

const ValidateSourceRequestSchema = z.object({
  kind: z.literal("validate_source"), source_handle: BoundedIdSchema, budget: RequestBudgetSchema
}).strict().readonly();

const ReasonRequestSchema = z.object({
  kind: z.literal("reason"),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  source_interpretation_id: Sha256DigestSchema.optional(),
  query_semantics: SourceSemanticQuerySchema.optional(),
  semantic_correspondence: SourceSemanticCorrespondenceSchema.optional(),
  original_query: z.string().min(1).max(8192).optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().superRefine((request, context) => {
  const leased = request.query_handle !== undefined &&
    (request.semantic_correspondence !== undefined || request.source_interpretation_id !== undefined);
  const oneshot = request.source_interpretation_id !== undefined && request.original_query !== undefined;
  if (!leased && !oneshot) {
    context.addIssue({
      code: "custom",
      message: "reason requires a query handle and source interpretation, or a one-shot source interpretation and original query"
    });
  }
}).readonly();

const RecallRequestSchema = z.object({
  kind: z.literal("recall"),
  access_policy: SourceSemanticAccessPolicySchema.optional(),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  query_semantics: SourceSemanticQuerySchema.optional(),
  query_semantics_unavailable: SourceSemanticQueryUnavailableReasonSchema.exclude(["absent"]).optional(),
  original_query: z.string().min(1).max(8192).optional(),
  semantic_correspondences: z.array(SourceSemanticCorrespondenceSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly().optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000),
  continuation: SourceSemanticLibraryContinuationSchema.optional()
}).strict().superRefine((request, context) => refineSourceSemanticQueryRequest(request, context, true)).readonly();

export const SourceSemanticWorkerRequestSchema = z.discriminatedUnion("kind", [
  PrepareSourceRequestSchema, ValidateSourceRequestSchema, PrepareQueryRequestSchema, ReasonRequestSchema,
  RecallRequestSchema
]);

export const SourceSemanticLibraryDiscoverySchema = z.object({
  access: SourceSemanticAccessReceiptSchema.optional(),
  eligible_source_count: NonNegativeIntSchema,
  visited_source_pages: NonNegativeIntSchema,
  visited_source_interpretation_pages: NonNegativeIntSchema,
  visited_source_interpretation_descriptors: NonNegativeIntSchema,
  candidate_prefix: z.array(Sha256DigestSchema).max(64).readonly(),
  examined_source_interpretation_ids: z.array(Sha256DigestSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly(),
  unexamined_source_interpretation_count: NonNegativeIntSchema,
  /** Entries omitted from root occupancy, not witnesses omitted from the delivered proofs. */
  omitted_duplicate_bindings: NonNegativeIntSchema,
  examination_cap: z.literal(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP),
  open_residuals: z.boolean(),
  truncated: z.boolean()
}).strict().readonly();

export const SourceSemanticLibraryOrderSchema = z.object({
  enumeration_policy: z.literal("evidence_support"),
  tie_policy: z.literal(SOURCE_SEMANTIC_LIBRARY_TIE_POLICY),
  occupancy: z.literal(SOURCE_SEMANTIC_LIBRARY_OCCUPANCY),
  occupancy_prefix: z.literal(SOURCE_SEMANTIC_LIBRARY_OCCUPANCY_PREFIX),
  page_budget: z.literal(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET)
}).strict().readonly();

export const SourceSemanticQuerySupportSchema = z.object({
  answer: z.enum(["supported", "open", "unrepresented"]),
  evidence_inputs: z.array(z.object({ alternative: NonNegativeIntSchema, input: NonNegativeIntSchema,
    status: z.enum(["supported", "open"]) }).strict().readonly()).max(256).readonly(),
  operation: z.enum(["not_requested", "not_executed"]),
  compatibility: z.literal("unknown"),
  distinctness: z.literal("unknown")
}).strict().readonly();
export type SourceSemanticQuerySupport = z.infer<typeof SourceSemanticQuerySupportSchema>;

export const SourceSemanticLibrarySlotQualifierSchema = z.object({
  index: NonNegativeIntSchema,
  evidence_kind: z.enum(["semantic_proof", "source_evidence"]),
  source_interpretation_id: Sha256DigestSchema.optional(),
  query_semantics_id: Sha256DigestSchema.optional(),
  semantic_correspondence_id: Sha256DigestSchema.optional(),
  conditional_computation_id: Sha256DigestSchema.optional(),
  witnesses: z.array(z.object({ conditional_computation_id: Sha256DigestSchema, binding_id: BoundedIdSchema })
    .strict().readonly()).min(1).max(1000).readonly().optional(),
  support: SourceSemanticQuerySupportSchema.optional(),
  payload_support: z.enum(["available", "not_applicable", "no_dependencies", "unknown_dependency", "location_missing", "display_budget", "resource_budget", "envelope_budget"]).optional(),
  selection_basis: z.enum(["direct_answer", "new_input", "additional_witness", "source_access"]).optional()
}).strict().superRefine((value, context) => {
  if (value.evidence_kind === "semantic_proof" && (value.witnesses === undefined
    || value.source_interpretation_id === undefined || value.query_semantics_id === undefined
    || value.semantic_correspondence_id === undefined || value.conditional_computation_id === undefined || value.support === undefined)) {
    context.addIssue({ code: "custom", message: "semantic proof requires identities and every delivered binding witness" });
  }
  if (value.evidence_kind === "source_evidence" && (value.witnesses !== undefined || value.support !== undefined)) {
    context.addIssue({ code: "custom", message: "unproved source cannot declare semantic witnesses" });
  }
}).readonly();

const CoverageWork = {
  coverage: SourceSemanticCoverageSchema,
  work: SourceSemanticWorkerWorkSchema
};

/** Complete conditions for one branch; an isolated source interpretation, query semantics, semantic correspondence, and conditional computation. */
export const SourceSemanticLibraryProofSchema = SourceSemanticReasoningResultSchema.unwrap().extend({
  original_query: z.string().min(1).max(8192),
  source_record: SourceRecordIdentitySchema,
  interpretation: SourceSemanticInterpretationSchema,
  query: SourceSemanticQuerySchema,
  semantic_correspondence: SourceSemanticCorrespondenceSchema,
  context: SourceSemanticEvaluationContextSchema
}).strict().readonly();
export type SourceSemanticLibraryProof = z.infer<typeof SourceSemanticLibraryProofSchema>;

/** Current, completed computation without a binding; this is control evidence, not a proof or source fact. */
const SourceRecordFields = SourceRecordIdentitySchema.unwrap().shape;
export const SourceSemanticLibraryUnprovedComputationSchema = z.object({
  kind: z.literal("complete_zero_binding"),
  conclusion_scope: z.literal("conditional_on_interpretation"),
  world_claim: z.literal("unknown"),
  source_record: z.object({
    workspace_id: SourceRecordFields.workspace_id, source_id: SourceRecordFields.source_id,
    identity: SourceRecordFields.identity, source_version: SourceRecordFields.source_version,
    content_digest: SourceRecordFields.content_digest
  }).strict().readonly(),
  source_interpretation_id: Sha256DigestSchema,
  query_semantics_id: Sha256DigestSchema,
  semantic_correspondence_id: Sha256DigestSchema,
  conditional_computation_id: Sha256DigestSchema,
  completeness: SourceSemanticReasoningResultSchema.unwrap().shape.completeness.unwrap(),
  attention: SourceSemanticReasoningResultSchema.unwrap().shape.attention.unwrap().optional()
}).strict().superRefine((value, context) => {
  const attention = value.attention;
  if (value.completeness.logical_index !== "complete" || attention !== undefined && (attention.kind !== "computed"
    || attention.source_interpretation_id !== value.source_interpretation_id
    || attention.query_semantics_id !== value.query_semantics_id
    || attention.semantic_correspondence_id !== value.semantic_correspondence_id
    || attention.conditional_computation_id !== value.conditional_computation_id
    || attention.source_id !== value.source_record.source_id
    || attention.source_version !== value.source_record.source_version
    || attention.content_digest !== value.source_record.content_digest)) {
    context.addIssue({ code: "custom", message: "unproved computation requires completed current source and Q/H/C attention" });
  }
}).readonly();
export type SourceSemanticLibraryUnprovedComputation = z.infer<typeof SourceSemanticLibraryUnprovedComputationSchema>;

type LibraryDeliveryConsistency = Readonly<{
  query_semantics_status: SourceSemanticQueryStatus;
  slot_qualifiers: readonly SourceSemanticLibrarySlotQualifier[];
  proofs?: readonly SourceSemanticLibraryProof[];
  unproved_computations?: readonly SourceSemanticLibraryUnprovedComputation[];
  results?: readonly Readonly<{ object_kind: string }>[];
  source_disclosures?: Readonly<Record<string, SourceDisclosure>>;
  index: z.infer<typeof InformationIndexSchema>;
  coverage?: SourceSemanticCoverage;
}>;
type DeliveryRefinementContext = { addIssue(issue: { code: "custom"; path?: (string | number)[]; message: string }): void };

/** Availability and proof claims share one admission rule across worker and public deliveries. */
export function refineSourceSemanticLibraryDelivery(value: LibraryDeliveryConsistency, context: DeliveryRefinementContext): void {
  if (value.source_disclosures !== undefined) {
    const keys = new Set(value.index.entries.map(indexEntryCacheKey));
    for (const [position, entry] of value.index.entries.entries()) {
      const disclosure = value.source_disclosures[indexEntryCacheKey(entry)];
      const expected = value.slot_qualifiers.find(row => row.index === position)?.evidence_kind === "semantic_proof"
        ? "conditional_support" : "source_only";
      if (disclosure === undefined || disclosure.proof_use.kind !== expected) {
        context.addIssue({ code: "custom", path: ["source_disclosures", indexEntryCacheKey(entry)],
          message: "each delivered source requires the matching proof qualification" });
      }
    }
    if (Object.keys(value.source_disclosures).some(key => !keys.has(key))) {
      context.addIssue({ code: "custom", path: ["source_disclosures"], message: "disclosure cannot expose an undelivered source" });
    }
  }
  const status = value.query_semantics_status;
  if (status.status === "unavailable") {
    if ((value.proofs?.length ?? 0) > 0 || (value.unproved_computations?.length ?? 0) > 0
      || value.results?.some((result) => result.object_kind === SOURCE_SEMANTIC_PROOF_OBJECT_KIND)
      || value.slot_qualifiers.some((slot) => slot.evidence_kind !== "source_evidence"
      || slot.query_semantics_id !== undefined || slot.semantic_correspondence_id !== undefined
      || slot.conditional_computation_id !== undefined || slot.witnesses !== undefined || slot.support !== undefined)
      || value.index.entries.some((entry) => entry.interpretation_node !== undefined || entry.explanation_ids.length > 0)
      || (value.index.explanations?.length ?? 0) > 0) {
      context.addIssue({ code: "custom", message: "unavailable query semantics cannot deliver semantic proof claims" });
    }
    if (value.coverage !== undefined && (value.coverage.query_semantics !== "unexercised"
      || value.coverage.semantic_correspondence !== "unexercised"
      || value.coverage.conditional_computation !== "unexercised")) {
      context.addIssue({ code: "custom", path: ["coverage"], message: "unavailable query semantics cannot claim semantic computation coverage" });
    }
    return;
  }
  if (value.slot_qualifiers.some((slot) => slot.evidence_kind === "semantic_proof"
    && slot.query_semantics_id !== status.query_semantics_id)
    || value.unproved_computations?.some((row) => row.query_semantics_id !== status.query_semantics_id)
    || value.proofs?.some((proof) => proof.query_semantics_id !== status.query_semantics_id
      || proof.semantic_correspondence.query_semantics_id !== status.query_semantics_id
      || proof.context.query_semantics_id !== status.query_semantics_id)) {
    context.addIssue({ code: "custom", message: "delivered proof query identity differs from admitted query semantics" });
  }
  if (value.unproved_computations !== undefined) {
    const delivered = new Set(value.index.entries.flatMap(entry => entry.target.kind === "source_evidence"
      ? [`${entry.target.workspace_id}\0${entry.target.root_id}\0${entry.target.source_version}\0${entry.target.content_digest}`] : []));
    for (const [position, row] of value.unproved_computations.entries()) {
      if (!delivered.has(`${row.source_record.workspace_id}\0${row.source_record.identity}\0${row.source_record.source_version}\0${row.source_record.content_digest}`)) {
        context.addIssue({ code: "custom", path: ["unproved_computations", position],
          message: "unproved computation cannot expose an undelivered source" });
      }
    }
  }
}

/** Current native library delivery; invariant §25 major requires request binding. Generic InformationIndex stays independent. */
export const SourceSemanticLibraryDeliverySchema = z.object({
  delivery_id: BoundedIdSchema,
  request_identity: Sha256DigestSchema,
  query_semantics_status: SourceSemanticQueryStatusSchema,
  protocol_version: z.literal(SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION),
  total_count: NonNegativeIntSchema,
  index: InformationIndexSchema.unwrap().extend({
    result_version: z.literal(SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION),
    continuation: SourceSemanticLibraryContinuationSchema.nullable(),
    representation: InformationIndexSchema.unwrap().shape.representation.unwrap().extend({
      page_budget: z.literal(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET)
    }).readonly(),
    page_purpose: z.literal("membership")
  }).readonly(),
  page_purpose: z.literal("membership"),
  discovery: SourceSemanticLibraryDiscoverySchema,
  order: SourceSemanticLibraryOrderSchema,
  slot_qualifiers: z.array(SourceSemanticLibrarySlotQualifierSchema).max(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).readonly(),
  source_disclosures: z.record(z.string(), SourceDisclosureSchema),
  proofs: z.array(SourceSemanticLibraryProofSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly().optional(),
  unproved_computations: z.array(SourceSemanticLibraryUnprovedComputationSchema)
    .max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly().optional(),
  request_budget: RequestBudgetSchema.optional()
}).strict().superRefine(refineSourceSemanticLibraryDelivery);

export const SourceSemanticWorkerResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("validate_source"), source_id: BoundedIdSchema, source_version: BoundedIdSchema,
    content_digest: Sha256DigestSchema, source: z.string().max(65536), catalog: SourceReferenceCatalogSchema,
    source_disclosure: SourceDisclosureSchema,
    attribution_context: UtteranceAttributionSchema,
    assertion_locations: z.array(SourceSemanticAssertionLocationSchema).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly(),
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("prepare_source"),
    source_handle: BoundedIdSchema,
    source_id: BoundedIdSchema,
    source_version: BoundedIdSchema,
    content_digest: Sha256DigestSchema,
    attribution_context: UtteranceAttributionSchema,
    catalog: SourceReferenceCatalogSchema,
    source_disclosure: SourceDisclosureSchema,
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("prepare_query"),
    query_semantics_status: SourceSemanticQueryStatusSchema,
    access: SourceSemanticAccessReceiptSchema.optional(),
    query_handle: BoundedIdSchema.optional(),
    continuation_handle: BoundedIdSchema.optional(),
    query_semantics_id: Sha256DigestSchema.optional(),
    outcome: SourceSemanticOutcomeSchema.optional(),
    candidates: z.array(SourceSemanticHandleDescriptorSchema).max(64).readonly(),
    truncated: z.boolean(),
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("reason"),
    result: SourceSemanticReasoningResultSchema,
    interpretation: SourceSemanticInterpretationSchema.optional(),
    query: SourceSemanticQuerySchema.optional(),
    semantic_correspondence: SourceSemanticCorrespondenceSchema.optional(),
    context: SourceSemanticEvaluationContextSchema.optional(),
    source_disclosure: SourceDisclosureSchema,
    ...CoverageWork
  }).strict().readonly(),
  z.object({
    kind: z.literal("recall"),
    ...SourceSemanticLibraryDeliverySchema.shape,
    previews: z.record(z.string().min(1).max(16384), z.string().max(65536)).optional(),
    ...CoverageWork
  }).strict().superRefine(refineSourceSemanticLibraryDelivery).readonly()
]);

export type SourceSemanticCoverage = z.infer<typeof SourceSemanticCoverageSchema>;
export type SourceSemanticHandleDescriptor = z.infer<typeof SourceSemanticHandleDescriptorSchema>;
export type SourceSemanticWorkerWork = z.infer<typeof SourceSemanticWorkerWorkSchema>;
export type SourceSemanticWorkerRequest = z.infer<typeof SourceSemanticWorkerRequestSchema>;
export type SourceSemanticWorkerResult = z.infer<typeof SourceSemanticWorkerResultSchema>;
export type SourceSemanticLibraryDiscovery = z.infer<typeof SourceSemanticLibraryDiscoverySchema>;
export type SourceSemanticLibraryOrder = z.infer<typeof SourceSemanticLibraryOrderSchema>;
export type SourceSemanticLibrarySlotQualifier = z.infer<typeof SourceSemanticLibrarySlotQualifierSchema>;
