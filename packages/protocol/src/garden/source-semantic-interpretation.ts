import { z } from "zod";
import { BoundedIdSchema, BoundedLabelSchema } from "../shared/schema-primitives.js";
import { SourceTextSpanSchema } from "../evidence/source-selection.js";
import { SourceReferenceCatalogSchema } from "../evidence/source-reference.js";
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
  utf8_span: SourceTextSpanSchema
}).strict().readonly();

export const SourceSemanticSourceBindingSchema = z.object({
  source_id: BoundedIdSchema,
  source_version: BoundedIdSchema,
  content_digest: Sha256DigestSchema
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

export const SourceSemanticOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_eligible_source"), provider_attempts: z.literal(0) }).strict().readonly(),
  z.object({ status: z.literal("abstained"), raw_response_id: BoundedIdSchema.optional() }).strict().readonly(),
  z.object({ status: z.literal("interpreted"), gaps: z.array(SourceSemanticGapSchema).max(256).readonly() }).strict().readonly(),
  z.object({
    status: z.literal("no_executable_proposition"),
    description: z.string().min(1).max(1024),
    context_support: z.array(z.object({
      kind: z.literal("additional"), mentions: z.array(SourceSemanticHandleSchema).max(8).readonly(),
      reading: z.string().min(1).max(256).optional()
    }).strict().readonly()).max(8).readonly()
  }).strict().readonly(),
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
    "a_predicate", "a_slot"
  ]),
  occurrence: SourceSemanticHandleSchema.optional(),
  slot_id: SourceSemanticHandleSchema.optional(),
  correspondence_index: z.number().int().nonnegative().optional()
}).strict().readonly();

export const SourceSemanticReasoningResultSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_REASONING_CONTRACT),
  outcome: SourceSemanticOutcomeSchema,
  c_id: Sha256DigestSchema.optional(),
  h_id: Sha256DigestSchema.optional(),
  q_id: Sha256DigestSchema.optional(),
  a_id: Sha256DigestSchema.optional(),
  consumed_leaves: z.array(SourceSemanticConsumedLeafSchema).max(4096).readonly(),
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
export type SourceSemanticReasoningResult = z.infer<typeof SourceSemanticReasoningResultSchema>;
export type SourceSemanticCache = z.infer<typeof SourceSemanticCacheSchema>;
