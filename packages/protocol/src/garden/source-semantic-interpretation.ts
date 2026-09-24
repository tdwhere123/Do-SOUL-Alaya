import { z } from "zod";
import { UtteranceAttributionSchema } from "../conversation/utterance-attribution.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import { SourceSemanticDiagnosticsSchema } from "./source-semantic-diagnostics.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import { sourceSemanticStanceLists } from "./source-semantic-structure.js";
import { DerivationSchema } from "../recall/conditional-field/support.js";
import { InterpretationNodeCoordinateSchema } from "../recall/conditional-field/interpretation-coordinate.js";
import { CompletenessReportSchema } from "../recall/conditional-field/index-view.js";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { SourceAssertionIdSchema, SourceTextSpanSchema } from "../evidence/source-selection.js";
import { SourceReferenceCatalogSchema, SourceReferenceSchema, sourceReferenceResolver,
  SOURCE_REFERENCE_MAX_ASSERTIONS, type SourceReferenceCatalog } from "../evidence/source-reference.js";
import { SourceEvidenceTargetSchema } from "../recall/conditional-field/product-identity.js";
import { RequestBudgetSchema } from "../recall/conditional-field/query.js";
import { Sha256DigestSchema, Sha256HexSchema } from "../recall/conditional-field/common.js";
import { SourceSemanticQueryGapSchema, SourceSemanticQueryTargetSchema } from "../recall/conditional-field/semantic-query.js";
import { SourceInterpretationProfileSchema } from "./source-interpretation-profile.js";
import {
  SOURCE_SEMANTIC_PACKET_CONTRACT, SourceSemanticDraftSchema,
  SourceSemanticGapSchema, SourceSemanticGraphFields, SourceSemanticHandleSchema,
  SourceSemanticMentionSchema, SourceSemanticReadingSchema, SourceSemanticDecimalSchema, refineSourceSemanticGraph
} from "./source-semantic-draft.js";

export const SOURCE_SEMANTIC_PUBLISHED_CONTRACT = "published-source-interpretation-v5" as const;
export const SOURCE_SEMANTIC_RESPONSE_CONTRACT = "source-interpretation-response-v5" as const;
export const SOURCE_SEMANTIC_REASONING_CONTRACT = "source-interpretation-reasoning-v5" as const;
export const SOURCE_SEMANTIC_CACHE_CONTRACT = "source-interpretation-cache-v3" as const;
export const SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION = 6 as const;

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
  attribution_context: UtteranceAttributionSchema,
  assertion_locations: z.array(SourceSemanticAssertionLocationSchema).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly().optional()
}).strict().readonly();

/** Recorded schema-v5 source bindings are inspectable only by retained readers. */
export const RetainedSourceSemanticSourceBindingSchema = SourceSemanticSourceBindingSchema.unwrap().omit({
  attribution_context: true
}).strict().readonly();

const SourceSemanticInterpretationBaseSchema = z.object({
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
  domains: SourceSemanticGraphFields.domains,
  measurements: SourceSemanticGraphFields.measurements,
  gaps: SourceSemanticGraphFields.gaps,
  entry_roots: z.array(SourceSemanticHandleSchema).max(64).readonly(),
  asserted_at_scope: z.array(SourceSemanticHandleSchema).max(64).readonly()
}).strict();

function refineInterpretation(interpretation: Omit<z.infer<typeof SourceSemanticInterpretationBaseSchema>, "source">,
  context: z.RefinementCtx): void {
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
}

export const SourceSemanticInterpretationSchema = SourceSemanticInterpretationBaseSchema
  .superRefine(refineInterpretation).readonly();
export const RetainedSourceSemanticInterpretationSchema = SourceSemanticInterpretationBaseSchema.extend({
  source: RetainedSourceSemanticSourceBindingSchema
}).superRefine(refineInterpretation).readonly();

const SourceSemanticPublishedInterpretationBaseSchema = z.object({
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
}).strict();
export const SourceSemanticPublishedInterpretationSchema = SourceSemanticPublishedInterpretationBaseSchema.readonly();
export const RetainedSourceSemanticPublishedInterpretationSchema = SourceSemanticPublishedInterpretationBaseSchema.extend({
  contract: z.literal("published-source-interpretation-v4"),
  interpretation: RetainedSourceSemanticInterpretationSchema
}).readonly();

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

const SourceSemanticInterpretedOutcomeSchema = z.object({ status: z.literal("interpreted"),
  gaps: z.array(SourceSemanticGapSchema).max(256).readonly() }).strict().readonly();

export const SourceSemanticOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_eligible_source"), provider_attempts: z.literal(0) }).strict().readonly(),
  z.object({ status: z.literal("unavailable"), reason: BoundedLabelSchema }).strict().readonly(),
  z.object({ status: z.literal("abstained"), raw_response_id: BoundedIdSchema.optional() }).strict().readonly(),
  SourceSemanticInterpretedOutcomeSchema,
  SourceSemanticNoPropositionOutcomeSchema,
  z.object({ status: z.literal("invalid"), reason: BoundedLabelSchema,
    diagnostics: SourceSemanticDiagnosticsSchema.optional() }).strict().readonly(),
  z.object({ status: z.literal("quarantine"), reason: BoundedLabelSchema }).strict().readonly(),
  z.object({ status: z.literal("truncated") }).strict().readonly(),
  z.object({ status: z.literal("transport_failure") }).strict().readonly(),
  z.object({ status: z.literal("resource_exhausted") }).strict().readonly(),
  z.object({ status: z.literal("unexercised") }).strict().readonly(),
  z.object({ status: z.literal("preparation_required"), missing: z.enum(["query_semantics", "semantic_correspondence", "query_semantics_and_correspondence"]) }).strict().readonly()
]);

const SourceSemanticQueryOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("interpreted"), gaps: z.array(SourceSemanticQueryGapSchema).max(256).readonly() }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter((option): option is Exclude<typeof option,
    typeof SourceSemanticInterpretedOutcomeSchema> => option.unwrap().shape.status.value !== "interpreted")
]);
export type SourceSemanticQueryOutcome = z.infer<typeof SourceSemanticQueryOutcomeSchema>;

const SourceSemanticRequestEnvelopeBaseSchema = z.object({
  schema_version: z.number().int().min(1).max(SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION),
  interpretation_contract: z.literal(SOURCE_SEMANTIC_PACKET_CONTRACT),
  source_request: z.unknown(),
  source_catalog: SourceReferenceCatalogSchema.optional(),
  source_digest: Sha256HexSchema.optional(),
  profile: SourceInterpretationProfileSchema.optional()
}).strict();
export const SourceSemanticRequestEnvelopeSchema = SourceSemanticRequestEnvelopeBaseSchema.extend({
  schema_version: z.literal(SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION)
}).readonly();
export const RetainedSourceSemanticRequestEnvelopeSchema = SourceSemanticRequestEnvelopeBaseSchema.readonly();

export const SourceSemanticResponseEnvelopeSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_RESPONSE_CONTRACT),
  outcome: SourceSemanticOutcomeSchema,
  draft: SourceSemanticDraftSchema.optional()
}).strict().superRefine((envelope, context) => {
  const interpreted = envelope.outcome.status === "interpreted";
  if (interpreted !== (envelope.draft !== undefined)) {
    context.addIssue({ code: "custom", message: "interpreted outcome requires a draft; other outcomes must not carry one" });
  }
  if (envelope.draft !== undefined) refineSourceSemanticOutcomeGaps(envelope.outcome, envelope.draft.gaps, context);
}).readonly();

/** The body owns executable gaps. The envelope is an exact echo, never a second channel. */
function refineSourceSemanticOutcomeGaps(
  outcome: Readonly<{ status: string; gaps?: readonly unknown[] }>, gaps: readonly unknown[],
  context: { addIssue: (issue: { code: "custom"; path: string[]; message: string; params: { diagnostic_code: string } }) => void }
): void {
  if (outcome.status === "interpreted" && canonicalJson(outcome.gaps) !== canonicalJson(gaps)) {
    context.addIssue({ code: "custom", path: ["outcome", "gaps"],
      message: "interpreted outcome gaps must exactly echo body gaps",
      params: { diagnostic_code: "outcome_gap_mismatch" } });
  }
}

export const SourceSemanticOutcomeGapBindingSchema = z.object({
  outcome: SourceSemanticOutcomeSchema,
  gaps: z.array(SourceSemanticGapSchema).max(256).readonly()
}).strict().superRefine((value, context) => refineSourceSemanticOutcomeGaps(value.outcome, value.gaps, context));

export const SourceSemanticQueryOutcomeGapBindingSchema = z.object({
  outcome: SourceSemanticQueryOutcomeSchema,
  gaps: z.array(SourceSemanticQueryGapSchema).max(256).readonly()
}).strict().superRefine((value, context) => refineSourceSemanticOutcomeGaps(value.outcome, value.gaps, context));

export const SourceSemanticReasoningRequestSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_REASONING_CONTRACT),
  accepts_unreviewed_conditional_results: z.literal(true),
  source_interpretation_id: Sha256DigestSchema,
  query_semantics_id: Sha256DigestSchema,
  semantic_correspondence_id: Sha256DigestSchema,
  original_query: z.string().min(1).max(8192),
  budget: RequestBudgetSchema,
  output_byte_limit: z.number().int().min(1024).max(1_000_000)
}).strict().readonly();

export const SourceSemanticConsumedLeafSchema = z.object({
  leaf_kind: z.enum([
    "source_interpretation_presence", "source_interpretation_binding", "source_interpretation_assertion_permission", "source_interpretation_content",
    "semantic_correspondence_predicate", "semantic_correspondence_slot", "semantic_correspondence_referent", "source_interpretation_source_act", "source_interpretation_operator", "source_interpretation_sort", "source_interpretation_context",
    "source_interpretation_domain", "source_interpretation_membership", "source_interpretation_restriction", "source_interpretation_closure", "source_interpretation_measurement", "source_interpretation_numeric_order", "source_interpretation_instantiation", "semantic_correspondence_membership", "semantic_correspondence_domain"
  ]),
  occurrence: SourceSemanticHandleSchema.optional(),
  slot_id: SourceSemanticHandleSchema.optional(),
  correspondence_index: z.number().int().nonnegative().optional(),
  parent: SourceSemanticHandleSchema.optional(),
  target: SourceSemanticHandleSchema.optional(),
  relation_kind: z.enum(["embedding", "operator_operand"]).optional(),
  role: z.enum(["content", "antecedent", "consequent", "reporter", "restriction"]).optional(),
  value: BoundedLabelSchema.optional(),
  domain: SourceSemanticHandleSchema.optional(),
  member: BoundedIdSchema.optional(),
  quantifier: SourceSemanticHandleSchema.optional(),
  binder: SourceSemanticHandleSchema.optional(),
  derived_node: BoundedIdSchema.optional(),
  derived_parent: BoundedIdSchema.optional(),
  derived_target: BoundedIdSchema.optional(),
  measurement: SourceSemanticHandleSchema.optional(),
  other_measurement: SourceSemanticHandleSchema.optional(),
  metric: SourceSemanticReadingSchema.optional(),
  unit: SourceSemanticReadingSchema.optional(),
  measurement_context: SourceSemanticReadingSchema.optional(),
  decimal_value: SourceSemanticDecimalSchema.optional(),
  assumption_index: z.number().int().nonnegative().optional(),
  context_path: z.array(SourceSemanticHandleSchema).max(16).readonly().optional()
}).strict().readonly();

export const SourceSemanticDerivedNodeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instantiation"), node_id: BoundedIdSchema,
    template: SourceSemanticHandleSchema, quantifier: SourceSemanticHandleSchema,
    binder: SourceSemanticHandleSchema, member: BoundedIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("query_entity"), node_id: BoundedIdSchema,
    query_variable: SourceSemanticHandleSchema, excerpt: z.string().min(1).max(1024) }).strict().readonly(),
  z.object({ kind: z.literal("instance_slot"), node_id: BoundedIdSchema,
    instance: BoundedIdSchema, slot_id: SourceSemanticHandleSchema }).strict().readonly(),
  z.object({ kind: z.literal("comparison"), node_id: BoundedIdSchema,
    left: SourceSemanticHandleSchema, right: SourceSemanticHandleSchema }).strict().readonly()
]);

export const SourceSemanticEvaluationReportSchema = z.object({
  status: z.enum(["supported", "refuted", "unknown", "incomparable", "inconsistent", "empty_domain"]),
  domain_closed: z.boolean(),
  vacuous: z.boolean(),
  reasons: z.array(z.enum(["open_domain", "missing_membership", "excluded_member", "missing_restriction",
    "missing_body_proof", "missing_operand", "incompatible_measurement", "no_unique_extremum", "empty_domain", "no_proof"])).max(16).readonly(),
  counterexample_explanation_ids: z.array(BoundedIdSchema).max(1000).readonly()
}).strict().readonly();

const BindingResult = z.object({
  binding_id: BoundedIdSchema,
  alternative: z.number().int().nonnegative(),
  bindings: z.record(SourceSemanticHandleSchema, InterpretationNodeCoordinateSchema),
  returned: z.record(SourceSemanticHandleSchema, InterpretationNodeCoordinateSchema),
  explanation_ids: z.array(BoundedIdSchema).max(1000).readonly()
}).strict();

export const SourceSemanticBindingResultSchema = z.discriminatedUnion("kind", [
  BindingResult.merge(SourceSemanticQueryTargetSchema.options[0].unwrap()).extend({ query_complete: z.boolean() }).readonly(),
  BindingResult.merge(SourceSemanticQueryTargetSchema.options[1].unwrap()).extend({ query_complete: z.literal(false) }).readonly()
]);

export const SourceSemanticReasoningResultSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_REASONING_CONTRACT),
  outcome: SourceSemanticOutcomeSchema,
  conditional_computation_id: Sha256DigestSchema.optional(),
  source_interpretation_id: Sha256DigestSchema.optional(),
  query_semantics_id: Sha256DigestSchema.optional(),
  semantic_correspondence_id: Sha256DigestSchema.optional(),
  consumed_leaves: z.array(SourceSemanticConsumedLeafSchema).max(4096).readonly(),
  binding_results: z.array(SourceSemanticBindingResultSchema).max(1000).readonly().optional(),
  derivations: z.array(DerivationSchema).max(1000).readonly().optional(),
  evidence_leaves: z.array(z.object({ observation_id: BoundedIdSchema, leaf: SourceSemanticConsumedLeafSchema }).strict().readonly()).max(4096).readonly().optional(),
  completeness: CompletenessReportSchema.optional(),
  query_gaps: z.array(SourceSemanticQueryGapSchema).max(256).readonly().optional(),
  source_target: SourceEvidenceTargetSchema.optional(),
  resource_usage: z.object({ work_units: z.number().int().nonnegative(), memory_bytes: z.number().int().nonnegative() }).strict().readonly().optional(),
  derived_nodes: z.array(SourceSemanticDerivedNodeSchema).max(4096).readonly().optional(),
  evaluation: SourceSemanticEvaluationReportSchema.optional(),
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
export type RetainedSourceSemanticInterpretation = z.infer<typeof RetainedSourceSemanticInterpretationSchema>;
export type SourceSemanticPublishedInterpretation = z.infer<typeof SourceSemanticPublishedInterpretationSchema>;
export type LegacyUnresolvedProjection = z.infer<typeof LegacyUnresolvedProjectionSchema>;
export type SourceSemanticOutcome = z.infer<typeof SourceSemanticOutcomeSchema>;
export type SourceSemanticRequestEnvelope = z.infer<typeof SourceSemanticRequestEnvelopeSchema>;
export type SourceSemanticResponseEnvelope = z.infer<typeof SourceSemanticResponseEnvelopeSchema>;
export type SourceSemanticReasoningRequest = z.infer<typeof SourceSemanticReasoningRequestSchema>;
export type SourceSemanticConsumedLeaf = z.infer<typeof SourceSemanticConsumedLeafSchema>;
export type SourceSemanticDerivedNode = z.infer<typeof SourceSemanticDerivedNodeSchema>;
export type SourceSemanticEvaluationReport = z.infer<typeof SourceSemanticEvaluationReportSchema>;
export type SourceSemanticBindingResult = z.infer<typeof SourceSemanticBindingResultSchema>;
export type SourceSemanticReasoningResult = z.infer<typeof SourceSemanticReasoningResultSchema>;
export type SourceSemanticCache = z.infer<typeof SourceSemanticCacheSchema>;
