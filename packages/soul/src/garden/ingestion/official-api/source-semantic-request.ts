import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AlayaError, BoundedIdSchema, SourceAssertionIdSchema, SourceSemanticAssertionLocationSchema, SourceSemanticInterpretationSchema, sourceSemanticInterpretationIdentity,
  SourceSemanticQuerySchema, SourceSemanticRequestEnvelopeSchema, SourceSemanticResponseEnvelopeSchema,
  RetainedSourceSemanticRequestEnvelopeSchema,
  SourceSemanticProposalSchema, SOURCE_SEMANTIC_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_LEGACY_NORMALIZER_VERSION,
  SourceSemanticContentProposalSchema, SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT,
  SourceSemanticExpressionProposalSchema, SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT,
  SourceSemanticExpressionGenerationSchema,
  SourceSemanticCompactProposalSchema, SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_COMPACT_GENERATION_CONTRACT, SourceSemanticCompactGenerationSchema,
  SourceSemanticSelectionProposalSchema, SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT, SourceSemanticSelectionGenerationSchema,
  SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION, SOURCE_SEMANTIC_K_VERSION,
  SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SourceSemanticQueryGapSchema,


  SourceSemanticQueryMeaningBodySchema, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH, SourceSemanticCorrespondenceSelectionSchema,
  buildSourceReferenceCatalog, buildSourceSemanticCorrespondenceEndpointCatalog, canonicalJson,
  sourceReferenceCapacityReason, SourceReferenceCapacityExceeded, SourceReferenceCapacityReasonSchema,
  SOURCE_REFERENCE_MAX_ASSERTIONS,
  type SourceInterpretationProfile, type SourceReferenceCatalog, type SourceSemanticQuery,
  type SourceSemanticCorrespondenceEndpointCatalog,
  ApprovedSemanticContextSchema, UtteranceAttributionSchema, UNKNOWN_UTTERANCE_ATTRIBUTION,
  bindUtteranceAttribution, type UtteranceAttribution
} from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT, indexSourceSemanticUnits, selectSourceSemanticUnits } from "./source-semantic-units.js";
import { sourceSemanticQueryExamples } from "./source-semantic-query-examples.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as CONTENT_SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-content-guidance.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as EXPRESSION_SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-expression-guidance.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as COMPACT_SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-compact-guidance.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-selection-guidance.js";
import { CANONICAL_SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-canonical-prompt.js";
import { SourceSemanticRevisionSchema, validateSourceSemanticRevision, type SourceSemanticRevision } from "./source-semantic-revision.js";
export { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-selection-guidance.js";

export const SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT = "source-semantic-query-request-v8" as const;
export const SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT = "source-semantic-query-response-v7" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_REQUEST_CONTRACT = "source-semantic-correspondence-request-v5" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT = "source-semantic-correspondence-response-v3" as const;

const FORBIDDEN_PROPOSAL_KEYS = [
  "answers", "answer", "ranking", "seeds", "seed", "programs", "program",
  "verdicts", "verdict", "QueryProgram", "query_program", "answer_ids", "answerIds"
] as const;

const SourceSemanticResourceLimitsSchema = z.object({
  output_byte_limit: z.number().int().min(1024).max(1024 * 1024),
  work_units: z.number().int().nonnegative().optional(),
  memory_bytes: z.number().int().nonnegative().optional()
}).strict().readonly();

const ProducerCapability = z.object({
  producer_id: BoundedIdSchema,
  producer_version: z.string().min(1).max(1024),
  proposes: z.literal("draft_semantics")
}).strict().readonly();

const SourceSemanticOpenRequestBodySchema = z.object({
  k_version: z.literal(SOURCE_SEMANTIC_K_VERSION),
  normalizer_version: z.enum([SOURCE_SEMANTIC_LEGACY_NORMALIZER_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION]),
  proposal_contract: z.enum([SOURCE_SEMANTIC_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT,
    SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT,
    SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT]).optional(),
  source_unit_contract: z.literal(SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT).optional(),
  source_scope: z.literal("complete-source").optional(),
  generation_schema_contract: z.enum(["bounded-expression-schema-v1", SOURCE_SEMANTIC_COMPACT_GENERATION_CONTRACT,
    SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT]).optional(),
  revision: SourceSemanticRevisionSchema.optional(),
  producer_capability: ProducerCapability,
  resource_limits: SourceSemanticResourceLimitsSchema,
  attribution_context: UtteranceAttributionSchema.optional(),
  assertion_locations: z.array(SourceSemanticAssertionLocationSchema).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly().optional(),
  source_assertions: z.array(z.object({
    assertion_id: SourceAssertionIdSchema, text: z.string().trim().min(1), source_role: z.enum(["user", "assistant"]).optional()
  }).strict().readonly()).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly()
}).strict().superRefine((request, context) => {
  if (request.source_scope === undefined && (request.source_assertions.length > 8 || (request.assertion_locations?.length ?? 0) > 8)) {
    context.addIssue({ code: "custom", message: "partial source requests permit at most eight source units" });
  }
  if (request.source_scope !== undefined && request.source_unit_contract === undefined) {
    context.addIssue({ code: "custom", message: "complete source scope requires the source unit contract" });
  }
  const current = request.proposal_contract !== undefined;
  if (current !== (request.normalizer_version === SOURCE_SEMANTIC_NORMALIZER_VERSION)) {
    context.addIssue({ code: "custom", message: "proposal contract and normalizer version must agree" });
  }
  if (request.source_unit_contract === undefined && request.source_assertions.some((row) => row.source_role !== undefined)) {
    context.addIssue({ code: "custom", message: "source roles require the source unit contract" });
  }
  if (request.source_unit_contract !== undefined && (!current || request.source_assertions.some((row) => row.source_role === undefined))) {
    context.addIssue({ code: "custom", message: "source units require the current proposal contract and explicit source roles" });
  }
  const semanticContent = request.proposal_contract === SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT ||
    request.proposal_contract === SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT ||
    request.proposal_contract === SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT ||
    request.proposal_contract === SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT;
  if (semanticContent && request.source_unit_contract === undefined) {
    context.addIssue({ code: "custom", message: "content proposals require complete source units" });
  }
  if (request.revision !== undefined && !semanticContent) {
    context.addIssue({ code: "custom", message: "revision requires the semantic content proposal contract" });
  }
  if (request.generation_schema_contract === "bounded-expression-schema-v1" &&
    request.proposal_contract !== SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT) {
    context.addIssue({ code: "custom", message: "bounded generation schema requires the expression proposal contract" });
  }
  if (request.generation_schema_contract === SOURCE_SEMANTIC_COMPACT_GENERATION_CONTRACT &&
    request.proposal_contract !== SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT) {
    context.addIssue({ code: "custom", message: "host-owned generation schema requires the compact expression proposal contract" });
  }
  if (request.proposal_contract === SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT &&
    request.generation_schema_contract !== SOURCE_SEMANTIC_COMPACT_GENERATION_CONTRACT) {
    context.addIssue({ code: "custom", message: "compact expression proposals require the host-owned generation schema" });
  }
  if (request.generation_schema_contract === SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT &&
    request.proposal_contract !== SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT) {
    context.addIssue({ code: "custom", message: "host-owned selection schema requires the selection proposal contract" });
  }
  if (request.proposal_contract === SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT &&
    request.generation_schema_contract !== SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT) {
    context.addIssue({ code: "custom", message: "selection proposals require the host-owned selection schema" });
  }
}).readonly();

const ApprovedContextSchema = ApprovedSemanticContextSchema;

const SourceInterpretationDescriptorSchema = z.object({
  source_interpretation_id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  interpretation: SourceSemanticInterpretationSchema
}).strict().superRefine((descriptor, context) => {
  if (sourceSemanticInterpretationIdentity(descriptor.interpretation, semanticSha256) !== descriptor.source_interpretation_id) {
    context.addIssue({ code: "custom", message: "semantic_correspondence descriptor identity differs from its interpretation" });
  }
}).readonly();

type SourceSemanticResourceLimits = z.infer<typeof SourceSemanticResourceLimitsSchema>;
type SourceSemanticOpenRequestBody = z.infer<typeof SourceSemanticOpenRequestBodySchema>;
type SourceSemanticApprovedContext = z.infer<typeof ApprovedContextSchema>;
export type SourceInterpretationDescriptor = z.infer<typeof SourceInterpretationDescriptorSchema>;

export type SourceSemanticRequest = Readonly<{
  schema_version: number;
  interpretation_contract: typeof SOURCE_SEMANTIC_PACKET_CONTRACT;
  source_request: SourceSemanticOpenRequestBody;
  profile?: SourceInterpretationProfile;
}> & (Readonly<{ source_digest: string; source_catalog?: never }>
  | Readonly<{ source_catalog: SourceReferenceCatalog; source_digest?: never }>);

export type SourceSemanticProposalInput = Readonly<{
  sourceCorpus: string;
  assertionIds: readonly number[];
  sourceScope?: SourceSemanticOpenRequestBody["source_scope"];
  source_id: string;
  source_version: string;
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
  profile?: SourceInterpretationProfile;
  revision?: SourceSemanticRevision;
  attribution_context?: UtteranceAttribution;
}>;

export const SourceSemanticUnsupportedSourceSchema = z.object({
  status: z.literal("unsupported_source"),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  source_scope: z.literal("complete-source"),
  source_unit_contract: z.literal(SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT),
  interpretation_contract: z.literal(SOURCE_SEMANTIC_PACKET_CONTRACT),
  k_version: z.literal(SOURCE_SEMANTIC_K_VERSION),
  normalizer_version: z.literal(SOURCE_SEMANTIC_NORMALIZER_VERSION),
  proposal_contract: z.literal(SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT),
  generation_schema_contract: z.literal(SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT),
  assertion_count: z.number().int().positive(),
  reason: SourceReferenceCapacityReasonSchema
}).strict().readonly();
export type SourceSemanticHostPreparation = Readonly<{ status: "ready"; request: SourceSemanticRequest }>
  | z.infer<typeof SourceSemanticUnsupportedSourceSchema>;

export type SourceSemanticQueryProposalInput = Readonly<{
  original_query: string;
  approved_fixed_context?: SourceSemanticApprovedContext;
  attribution_context?: UtteranceAttribution;
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
}>;

export type SourceSemanticCorrespondenceProposalInput = Readonly<{
  original_query: string;
  admitted_query_semantics: SourceSemanticQuery;
  source_interpretation_descriptors: readonly SourceInterpretationDescriptor[];
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
}>;

export type SourceSemanticQueryRequest = Readonly<{
  contract: typeof SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  original_query: string;
  original_query_digest: string;
  approved_fixed_context?: SourceSemanticApprovedContext;
  attribution_context: UtteranceAttribution;
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
}>;

export type SourceSemanticCorrespondenceRequest = Readonly<{
  original_query: string;
  contract: typeof SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  admitted_query_semantics: SourceSemanticQuery;
  source_interpretation_descriptors: readonly SourceInterpretationDescriptor[];
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
  catalog: SourceSemanticCorrespondenceEndpointCatalog;
}>;

export function semanticSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function rejectForbiddenProposalInput(value: object): void {
  for (const key of FORBIDDEN_PROPOSAL_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new AlayaError("VALIDATION", `semantic proposal input must not include ${key}`);
    }
  }
}

function resourceLimits(value?: Partial<SourceSemanticResourceLimits>): SourceSemanticResourceLimits {
  return SourceSemanticResourceLimitsSchema.parse({
    output_byte_limit: value?.output_byte_limit ?? 1024 * 1024,
    ...(value?.work_units !== undefined ? { work_units: value.work_units } : {}),
    ...(value?.memory_bytes !== undefined ? { memory_bytes: value.memory_bytes } : {})
  });
}

function producerCapability(producer_id: string, producer_version: string) {
  return ProducerCapability.parse({ producer_id, producer_version, proposes: "draft_semantics" });
}

const requestCatalogs = new WeakMap<SourceSemanticRequest, SourceReferenceCatalog>();

export function parseRetainedSourceSemanticRequest(value: unknown): SourceSemanticRequest {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "source semantic request exceeds its byte bound");
  }
  const parsed = RetainedSourceSemanticRequestEnvelopeSchema.parse(value);
  const source_request = SourceSemanticOpenRequestBodySchema.parse(parsed.source_request);
  if (parsed.schema_version < SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION && source_request.attribution_context !== undefined) {
    throw new AlayaError("CONFLICT", "retained source request cannot gain attribution after recording");
  }
  if (new Set(source_request.source_assertions.map((row) => row.assertion_id)).size !== source_request.source_assertions.length) {
    throw new AlayaError("VALIDATION", "source semantic request has duplicate assertion identities");
  }
  const selection = source_request.proposal_contract === SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT;
  if (selection ? parsed.source_digest === undefined || parsed.source_catalog !== undefined
    : parsed.source_catalog === undefined || parsed.source_digest !== undefined) {
    throw new AlayaError("VALIDATION", "source semantic request source binding differs from its proposal contract");
  }
  const request = Object.freeze({ ...parsed, source_request }) as SourceSemanticRequest;
  requestCatalogs.set(request, sourceSemanticRequestCatalog(request));
  if (source_request.revision !== undefined) validateSourceSemanticRevision(request, source_request.revision);
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "source semantic request exceeds its byte bound");
  }
  return request;
}

/** Current execution accepts only the current producer wire. Retained bytes use the explicit verifier. */
export function parseSourceSemanticRequest(value: unknown): SourceSemanticRequest {
  const request = parseRetainedSourceSemanticRequest(value);
  if (request.schema_version !== SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION ||
      request.source_request.proposal_contract !== SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT ||
      request.source_request.attribution_context === undefined ||
      request.source_request.generation_schema_contract !== SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT ||
      request.source_request.normalizer_version !== SOURCE_SEMANTIC_NORMALIZER_VERSION ||
      request.source_request.source_unit_contract !== SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT ||
      request.source_request.assertion_locations === undefined) {
    throw new AlayaError("CONFLICT", "retired source semantic request is ineligible for current execution");
  }
  return request;
}

/** Catalog identity and segmentation remain owned by the shared source-reference builder. */
export function sourceSemanticRequestCatalog(request: SourceSemanticRequest): SourceReferenceCatalog {
  const retained = requestCatalogs.get(request);
  if (retained !== undefined) return retained;
  const digest = request.source_digest ?? request.source_catalog?.source_digest;
  if (digest === undefined) throw new AlayaError("VALIDATION", "source semantic request requires a source digest");
  const catalog = buildSourceReferenceCatalog(digest, request.source_request.source_assertions, semanticSha256);
  if (request.source_catalog !== undefined && canonicalJson(catalog) !== canonicalJson(request.source_catalog)) {
    throw new AlayaError("CONFLICT", "source semantic request catalog mismatch");
  }
  return catalog;
}

export function prepareSourceSemanticRequest(input: SourceSemanticProposalInput): SourceSemanticHostPreparation {
  rejectForbiddenProposalInput(input);
  const units = input.sourceScope === "complete-source"
    ? indexSourceSemanticUnits(input.sourceCorpus) : selectSourceSemanticUnits(input.sourceCorpus, input.assertionIds);
  if (input.sourceScope === "complete-source" && (units.length !== input.assertionIds.length ||
    units.some((unit, index) => unit.assertion_id !== input.assertionIds[index]))) {
    throw new AlayaError("CONFLICT", "complete source scope requires every source unit in original order");
  }
  const producer = producerCapability(input.producer_id, input.producer_version);
  const limits = resourceLimits(input.resource_limits);
  const sourceDigest = semanticSha256(input.sourceCorpus);
  SourceSemanticRequestEnvelopeSchema.parse({ schema_version: SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
    interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT, source_request: null,
    source_digest: sourceDigest, ...(input.profile === undefined ? {} : { profile: input.profile }) });
  if (input.revision !== undefined) SourceSemanticRevisionSchema.parse(input.revision);
  const capacity = sourceReferenceCapacityReason(units);
  if (capacity !== null) {
    if (input.sourceScope !== "complete-source") throw new SourceReferenceCapacityExceeded(capacity);
    if (input.revision !== undefined) throw new AlayaError("CONFLICT", "unsupported source has no legal revision request");
    return SourceSemanticUnsupportedSourceSchema.parse({ status: "unsupported_source", source_digest: sourceDigest,
      source_scope: "complete-source", source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT,
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
      k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
      proposal_contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
      generation_schema_contract: SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT,
      assertion_count: units.length, reason: capacity });
  }
  const source_request = SourceSemanticOpenRequestBodySchema.parse({
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    proposal_contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
    source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT,
    ...(input.sourceScope !== undefined ? { source_scope: input.sourceScope } : {}),
    generation_schema_contract: SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT,
    producer_capability: producer,
    resource_limits: limits,
    attribution_context: bindUtteranceAttribution(input.attribution_context ?? UNKNOWN_UTTERANCE_ATTRIBUTION, input.sourceCorpus),
    assertion_locations: units.map((row) => ({
      assertion_id: row.assertion_id, source_utf8_span: [Buffer.byteLength(input.sourceCorpus.slice(0, row.start)), Buffer.byteLength(input.sourceCorpus.slice(0, row.end))]
    })),
    source_assertions: units.map(({ assertion_id, text, source_role }) => ({ assertion_id, text, source_role }))
  });
  const request = parseSourceSemanticRequest({
    schema_version: SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
    interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
    source_request,
    source_digest: sourceDigest,
    ...(input.profile !== undefined ? { profile: input.profile } : {})
  });
  return { status: "ready", request: input.revision === undefined ? request : parseSourceSemanticRequest({ ...request,
    source_request: { ...request.source_request, revision: input.revision } }) };
}

export function buildSourceSemanticRequest(input: SourceSemanticProposalInput): SourceSemanticRequest {
  const prepared = prepareSourceSemanticRequest(input);
  if (prepared.status === "unsupported_source") throw new SourceReferenceCapacityExceeded(prepared.reason);
  return prepared.request;
}

function originalQueryDigest(original_query: string): string {
  if (typeof original_query !== "string" || original_query.trim().length === 0) {
    throw new AlayaError("VALIDATION", "query proposal requires the original query");
  }
  if (original_query.length > 8192) throw new AlayaError("VALIDATION", "original query exceeds its bound");
  return `sha256:${semanticSha256(original_query)}`;
}

export function buildSourceSemanticQueryRequest(input: SourceSemanticQueryProposalInput): SourceSemanticQueryRequest {
  rejectForbiddenProposalInput(input);
  const original_query = input.original_query;
  const original_query_digest = originalQueryDigest(original_query);
  return {
    contract: SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    original_query,
    original_query_digest,
    ...(input.approved_fixed_context !== undefined
      ? { approved_fixed_context: ApprovedContextSchema.parse(input.approved_fixed_context) } : {}),
    attribution_context: bindUtteranceAttribution(input.attribution_context ?? UNKNOWN_UTTERANCE_ATTRIBUTION, original_query),
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits)
  };
}

export function buildSourceSemanticCorrespondenceRequest(
  input: SourceSemanticCorrespondenceProposalInput
): SourceSemanticCorrespondenceRequest {
  rejectForbiddenProposalInput(input);
  const admitted_query_semantics = SourceSemanticQuerySchema.parse(input.admitted_query_semantics);
  if (admitted_query_semantics.original_query_digest !== originalQueryDigest(input.original_query)) {
    throw new AlayaError("VALIDATION", "semantic_correspondence request does not bind the original query");
  }
  const source_interpretation_descriptors = z.array(SourceInterpretationDescriptorSchema).min(1).max(64).parse(input.source_interpretation_descriptors);
  if (Buffer.byteLength(JSON.stringify(source_interpretation_descriptors)) > 1_000_000) throw new AlayaError("VALIDATION", "semantic_correspondence descriptors exceed input budget");
  return {
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    admitted_query_semantics,
    original_query: input.original_query,
    source_interpretation_descriptors,
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits),
    catalog: buildSourceSemanticCorrespondenceEndpointCatalog(admitted_query_semantics, source_interpretation_descriptors.map((row, index) => ({
        source_interpretation_handle: `source${index + 1}`, interpretation: row.interpretation
      })))
  };
}

/** Producer JSON Schema selected by the recorded request contract, without profile enums. */
export function sourceSemanticResponseJsonSchema(request?: SourceSemanticRequest): object {
  if (request !== undefined) parseSourceSemanticRequest(request);
  return retainedSourceSemanticResponseJsonSchema(request);
}

/** Reconstructs an original schema only for retained request identity verification. */
export function retainedSourceSemanticResponseJsonSchema(request?: SourceSemanticRequest): object {
  const contract = request?.source_request.proposal_contract;
  const generation = request?.source_request.generation_schema_contract;
  const schema = request !== undefined && contract === undefined ? SourceSemanticResponseEnvelopeSchema
    : contract === SOURCE_SEMANTIC_PROPOSAL_CONTRACT ? SourceSemanticProposalSchema
    : contract === SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT ? SourceSemanticContentProposalSchema
    : contract === SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT
      ? generation !== undefined ? SourceSemanticExpressionGenerationSchema : SourceSemanticExpressionProposalSchema
    : contract === SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT
      ? generation !== undefined ? SourceSemanticCompactGenerationSchema : SourceSemanticCompactProposalSchema
    : generation !== undefined || request === undefined
      ? SourceSemanticSelectionGenerationSchema : SourceSemanticSelectionProposalSchema;
  const output = schema === SourceSemanticExpressionProposalSchema || schema === SourceSemanticExpressionGenerationSchema
    || schema === SourceSemanticCompactProposalSchema || schema === SourceSemanticCompactGenerationSchema
    || schema === SourceSemanticSelectionProposalSchema || schema === SourceSemanticSelectionGenerationSchema;
  const reused = schema === SourceSemanticExpressionGenerationSchema || schema === SourceSemanticCompactGenerationSchema
    || schema === SourceSemanticSelectionGenerationSchema;
  return z.toJSONSchema(schema, {
    io: output ? "output" : "input",
    ...(reused ? { reused: "ref" as const } : {}),
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    }
  });
}

const QueryCorrespondenceGenerationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("interpreted"),
    gaps: z.array(SourceSemanticQueryGapSchema).max(256).readonly().optional()
  }).strict().readonly(),
  z.object({ status: z.literal("abstained") }).strict().readonly()
]);

const CorrespondenceGenerationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("interpreted") }).strict().readonly(),
  z.object({ status: z.literal("abstained") }).strict().readonly()
]);

function producerResponseJsonSchema(schema: z.ZodType, reused?: "ref"): object {
  return z.toJSONSchema(schema, {
    io: "output",
    ...(reused === undefined ? {} : { reused }),
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    }
  });
}

/** Generation envelope for query semantics. Syntax follows the request contract; never inferred from body fields. */
export function sourceSemanticQueryResponseJsonSchema(): object {
  return producerResponseJsonSchema(z.object({
    contract: z.literal(SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT),
    outcome: QueryCorrespondenceGenerationOutcomeSchema,
    query: SourceSemanticQueryMeaningBodySchema.optional()
  }).strict().readonly(), "ref");
}

/** Current catalog-selection generation envelope for semantic correspondence. */
export function sourceSemanticCorrespondenceResponseJsonSchema(): object {
  return producerResponseJsonSchema(z.object({
    contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT),
    outcome: CorrespondenceGenerationOutcomeSchema,
    semantic_correspondence: SourceSemanticCorrespondenceSelectionSchema.optional()
  }).strict().readonly());
}

const exampleGaps = [{ kind: "unresolved_referent", affected_ids: ["rItem"],
  support: [{ kind: "lexical", mentions: ["mItem"] }], description: "The thing shelved is not identified." },
  { kind: "uninterpreted_clause", affected_ids: ["mClause"],
    support: [{ kind: "lexical", mentions: ["mClause"] }], description: "This clause is left uninterpreted without inventing a frame." }];
const sourceSemanticResponseExample = {
  contract: SOURCE_SEMANTIC_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" },
  draft: {
    contract: "source-interpretation-v4",
    mentions: [
      { id: "mActor", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } },
      { id: "mShelved", assertion_id: 1, source_ref: { first: "a1s2", last: "a1s2" } },
      { id: "mItem", assertion_id: 1, source_ref: { first: "a1s4", last: "a1s4" } },
      { id: "mClause", assertion_id: 2, source_ref: { first: "a2s0", last: "a2s11" } }
    ],
    referents: [
      { id: "rActor", referent_kind: "grouped", mentions: ["mActor"] },
      { id: "rItem", referent_kind: "unresolved", mentions: ["mItem"] }
    ],
    frames: [{
      id: "fShelve", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [], predicate_support: { kind: "explicit", reading: "shelve", mentions: ["mShelved"] },
      slots: [
        { id: "agent", role_reading: "person doing the shelving", support: [{ kind: "lexical", mentions: ["mActor"] }] },
        { id: "theme", role_reading: "thing placed on a shelf", support: [{ kind: "lexical", mentions: ["mItem"] }] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node", id: "rActor" }, support: [] },
        { slot_id: "theme", target: { kind: "node", id: "rItem" }, support: [] }
      ]
    }],
    operators: [], gaps: exampleGaps
  }
};

// Retained graph proposals select these exact prompt bytes for cache replay.
const LEGACY_SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Propose one source-local semantic draft using source-interpretation-v4.",
  'Return strict JSON {"contract":"source-semantic-proposal-v1","outcome":OUTCOME,"draft":DRAFT_IF_INTERPRETED}. Interpreted OUTCOME is exactly {"status":"interpreted"}; draft.gaps is the sole gap list.',
  "Ask only for draft semantics: mention handles with catalog first/last selections, referents, frames with predicate and role readings, slot definitions versus bindings, operators, context owners, lexical/additional/dominating support, and explicit gaps.",
  "Do not emit host hashes, character or UTF-8 offsets, entry_roots, asserted_at_scope, persistent IDs, QueryProgram, seeds, scores, ranking, answers, or verdicts.",
  "A supplied profile is an optional adapter, not an admission prerequisite. Novel predicate and role readings are allowed.",
  "Select inclusive first/last segment IDs shown in source_catalog. Never copy quotation text, invent offsets, or cross assertion boundaries.",
  "Keep catalog segment IDs separate from graph handles: source_catalog segment IDs (for example a1s2) occur ONLY inside source_ref.first/last. Graph mention IDs (for example mShelved) are declared in draft.mentions[].id. Every predicate mentions/supporting_context, referent mentions, lexical/additional support.mentions (including role, binding and gap support) MUST refer to those declared graph mention IDs, never catalog segment IDs.",
  "Declare a mention for every source span used by predicates, roles, bindings and gaps. Mentions locate evidence; they are not argument nodes.",
  'For a binding target {"kind":"node","id":ID}, ID must name a declared draft.referents[].id, draft.frames[].id, or draft.operators[].id. A mention ID, catalog segment ID, frame-local slot ID, or undeclared handle is not a node target.',
  'For a source-supported entity or value, declare a referent (one mention is sufficient for referent_kind="grouped") and bind to that referent, not its mention. For an unresolved role target use {"kind":"unresolved"} without id, or omit its binding and retain a located gap; never fabricate a participant to complete a slot.',
  "A gap affected_ids entry may name a declared mention, referent, frame, or operator. For an uninterpreted clause with no frame, declare a mention for its source span and use that mention in affected_ids and lexical support. Never cite a hypothetical or omitted frame as if it were declared.",
  "Each binding slot_id must name a slot defined by that same frame. Dominating support via_id must name a declared referent, frame, or operator, not a mention. Check each reference against its required kind before returning the draft; prefixes alone do not declare a handle.",
  'An embedded occurrence uses context_owner={"kind":"embedding","parent_frame":PARENT_FRAME_ID}. Do not emit content_argument: the host derives the current occurrence ID. The parent binding identifies its content target; do not assert the embedded action independently.',
  "Cover every selected source assertion with interpreted meaning or an explicit located draft.gaps entry. Locate gap support through declared mentions for that assertion. Do not silently omit clauses that are difficult to interpret.",
  "Explicit predicate support needs valid mention handles; implicit support needs supporting context and a reading. Empty or omitted support is a gap, not implicit.",
  "Unresolved referents are local. Do not mint a global unknown. Record unsupported meaning as gaps.",
  'For source universals use operator="forall" with binder, domain, restriction (a governed occurrence or null), and content. Bind its body with {kind:"bound_variable",quantifier:OPERATOR_ID,binder:BINDER}. Nested universal binders are unsupported: retain a located gap instead of flattening them.',
  'Optional domains contain {id,context:OWNER_ID_OR_NULL,support,members:[{referent,evidence,restrictions:[{restriction,evidence}]}],exclusions:[{referent,evidence}],closure:{kind:"open"}|{kind:"closed",evidence}}. Membership/restriction/closure evidence must be occurrences in the declared context; null requires source assertions. Lists are bounded to64 members. A universal claim does not establish a complete census. Preserve promise/report/negative ownership.',
  'Optional measurements contain {id,subject,owner,population,metric,unit,context,value,support}. value is an exact decimal string (128 digits,64 fractional digits maximum), with source support. Distinct values for the same subject/population/metric/unit/context require an explicit context distinction. Do not turn subjective easiest/best wording into objective values or rankings.',
  "Outcome interpreted requires a draft; abstained, invalid, quarantine, truncated, and transport failures must not carry a draft.",
  "For interpreted output, emit gaps only in draft.gaps. Do not repeat gaps in outcome; the host derives the canonical envelope from the draft.",
  "Do not infer world truth or confidence. Admission of a draft does not certify language fidelity.",
  "Neutral partial example, not the current input: assertion 1 is Mira shelved something. Its catalog segments are a1s0=Mira, a1s1=space, a1s2=shelved, a1s3=space, a1s4=something, a1s5=period. Assertion 2 is The label is hard to interpret. Its segments are a2s0=The, a2s1=space, a2s2=label, a2s3=space, a2s4=is, a2s5=space, a2s6=hard, a2s7=space, a2s8=to, a2s9=space, a2s10=interpret, a2s11=period. This example deliberately leaves assertion 2 as a mention-located gap without a frame. Use the current request's catalog for your response.",
  `Example response:\n${JSON.stringify(sourceSemanticResponseExample)}`
].join("\n");

/** A retained request selects its producer syntax and prompt together. */
export function sourceSemanticSystemPrompt(request: SourceSemanticRequest): string {
  parseSourceSemanticRequest(request);
  return retainedSourceSemanticSystemPrompt(request);
}

/** Reconstructs original prompt bytes without granting generation eligibility. */
export function retainedSourceSemanticSystemPrompt(request: SourceSemanticRequest): string {
  if (request.source_request.proposal_contract === undefined) return CANONICAL_SOURCE_SEMANTIC_SYSTEM_PROMPT;
  if (request.source_request.proposal_contract === SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT) return SOURCE_SEMANTIC_SYSTEM_PROMPT;
  if (request.source_request.proposal_contract === SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT) return COMPACT_SOURCE_SEMANTIC_SYSTEM_PROMPT;
  if (request.source_request.proposal_contract === SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT) {
    return EXPRESSION_SOURCE_SEMANTIC_SYSTEM_PROMPT;
  }
  return request.source_request.proposal_contract === SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT
    ? CONTENT_SOURCE_SEMANTIC_SYSTEM_PROMPT : LEGACY_SOURCE_SEMANTIC_SYSTEM_PROMPT;
}

export const SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT = [
  `Propose query meaning for the original query only, using ${SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT}.`,
  "Describe meaning, not answers or execution. The host builds IDs, sorts, incidence and evidence branches; do not emit graphs, hashes, programs, execution statistics, ranking or verdicts. Omit optional statement/operator keys unless referenced elsewhere. Entity keys express identity; unknown answer values are free targets, not unresolved meaning.",
  "First preserve the qualified answer being asked for in each alternative's conditions. Conditions are a conjunction; content means an embedded event, never an unrelated condition or a modifier. Put dates, places and other ordinary qualifications in the arguments of the event they qualify. Keep participants, population, time and units on the answer even when inputs also carry them.",
  "For a requested calculation or other operation, also retain requested_operation:{reading,support:{kind:query_text,excerpt}} and independently useful evidence_inputs:[{conditions:[...]}]. Each input must independently contain the event, participant, time and other qualifications needed for that input; an event role reference in an input does not import an event declared in the answer. Reuse a declared event with {kind:occurrence,key} as a separate input condition when its full qualification is needed. Leave unknown input values free and give each free value exact original-query support on its target or role; retain referentially constrained participants as named targets or local references. The answer conditions still preserve the requested answer relation and its own qualifications. A source can state that answer directly without supplying the inputs. Input evidence and requested_operation never execute the operation or prove a complete answer. If no faithful answer relation is expressible, conditions:[] is allowed with the operation and inputs, but those inputs still do not complete the answer.",
  `A nesting path may contain at most ${SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH + 1} statement/operator nodes. Deeper meaning must remain a located gap; never silently truncate its scope.`,
  'Use statement:{predicate,arguments,content?} and operators with explicit operands. An argument target is free, named or a reference to a declared entity, statement or operator. Resolve a reference by its declaration, never by its local key. A role referencing an entity may inherit that entity’s unambiguous exact query support. Every role referencing a statement/operator occurrence, in an answer or an evidence input, needs its own exact original-query argument excerpt; the occurrence key or predicate supplies none. A role reference does not embed its target or change its truth obligation. Use content for embedded meaning and retain its participants. Reuse a keyed occurrence with {kind:"occurrence",key}. possible, not, reported and conditional preserve their scope; a promise, report or hypothetical does not assert its embedded event.',
  'Local keys are arbitrary identifiers, never text evidence or participant identity. Declare named/free entities inline or in the optional entities table, not both; reuse them with {kind:"reference",key}. A free target binds a value without an additional referent constraint from that declaration; use it for unknown answers, lawful existential witnesses and binders. An excerpt on a free target only supports its role; it does not bind a requested person. A named target preserves a referentially constrained expression in the original query, including a speaker, addressee, name or definite description; it does not claim that a global identity or source participant has been resolved. Give it one exact query excerpt. A local reference reuses the declaration and its constraints. Free targets can supply excerpt themselves or at their argument, including a free reported.reporter; a free evidence-input value needs the same support. Reporter targets must remain entities. If authorized query context leaves the intended referent genuinely unresolved, retain its named target and add an unresolved_referent gap located on that target, or abstain when no faithful usable query can be proposed. A referential expression does not require a gap merely because source correspondence is still unknown. Never use free to erase that constraint, infer identity from a key, or invent source content.',
  "required_evidence_act:{act,excerpt} constrains the speech act of sought evidence. Omit it for ordinary factual questions; select act question/directive only when the original query explicitly seeks that source act, with an exact excerpt supporting the constraint. A source act belongs to an independently sought source root, not its embedded content. Factual questions seek source assertions or entailments, not unconditional world truth. Mark each requested entity, statement or operator with return:true on its declaration; the host derives the return list and IDs. Do not mark containing events or operation inputs as returns. A question word can locate a free answer target; it does not make other constrained participants free.",
  'Optional domains are {key,excerpt}. Universal evaluation is {kind:"forall",domain,binder,local_variables}; binders occur in the body and cannot be returned. entailed_at_source requests inference; asserted_at_source requests a literal assertion. Counterexample alternatives use purpose:"counterexample".',
  "Preserve universal population restrictions as domains and evaluation, not named entities or an invented census. Unknown domain members do not make the query referent unresolved. Nested universals remain unsupported. Preserve tense and temporal relation to the approved interpretation clock, completion/aspect, modality, units and other restrictions in meaningful predicates/roles or a located gap. A bare event lemma, supported participant, arbitrary key or asserted_at_source obligation does not imply that an event happened before the question clock. Do not invent an event date, and do not add a past restriction to a question that has none. A located gap makes represented evidence useful but never a complete answer.",
  'Comparison evaluation is {kind:"comparison",domain,operation:"lt"|"le"|"eq"|"ge"|"gt"|"minimum"|"maximum",left,right?,strict,metric,unit,context,scope:"asserted"|"preserve"} with no nested meaning. Pairwise strict is true only for lt/gt; extrema omit right and explicitly choose strictness. Return only operand keys.',
  "Declare comparison operands as entities; the evaluation refers to their keys. Use only the original query and approved fixed context, never source interpretations or proposed correspondences.",
  'Retain residual meaning in query.gaps:[{kind,affected_ids,support:[{kind:"query_text",excerpt}],description?}]. Excerpts copy exact original text; affected_ids names declared targets or [] for unrepresented meaning. Omit outcome.gaps to let the host echo this single gap list. A gap preserves a limitation; it does not replace meaning that the chosen structure can express.',
  `Complete neutral examples, not the current input: ${JSON.stringify(sourceSemanticQueryExamples)}. Nested content is not independently asserted; domains are not closed censuses; retained inputs do not claim a computed answer.`
].join(" ");

export const SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT = [
  "The original_query is the evidence text. Every query_excerpt and query_support.excerpt must copy an exact substring from it, preserving its inflection and language; normalized query-semantics predicates are not evidence excerpts.",
  "Propose semantic_correspondence as source-semantic-correspondence-selection-v2 over the advertised catalog.",
  "Use contextual equivalence only. Semantic correspondence cannot rank or answer. Do not emit answers, ranking, seeds, programs, verdicts, or chosen results.",
  "Do not invent source-interpretation structure or rewrite query semantics. Do not copy host hashes or assemble internal query-semantics or source-interpretation endpoint objects.",
  "Select catalog handles qeN and seN. Bind one actual query semantics and the named source interpretation. Name the target interpretation with request-local handle source1, source2, ... in descriptor order.",
  // Set-valued answers need the predicate plus each returned-variable slot on the same frame; a predicate row alone compiles to none.
  "A set-valued query that returns more than one free variable, or that asks which X which Y, must emit a selection group for each matching asserted frame in the advertised catalog. Each group MUST contain the matching predicate AND a slot binding for every returned variable on that same source frame. A predicate-only group is incomplete and must not be handed in as a group. Do not collapse those frames onto the first hit. The host does not complete omitted selections.",
  "An endpoint pair must express the same contextual meaning, not merely related topics or similar entity types. A named query target keeps its actual meaning: do not map an unrelated product or topic to it. A free answer variable is not the requester or a named source participant merely because both denote people. If no supported pair exists, use abstained or an empty selections array; partial overlap must not invent missing equivalences.",
  'Optional domains map {query_domain,source_domain,query_support,source_semantic_support}. Explicit conditional membership assumptions are {query_variable,source_domain,restrictions:[],status:"member"|"excluded",query_support,description}; use only assumptions stated in the query/context, never infer identity from a matching surface name. Closed source domains cannot acquire novel assumed members.',
  "Domain identifiers are exact admitted_query_semantics.domains[].id and the selected source interpretation's domains[].id. A frame, entity, statement, endpoint handle or conceptual category is not a domain identifier. If the source interpretation has no declared domains, omit domains and membership_assumptions or return empty arrays. Ordinary free-answer questions do not require inventing finite-domain membership. The source must already supply any domain you reference.",
  "An interpreted semantic_correspondence has no gap channel: omit outcome.gaps or send []. Use abstained if no supported semantic_correspondence can be proposed."
].join(" ");
