import { z } from "zod";
import { SourceSemanticAccessPolicySchema, SourceSemanticAccessReceiptSchema } from "../garden/source-semantic-access.js";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { SourceReferenceCatalogSchema } from "../evidence/source-reference.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { AuthorizedScopesAdmissionSchema } from "../governance/active-constraints-policy.js";
import { Sha256DigestSchema } from "../recall/conditional-field/common.js";
import { SourceSemanticQuerySchema } from "../recall/conditional-field/semantic-query.js";
import { SourceSemanticCorrespondenceSchema } from "../recall/conditional-field/semantic-correspondence.js";
import { SourceSemanticEvaluationContextSchema } from "../recall/conditional-field/interpretation-context.js";
import { SourceSemanticDraftSchema } from "../garden/source-semantic-draft.js";
import {
  SourceSemanticInterpretationSchema, SourceSemanticNoPropositionOutcomeSchema, SourceSemanticSourceBindingSchema,
  SourceSemanticOutcomeSchema,
  SourceSemanticPublishedInterpretationSchema,
  SourceSemanticReasoningResultSchema
} from "../garden/source-semantic-interpretation.js";
import { MemorySearchResultSchema } from "./mcp-memory-search-types.js";
import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  SourceSemanticCoverageSchema,
  SourceSemanticHandleDescriptorSchema,
  SourceSemanticLibraryDeliverySchema,
  SourceSemanticLibraryContinuationSchema,
  SourceSemanticQueryStatusSchema,
  SourceSemanticQueryUnavailableReasonSchema,
  refineSourceSemanticQueryRequest,
  refineSourceSemanticLibraryDelivery,
  SourceSemanticWorkerWorkSchema
} from "../garden/source-semantic-worker.js";

/** Public MCP/CLI host operations. Provider-free. Current delivery follows invariant §25 major request binding. */
export const SOUL_INTERPRETATION_TOOL_NAME = "soul.interpretation" as const;

const CoverageWork = {
  coverage: SourceSemanticCoverageSchema,
  work: SourceSemanticWorkerWorkSchema,
  provider_attempts: z.literal(0)
};

export const SoulInterpretationPrepareSourceRequestSchema = z.object({
  operation: z.literal("prepare_source"),
  source_id: BoundedIdSchema,
  budget: RequestBudgetSchema,
  authorized_scopes: AuthorizedScopesAdmissionSchema.optional()
}).strict().readonly();

export const SoulInterpretationProposeRequestSchema = z.object({
  operation: z.literal("propose"),
  source_handle: BoundedIdSchema,
  draft: SourceSemanticDraftSchema.optional(),
  disposition: SourceSemanticNoPropositionOutcomeSchema.optional(),
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  budget: RequestBudgetSchema.optional(),
  authorized_scopes: AuthorizedScopesAdmissionSchema.optional()
}).strict().superRefine((request, context) => {
  if ((request.draft === undefined) === (request.disposition === undefined)) context.addIssue({ code: "custom", message: "propose requires a draft or an explicit no-proposition disposition" });
}).readonly();

export const SoulInterpretationPrepareQueryRequestSchema = z.object({
  operation: z.literal("prepare_query"),
  access_policy: SourceSemanticAccessPolicySchema.optional(),
  original_query: z.string().min(1).max(8192),
  query_semantics: SourceSemanticQuerySchema.optional(),
  query_semantics_unavailable: SourceSemanticQueryUnavailableReasonSchema.exclude(["absent"]).optional(),
  source_handle: BoundedIdSchema.optional(),
  continuation_handle: BoundedIdSchema.optional(),
  budget: RequestBudgetSchema,
  authorized_scopes: AuthorizedScopesAdmissionSchema.optional()
}).strict().superRefine(refineSourceSemanticQueryRequest).readonly();

export const SoulInterpretationReasonRequestSchema = z.object({
  operation: z.literal("reason"),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  source_interpretation_id: Sha256DigestSchema.optional(),
  query_semantics: SourceSemanticQuerySchema.optional(),
  semantic_correspondence: SourceSemanticCorrespondenceSchema.optional(),
  original_query: z.string().min(1).max(8192).optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000),
  authorized_scopes: AuthorizedScopesAdmissionSchema.optional()
}).strict().readonly();

const SoulInterpretationRecallRequestSchema = z.object({
  operation: z.literal("recall"),
  access_policy: SourceSemanticAccessPolicySchema.optional(),
  accepts_unreviewed_conditional_results: z.literal(true),
  query_handle: BoundedIdSchema.optional(),
  query_semantics: SourceSemanticQuerySchema.optional(),
  query_semantics_unavailable: SourceSemanticQueryUnavailableReasonSchema.exclude(["absent"]).optional(),
  original_query: z.string().min(1).max(8192).optional(),
  semantic_correspondences: z.array(SourceSemanticCorrespondenceSchema).max(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP).readonly().optional(),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000),
  continuation: SourceSemanticLibraryContinuationSchema.optional(),
  authorized_scopes: AuthorizedScopesAdmissionSchema.optional()
}).strict().superRefine((request, context) => refineSourceSemanticQueryRequest(request, context, true)).readonly();

export const SoulInterpretationRequestSchema = z.discriminatedUnion("operation", [
  SoulInterpretationPrepareSourceRequestSchema,
  SoulInterpretationProposeRequestSchema,
  SoulInterpretationPrepareQueryRequestSchema,
  SoulInterpretationReasonRequestSchema,
  SoulInterpretationRecallRequestSchema
]);

export const SoulInterpretationPrepareSourceResponseSchema = z.object({
  operation: z.literal("prepare_source"),
  source_handle: BoundedIdSchema.optional(),
  source_id: BoundedIdSchema.optional(),
  source_version: BoundedIdSchema.optional(),
  content_digest: Sha256DigestSchema.optional(),
  catalog: SourceReferenceCatalogSchema.optional(),
  outcome: SourceSemanticOutcomeSchema.optional(),
  ...CoverageWork
}).strict().readonly();

export const SoulInterpretationProposeResponseSchema = z.object({
  operation: z.literal("propose"),
  outcome: SourceSemanticOutcomeSchema,
  source_binding: SourceSemanticSourceBindingSchema.optional(),
  semantic_status: z.literal("unreviewed").optional(),
  published: SourceSemanticPublishedInterpretationSchema.optional(),
  evidence_object_id: BoundedIdSchema.optional(),
  ...CoverageWork
}).strict().readonly();

export const SoulInterpretationPrepareQueryResponseSchema = z.object({
  operation: z.literal("prepare_query"),
  query_semantics_status: SourceSemanticQueryStatusSchema,
  access: SourceSemanticAccessReceiptSchema.optional(),
  query_handle: BoundedIdSchema.optional(),
  continuation_handle: BoundedIdSchema.optional(),
  query_semantics_id: Sha256DigestSchema.optional(),
  outcome: SourceSemanticOutcomeSchema.optional(),
  candidates: z.array(SourceSemanticHandleDescriptorSchema).max(64).readonly(),
  truncated: z.boolean(),
  ...CoverageWork
}).strict().readonly();

export const SoulInterpretationReasonResponseSchema = z.object({
  operation: z.literal("reason"),
  result: SourceSemanticReasoningResultSchema.optional(),
  interpretation: SourceSemanticInterpretationSchema.optional(),
  query: SourceSemanticQuerySchema.optional(),
  semantic_correspondence: SourceSemanticCorrespondenceSchema.optional(),
  context: SourceSemanticEvaluationContextSchema.optional(),
  outcome: SourceSemanticOutcomeSchema.optional(),
  ...CoverageWork
}).strict().readonly();

const SoulInterpretationRecallDeliveryBaseSchema = z.object({
  ...SourceSemanticLibraryDeliverySchema.shape,
  operation: z.literal("recall"),
  results: z.array(MemorySearchResultSchema).max(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET).readonly(),
  outcome: SourceSemanticOutcomeSchema.optional(),
  ...CoverageWork
}).strict();
export const SoulInterpretationRecallDeliverySchema = SoulInterpretationRecallDeliveryBaseSchema
  .superRefine(refineSourceSemanticLibraryDelivery);

const SoulInterpretationRecallResponseSchema = z.object({
  ...SoulInterpretationRecallDeliveryBaseSchema.partial().shape,
  operation: z.literal("recall"),
  ...CoverageWork
}).strict().superRefine((response, ctx) => {
  const hasDelivery = Object.hasOwn(response, "results") || Object.keys(SourceSemanticLibraryDeliverySchema.shape)
    .some((key) => Object.hasOwn(response, key));
  if (!hasDelivery) {
    if (response.outcome === undefined) ctx.addIssue({ code: "custom", message: "recall requires a complete delivery or an outcome" });
    return;
  }
  const delivery = SoulInterpretationRecallDeliverySchema.safeParse(response);
  if (!delivery.success) for (const issue of delivery.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
}).readonly();

export const SoulInterpretationResponseSchema = z.discriminatedUnion("operation", [
  SoulInterpretationPrepareSourceResponseSchema,
  SoulInterpretationProposeResponseSchema,
  SoulInterpretationPrepareQueryResponseSchema,
  SoulInterpretationReasonResponseSchema,
  SoulInterpretationRecallResponseSchema
]);

export type SoulInterpretationRequest = z.infer<typeof SoulInterpretationRequestSchema>;
export type SoulInterpretationResponse = z.infer<typeof SoulInterpretationResponseSchema>;
