import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedString,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ConditionalFieldIdSchema,
  MilligradeSchema,
  SchemaVersionSchema,
  Sha256DigestSchema
} from "./common.js";
import {
  AssociationCapContractSchema,
  ClaimDemandSchema,
  EnumerationPolicySchema,
  ResultKindViewSchema
} from "./query.js";
import { ResidualSemanticEffectSchema } from "./observer.js";
import {
  canonicalProductIdentity,
  memoryProductStateKey,
  productMemoryObjectId,
  ProductStateKeySchema,
  RecallTargetKindSchema,
  RecallTargetRefSchema,
  sourceProductStateKey,
  stableCanonicalStringify,
  type ProductStateKey,
  type RecallTargetRef,
  type SourceEvidenceRootKind
} from "./product-identity.js";
import { ClaimStateSchema, DerivationSchema, PropositionSchema } from "./support.js";

export const IndexRoleSchema = z.enum(["requested", "associated", "routing_only"]);
export const OrderStatusSchema = z.enum(["open", "certified_prefix", "complete", "partial"]);
export const PagePurposeSchema = z.enum(["membership", "payload", "update", "retry"]);
export const ProductUpdateKindSchema = z.enum(["proof", "claim", "payload", "retraction"]);

export const IndexEntrySchema = z
  .object({
    schema_version: SchemaVersionSchema,
    target: RecallTargetRefSchema,
    object_id: ConditionalFieldIdSchema.optional(),
    hypothesis_id: ConditionalFieldIdSchema,
    output_binding: ConditionalFieldIdSchema,
    role: IndexRoleSchema,
    association_milligrades: MilligradeSchema,
    claim: ClaimStateSchema,
    claim_proposition_id: ConditionalFieldIdSchema.optional(),
    claim_proposition: PropositionSchema.optional(),
    explanation_ids: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    program_state: ConditionalFieldIdSchema.optional(),
    time_state: ConditionalFieldIdSchema.optional()
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.target.kind === "memory_entry") {
      if (entry.object_id !== entry.target.object_id) {
        context.addIssue({
          code: "custom",
          path: ["object_id"],
          message: "memory_entry object_id must match target.object_id"
        });
      }
      return;
    }
    if (entry.object_id !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["object_id"],
        message: "source_evidence must not fill object_id"
      });
    }
  })
  .readonly();

export const CompletenessStatusSchema = z.enum([
  "complete",
  "partial",
  "open",
  "unavailable",
  "resource_rejected",
  "interrupted",
  "exhausted_empty",
  "invalidated",
  "cancelled",
  "unknown",
  "not_applicable",
  "omitted"
]);

export const CompletenessReportSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    logical_index: CompletenessStatusSchema,
    observed_coverage: CompletenessStatusSchema,
    interpretation_coverage: CompletenessStatusSchema.optional(),
    transport: CompletenessStatusSchema,
    payload: CompletenessStatusSchema,
    representation: CompletenessStatusSchema,
    claim_coverage: CompletenessStatusSchema.optional(),
    explanation_coverage: CompletenessStatusSchema.optional(),
    order_coverage: CompletenessStatusSchema.optional(),
    pending_computation: CompletenessStatusSchema.optional(),
    certificate_id: ConditionalFieldIdSchema.optional()
  })
  .strict()
  .readonly();

export const ClosureComparisonSchema = z.enum(["gt", "gte", "lt", "lte"]);
export const ClosureCoveragePremiseSchema = z.enum([
  "required_regions_irrelevant",
  "upper_excludes_predicate",
  "alternate_source_path"
]);

export const ClosureCertificateSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    certificate_id: ConditionalFieldIdSchema,
    query_id: ConditionalFieldIdSchema,
    predicate_id: ConditionalFieldIdSchema,
    operator_id: ConditionalFieldIdSchema,
    domain_id: ConditionalFieldIdSchema,
    coverage_premise: ClosureCoveragePremiseSchema,
    closed_effects: z.array(ResidualSemanticEffectSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    comparison: ClosureComparisonSchema.optional(),
    threshold_milligrades: MilligradeSchema.optional(),
    uses_raw_predicate: z.boolean().optional(),
    program_id: ConditionalFieldIdSchema.optional(),
    result_kind_view: ResultKindViewSchema.optional(),
    target_kinds: z.array(RecallTargetKindSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    source_domains: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    hypothesis_id: ConditionalFieldIdSchema.optional(),
    binding: ConditionalFieldIdSchema.optional(),
    includes_source_only: z.boolean().optional(),
    closed_obligations: z
      .array(z.enum(["membership", "claim", "order"]))
      .max(BOUNDED_DEFAULT_ARRAY_MAX)
      .readonly()
      .optional()
  })
  .strict()
  .readonly();

export const ContinuationSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    continuation_id: ConditionalFieldIdSchema,
    query_id: ConditionalFieldIdSchema,
    snapshot_id: Sha256DigestSchema,
    result_version: ConditionalFieldIdSchema,
    expires_at: IsoDatetimeStringSchema,
    cursor: ConditionalFieldIdSchema,
    interpretation_id: ConditionalFieldIdSchema.optional(),
    interpretation_clock: IsoDatetimeStringSchema.optional(),
    enumeration_policy: EnumerationPolicySchema.optional(),
    result_kind_view: ResultKindViewSchema.optional(),
    authorized_scopes: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    emitted_revisions: z.record(BoundedString(4096), ConditionalFieldIdSchema).optional(),
    cap_contracts: z.array(AssociationCapContractSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    claim_demands: z.array(ClaimDemandSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    protocol_version: NonNegativeIntSchema.min(1).optional(),
    supported_result_kinds: z.array(RecallTargetKindSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional()
  })
  .strict()
  .readonly();

export const RepresentationDecisionSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    policy: z.literal("construct_index_then_page_then_payload"),
    page_budget: NonNegativeIntSchema,
    identity_tie_break: z.literal("serialization")
  })
  .strict()
  .readonly();

export const ProductUpdateSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    product: ProductStateKeySchema,
    update_kind: ProductUpdateKindSchema,
    revision: ConditionalFieldIdSchema,
    previous_revision: ConditionalFieldIdSchema.optional()
  })
  .strict()
  .readonly();

export const PayloadContinuationRequestSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    purpose: z.literal("payload_expansion"),
    target: RecallTargetRefSchema,
    start_offset: z.number().int().nonnegative().optional(),
    end_offset: z.number().int().nonnegative().optional(),
    byte_budget: NonNegativeIntSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.end_offset !== undefined && value.start_offset !== undefined
      && value.end_offset <= value.start_offset) {
      context.addIssue({
        code: "custom",
        path: ["end_offset"],
        message: "payload continuation span must be half-open and non-empty"
      });
    }
  })
  .readonly();

export const InformationIndexSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    query_id: ConditionalFieldIdSchema,
    snapshot_id: Sha256DigestSchema,
    result_version: ConditionalFieldIdSchema,
    entries: z.array(IndexEntrySchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    interpretation_id: ConditionalFieldIdSchema.optional(),
    as_of: IsoDatetimeStringSchema.optional(),
    explanations: z.array(DerivationSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    completeness: CompletenessReportSchema,
    continuation: ContinuationSchema.nullable(),
    representation: RepresentationDecisionSchema,
    order_status: OrderStatusSchema.optional(),
    page_purpose: PagePurposeSchema.optional(),
    product_updates: z.array(ProductUpdateSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional()
  })
  .strict()
  .readonly();

export type IndexRole = z.infer<typeof IndexRoleSchema>;
export type IndexEntry = z.infer<typeof IndexEntrySchema>;
export type CompletenessStatus = z.infer<typeof CompletenessStatusSchema>;
export type CompletenessReport = z.infer<typeof CompletenessReportSchema>;
export type ClosureComparison = z.infer<typeof ClosureComparisonSchema>;
export type ClosureCoveragePremise = z.infer<typeof ClosureCoveragePremiseSchema>;
export type ClosureCertificate = z.infer<typeof ClosureCertificateSchema>;
export type Continuation = z.infer<typeof ContinuationSchema>;
export type RepresentationDecision = z.infer<typeof RepresentationDecisionSchema>;
export type InformationIndex = z.infer<typeof InformationIndexSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type PagePurpose = z.infer<typeof PagePurposeSchema>;
export type ProductUpdateKind = z.infer<typeof ProductUpdateKindSchema>;
export type ProductUpdate = z.infer<typeof ProductUpdateSchema>;
export type PayloadContinuationRequest = z.infer<typeof PayloadContinuationRequestSchema>;

export function canonicalIndexEntryIdentity(entry: IndexEntry): string {
  return stableCanonicalStringify({
    identity_version: "product-identity.v1",
    target: entry.target,
    hypothesis_id: entry.hypothesis_id,
    output_binding: entry.output_binding,
    program_state: entry.program_state ?? "",
    time_state: entry.time_state ?? ""
  });
}

export function productStateKeyFromIndexEntry(entry: IndexEntry): ProductStateKey {
  const programState = entry.program_state ?? "accepting";
  const timeState = entry.time_state ?? "as_of";
  if (entry.target.kind === "memory_entry") {
    return memoryProductStateKey({
      workspace_id: entry.target.workspace_id,
      object_id: entry.target.object_id,
      source_revision: entry.target.source_revision,
      program_state: programState,
      hypothesis_id: entry.hypothesis_id,
      binding_context: entry.output_binding,
      time_state: timeState
    });
  }
  return sourceProductStateKey({
    workspace_id: entry.target.workspace_id,
    root_kind: entry.target.root_kind,
    root_id: entry.target.root_id,
    source_version: entry.target.source_version,
    content_digest: entry.target.content_digest,
    evidence_object_id: entry.target.evidence_object_id,
    program_state: programState,
    hypothesis_id: entry.hypothesis_id,
    binding_context: entry.output_binding,
    time_state: timeState
  });
}

export function indexMemoryObjectId(entry: IndexEntry): string | undefined {
  return productMemoryObjectId(productStateKeyFromIndexEntry(entry));
}

export function indexEntrySubjectId(entry: IndexEntry): string {
  return entry.target.kind === "memory_entry" ? entry.target.object_id : entry.target.root_id;
}

export function indexEntryObjectKind(entry: IndexEntry): "memory_entry" | "source_evidence" {
  return entry.target.kind === "source_evidence" ? "source_evidence" : "memory_entry";
}

export function memoryIndexEntry(input: Readonly<{
  readonly workspace_id: string;
  readonly object_id: string;
  readonly source_revision: string;
  readonly hypothesis_id?: string;
  readonly output_binding?: string;
  readonly role?: IndexRole;
  readonly association_milligrades: number;
  readonly claim?: z.infer<typeof ClaimStateSchema>;
  readonly explanation_ids?: readonly string[];
  readonly program_state?: string;
  readonly time_state?: string;
}>): IndexEntry {
  return IndexEntrySchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: {
      kind: "memory_entry",
      workspace_id: input.workspace_id,
      object_id: input.object_id,
      source_revision: input.source_revision
    },
    object_id: input.object_id,
    hypothesis_id: input.hypothesis_id ?? "h0",
    output_binding: input.output_binding ?? "default",
    role: input.role ?? "associated",
    association_milligrades: input.association_milligrades,
    claim: input.claim ?? "unknown",
    explanation_ids: input.explanation_ids ?? [],
    ...(input.program_state === undefined ? {} : { program_state: input.program_state }),
    ...(input.time_state === undefined ? {} : { time_state: input.time_state })
  });
}

export function sourceIndexEntry(input: Readonly<{
  readonly workspace_id: string;
  readonly root_kind: SourceEvidenceRootKind;
  readonly root_id: string;
  readonly source_version: string;
  readonly content_digest: string;
  readonly evidence_object_id: string | null;
  readonly hypothesis_id?: string;
  readonly output_binding?: string;
  readonly role?: IndexRole;
  readonly association_milligrades: number;
  readonly claim?: z.infer<typeof ClaimStateSchema>;
  readonly explanation_ids?: readonly string[];
  readonly program_state?: string;
  readonly time_state?: string;
}>): IndexEntry {
  return IndexEntrySchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: {
      kind: "source_evidence",
      workspace_id: input.workspace_id,
      root_kind: input.root_kind,
      root_id: input.root_id,
      source_version: input.source_version,
      content_digest: input.content_digest,
      evidence_object_id: input.evidence_object_id
    },
    hypothesis_id: input.hypothesis_id ?? "h0",
    output_binding: input.output_binding ?? "default",
    role: input.role ?? "associated",
    association_milligrades: input.association_milligrades,
    claim: input.claim ?? "unknown",
    explanation_ids: input.explanation_ids ?? [],
    ...(input.program_state === undefined ? {} : { program_state: input.program_state }),
    ...(input.time_state === undefined ? {} : { time_state: input.time_state })
  });
}

export function indexEntryCacheKey(entry: IndexEntry): string {
  return canonicalIndexEntryIdentity(entry);
}

export function canonicalProductIdentityOfEntry(entry: IndexEntry): string {
  return canonicalProductIdentity(productStateKeyFromIndexEntry(entry));
}

export type { RecallTargetRef };
