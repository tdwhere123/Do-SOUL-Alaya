import { z } from "zod";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import { sourceSemanticStanceLists } from "./source-semantic-structure.js";
import { DerivationSchema } from "../recall/conditional-field/support.js";
import { InterpretationNodeCoordinateSchema } from "../recall/conditional-field/interpretation-coordinate.js";
import { CompletenessReportSchema } from "../recall/conditional-field/index-view.js";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { SourceAssertionIdSchema, SourceTextSpanSchema } from "../evidence/source-selection.js";
import { SourceReferenceCatalogSchema, SourceReferenceSchema, sourceReferenceResolver, type SourceReferenceCatalog } from "../evidence/source-reference.js";
import { SourceEvidenceTargetSchema } from "../recall/conditional-field/product-identity.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { Sha256DigestSchema, Sha256HexSchema } from "../recall/conditional-field/common.js";
import { SourceInterpretationProfileSchema } from "./source-interpretation-profile.js";
import {
  SOURCE_SEMANTIC_PACKET_CONTRACT, SourceSemanticDraftSchema,
  SourceSemanticGapSchema, SourceSemanticGraphFields, SourceSemanticHandleSchema,
  SourceSemanticMentionSchema, refineSourceSemanticGraph
} from "./source-semantic-draft.js";

export const SOURCE_SEMANTIC_PUBLISHED_CONTRACT = "published-source-interpretation-v3" as const;
export const SOURCE_SEMANTIC_RESPONSE_CONTRACT = "source-interpretation-response-v3" as const;
export const SOURCE_SEMANTIC_REASONING_CONTRACT = "source-interpretation-reasoning-v2" as const;
export const SOURCE_SEMANTIC_CACHE_CONTRACT = "source-interpretation-cache-v2" as const;
export const SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION = 4 as const;

export const SourceSemanticNormalizedMentionSchema = SourceSemanticMentionSchema.unwrap().extend({
  text: z.string().min(1).max(65536),
  utf8_span: SourceTextSpanSchema,
  span_space: z.enum(["assertion_code_units", "source_utf8"]).optional()
}).strict().readonly();

export const SourceSemanticAssertionLocationSchema = z.object({
  assertion_id: SourceAssertionIdSchema, source_utf8_span: SourceTextSpanSchema
}).strict().readonly();

export const SourceSemanticSourceBindingSchema = z.object({
  source_id: BoundedIdSchema,
  source_version: BoundedIdSchema,
  content_digest: Sha256DigestSchema,
  assertion_locations: z.array(SourceSemanticAssertionLocationSchema).max(64).readonly().optional()
}).strict().readonly();

export const SourceSemanticInterpretationSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_PACKET_CONTRACT),
  k_version: BoundedLabelSchema,
  normalizer_version: BoundedLabelSchema,
  source: SourceSemanticSourceBindingSchema,
  producer_id: BoundedIdSchema,
  producer_version: BoundedLabelSchema,
  contract_version: BoundedLabelSchema,
  mentions: z.array(SourceSemanticNormalizedMentionSchema).max(512).readonly(),
  referents: SourceSemanticGraphFields.referents,
  frames: SourceSemanticGraphFields.frames,
  operators: SourceSemanticGraphFields.operators,
  gaps: SourceSemanticGraphFields.gaps,
  entry_roots: z.array(SourceSemanticHandleSchema).max(64).readonly(),
  asserted_at_scope: z.array(SourceSemanticHandleSchema).max(64).readonly()
}).strict().superRefine((interpretation, context) => {
  refineSourceSemanticGraph(interpretation, context);
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  const occurrences = new Set([...interpretation.frames, ...interpretation.operators].map((row) => row.id));
  if (new Set(interpretation.entry_roots).size !== interpretation.entry_roots.length ||
      interpretation.entry_roots.some((id) => !occurrences.has(id))) {
    problem("entry_roots must identify unique occurrences");
  }
  if (new Set(interpretation.asserted_at_scope).size !== interpretation.asserted_at_scope.length ||
      interpretation.asserted_at_scope.some((id) => !occurrences.has(id))) {
    problem("asserted_at_scope must identify unique occurrences");
  }
  const stance = sourceSemanticStanceLists([...interpretation.frames, ...interpretation.operators]);
  for (const key of ["entry_roots", "asserted_at_scope"] as const) {
    if (stance[key].length !== interpretation[key].length || stance[key].some((id) => !interpretation[key].includes(id))) {
      problem("stance lists must include exactly their host-derived occurrences");
    }
  }
  const byId = new Map([...interpretation.frames, ...interpretation.operators].map((row) => [row.id, row]));
  for (const id of interpretation.asserted_at_scope) {
    const owner = byId.get(id)?.context_owner;
    if (owner === undefined || owner.kind !== "source_act" || owner.source_act !== "assertion") {
      problem("asserted_at_scope requires source_act assertion");
    }
  }
}).readonly();

export const SourceSemanticPublishedInterpretationSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_PUBLISHED_CONTRACT),
  interpretation_id: Sha256DigestSchema,
  semantic_status: z.literal("unreviewed"),
  source_target: SourceEvidenceTargetSchema,
  interpretation: SourceSemanticInterpretationSchema,
  profile: SourceInterpretationProfileSchema.optional(),
  provenance: z.object({
    request_key: BoundedIdSchema.optional(),
    raw_response_id: BoundedIdSchema.optional(),
    producer_id: BoundedIdSchema,
    generation_sha256: Sha256HexSchema.optional(),
    budget: RequestBudgetSchema.optional(),
    principal: BoundedIdSchema.optional(),
    snapshot: BoundedIdSchema.optional(),
    execution_policy: BoundedLabelSchema.optional(),
    discovery_order: z.number().int().nonnegative().optional(),
    preparation_handle: BoundedIdSchema.optional(),
    transport: z.unknown().optional()
  }).strict().readonly()
}).strict().readonly();

export const LegacyUnresolvedProjectionSchema = z.object({
  kind: z.literal("legacy_unresolved"),
  source_contract: z.enum(["source-interpretation-v1", "source-interpretation-v2"]),
  missing: z.array(z.enum(["stance", "alignment", "context_owner", "asserted_at_scope"])).min(1).readonly()
}).strict().readonly();

export const SourceSemanticNoPropositionOutcomeSchema = z.object({
  status: z.literal("no_executable_proposition"), description: z.string().min(1).max(1024),
  context_support: z.array(z.object({ kind: z.literal("source_reference"), assertion_id: SourceAssertionIdSchema,
    source_ref: SourceReferenceSchema }).strict().readonly()).min(1).max(8).readonly()
}).strict().readonly();

export function verifySourceSemanticDisposition(value: unknown, catalog: SourceReferenceCatalog, sha256: FieldContractSha256) {
  const disposition = SourceSemanticNoPropositionOutcomeSchema.parse(value);
  const resolver = sourceReferenceResolver(catalog, sha256);
  for (const support of disposition.context_support) resolver.resolve(catalog.catalog_id, support.assertion_id, support.source_ref);
  return disposition;
}

export const SourceSemanticOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_eligible_source"), provider_attempts: z.literal(0) }).strict().readonly(),
  z.object({ status: z.literal("unavailable"), reason: BoundedLabelSchema }).strict().readonly(),
  z.object({ status: z.literal("abstained"), raw_response_id: BoundedIdSchema.optional() }).strict().readonly(),
  z.object({ status: z.literal("interpreted"), gaps: z.array(SourceSemanticGapSchema).max(256).readonly() }).strict().readonly(),
  SourceSemanticNoPropositionOutcomeSchema,
  z.object({ status: z.literal("invalid"), reason: BoundedLabelSchema }).strict().readonly(),
  z.object({ status: z.literal("quarantine"), reason: BoundedLabelSchema }).strict().readonly(),
  z.object({ status: z.literal("truncated") }).strict().readonly(),
  z.object({ status: z.literal("transport_failure") }).strict().readonly(),
  z.object({ status: z.literal("resource_exhausted") }).strict().readonly(),
  z.object({ status: z.literal("unexercised") }).strict().readonly(),
  z.object({ status: z.literal("preparation_required"), missing: z.enum(["q", "a", "q_and_a"]) }).strict().readonly()
]);

export const SourceSemanticRequestEnvelopeSchema = z.object({
  schema_version: z.literal(SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION),
  interpretation_contract: z.literal(SOURCE_SEMANTIC_PACKET_CONTRACT),
  source_request: z.unknown(),
  source_catalog: SourceReferenceCatalogSchema,
  profile: SourceInterpretationProfileSchema.optional()
}).strict().readonly();

export const SourceSemanticResponseEnvelopeSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_RESPONSE_CONTRACT),
  outcome: SourceSemanticOutcomeSchema,
  draft: SourceSemanticDraftSchema.optional()
}).strict().superRefine((envelope, context) => {
  const interpreted = envelope.outcome.status === "interpreted";
  if (interpreted !== (envelope.draft !== undefined)) {
    context.addIssue({ code: "custom", message: "interpreted outcome requires a draft; other outcomes must not carry one" });
  }
}).readonly();

export const SourceSemanticReasoningRequestSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_REASONING_CONTRACT),
  accepts_unreviewed_conditional_results: z.literal(true),
  h_id: Sha256DigestSchema,
  q_id: Sha256DigestSchema,
  a_id: Sha256DigestSchema,
  original_query: z.string().min(1).max(8192),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().readonly();

export const SourceSemanticConsumedLeafSchema = z.object({
  leaf_kind: z.enum([
    "h_presence", "h_binding", "h_assertion_permission", "h_content",
    "a_predicate", "a_slot", "a_referent", "h_source_act", "h_operator", "h_sort", "h_context"
  ]),
  occurrence: SourceSemanticHandleSchema.optional(),
  slot_id: SourceSemanticHandleSchema.optional(),
  correspondence_index: z.number().int().nonnegative().optional(),
  parent: SourceSemanticHandleSchema.optional(),
  target: SourceSemanticHandleSchema.optional(),
  relation_kind: z.enum(["embedding", "operator_operand"]).optional(),
  role: z.enum(["content", "antecedent", "consequent", "reporter"]).optional(),
  value: BoundedLabelSchema.optional()
}).strict().readonly();

export const SourceSemanticAnswerSchema = z.object({
  binding_id: BoundedIdSchema,
  alternative: z.number().int().nonnegative(),
  bindings: z.record(SourceSemanticHandleSchema, InterpretationNodeCoordinateSchema),
  returned: z.record(SourceSemanticHandleSchema, InterpretationNodeCoordinateSchema),
  explanation_ids: z.array(BoundedIdSchema).max(1000).readonly(),
  query_complete: z.boolean()
}).strict().readonly();

export const SourceSemanticReasoningResultSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_REASONING_CONTRACT),
  outcome: SourceSemanticOutcomeSchema,
  c_id: Sha256DigestSchema.optional(),
  h_id: Sha256DigestSchema.optional(),
  q_id: Sha256DigestSchema.optional(),
  a_id: Sha256DigestSchema.optional(),
  consumed_leaves: z.array(SourceSemanticConsumedLeafSchema).max(4096).readonly(),
  answers: z.array(SourceSemanticAnswerSchema).max(1000).readonly().optional(),
  derivations: z.array(DerivationSchema).max(1000).readonly().optional(),
  evidence_leaves: z.array(z.object({ observation_id: BoundedIdSchema, leaf: SourceSemanticConsumedLeafSchema }).strict().readonly()).max(4096).readonly().optional(),
  completeness: CompletenessReportSchema.optional(),
  query_gaps: z.array(SourceSemanticGapSchema).max(256).readonly().optional(),
  source_target: SourceEvidenceTargetSchema.optional(),
  resource_usage: z.object({ work_units: z.number().int().nonnegative(), memory_bytes: z.number().int().nonnegative() }).strict().readonly().optional(),
  semantic_status: z.literal("unreviewed"),
  conclusion_scope: z.literal("conditional_on_interpretation"),
  world_claim: z.literal("unknown")
}).strict().readonly();

export const SourceSemanticCacheSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_CACHE_CONTRACT),
  source_binding: z.enum(["unbound", "bound"]),
  interpretation_contract: z.literal(SOURCE_SEMANTIC_PACKET_CONTRACT)
}).strict().readonly();

export type SourceSemanticNormalizedMention = z.infer<typeof SourceSemanticNormalizedMentionSchema>;
export type SourceSemanticSourceBinding = z.infer<typeof SourceSemanticSourceBindingSchema>;
export type SourceSemanticInterpretation = z.infer<typeof SourceSemanticInterpretationSchema>;
export type SourceSemanticPublishedInterpretation = z.infer<typeof SourceSemanticPublishedInterpretationSchema>;
export type LegacyUnresolvedProjection = z.infer<typeof LegacyUnresolvedProjectionSchema>;
export type SourceSemanticOutcome = z.infer<typeof SourceSemanticOutcomeSchema>;
export type SourceSemanticRequestEnvelope = z.infer<typeof SourceSemanticRequestEnvelopeSchema>;
export type SourceSemanticResponseEnvelope = z.infer<typeof SourceSemanticResponseEnvelopeSchema>;
export type SourceSemanticReasoningRequest = z.infer<typeof SourceSemanticReasoningRequestSchema>;
export type SourceSemanticConsumedLeaf = z.infer<typeof SourceSemanticConsumedLeafSchema>;
export type SourceSemanticAnswer = z.infer<typeof SourceSemanticAnswerSchema>;
export type SourceSemanticReasoningResult = z.infer<typeof SourceSemanticReasoningResultSchema>;
export type SourceSemanticCache = z.infer<typeof SourceSemanticCacheSchema>;
