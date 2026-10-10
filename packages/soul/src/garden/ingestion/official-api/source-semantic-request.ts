import { createHash } from "node:crypto";
import { z } from "zod";
import { producerResponseJsonSchema } from "./source-semantic-response-schema.js";
import {
  sourceSemanticProducerEnvelopeJsonSchema, sourceSemanticProducerGenerationOutcomeSchema,
  AlayaError, BoundedIdSchema, SourceAssertionIdSchema, SourceSemanticAssertionLocationSchema, SourceSemanticInterpretationSchema, sourceSemanticInterpretationIdentity,
  SourceSemanticQuerySchema, SourceSemanticRequestEnvelopeSchema,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
  sourceSemanticTableJsonSchema, sourceSemanticInlineJsonSchema,
  SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT,
  SourceSemanticGenerationSchemaContractSchema, sourceSemanticPresentationContracts,
  SourceSemanticGenerationTaskSchema, canonicalJson, type SourceSemanticGenerationTask,
  type SourceSemanticGenerationSchemaContract,
  SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION, SOURCE_SEMANTIC_K_VERSION,
  SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SourceSemanticQueryCarrierBodySchema, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH, SourceSemanticCorrespondenceAssessmentSchema,
  buildSourceReferenceCatalog, buildSourceSemanticCorrespondenceEndpointCatalog,
  buildSourceSemanticCorrespondenceEndpointEvidence, countSourceSemanticCorrespondenceJsonBytes,
  SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES,
  SourceSemanticCorrespondenceGenerationPolicySchema, sourceSemanticCorrespondenceDemand,
  type SourceSemanticCorrespondenceGenerationPolicy, type SourceSemanticCorrespondenceDemand,
  sourceReferenceCapacityReason, SourceReferenceCapacityExceeded, SourceReferenceCapacityReasonSchema,
  SOURCE_REFERENCE_MAX_ASSERTIONS,
  type SourceInterpretationProfile, type SourceReferenceCatalog, type SourceSemanticQuery,
  type SourceSemanticCorrespondenceEndpointCatalog, type SourceSemanticCorrespondenceEndpointEvidence,
  ApprovedSemanticContextSchema, UtteranceAttributionSchema, UNKNOWN_UTTERANCE_ATTRIBUTION,
  bindUtteranceAttribution, type UtteranceAttribution
} from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT, indexSourceSemanticUnits, selectSourceSemanticUnits } from "./source-semantic-units.js";
import { sourceSemanticQueryExamples, SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT } from "./source-semantic-query-examples.js";
export { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT } from "./source-semantic-query-examples.js";
import { sourceSemanticGenerationSystemPrompt } from "./source-semantic-inline-guidance.js";
import { SourceSemanticRevisionSchema, validateSourceSemanticRevision, type SourceSemanticRevision } from "./source-semantic-revision.js";
import { SourceSemanticProposalRevisionSchema, assertSourceSemanticProposalRevision, type SourceSemanticProposalRevision } from "./source-semantic-proposal-revision.js";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT,
  sourceSemanticCorrespondenceGenerationResponseJsonSchema
} from "./source-semantic-query-provenance.js";
import {
  sourceSemanticCorrespondenceFlatResponseJsonSchema, sourceSemanticCorrespondenceFlatSystemPrompt
} from "./source-semantic-correspondence-presentation.js";
export { SOURCE_SEMANTIC_CORRESPONDENCE_FLAT_RESPONSE_CONTRACT } from "./source-semantic-correspondence-presentation.js";
export { SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT } from "./source-semantic-query-provenance.js";
export { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-table-guidance.js";
export { sourceSemanticGenerationSystemPrompt } from "./source-semantic-inline-guidance.js";

export const SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT = "source-semantic-query-request-v9" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT = "source-semantic-correspondence-request-v7" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT = "source-semantic-correspondence-request-v8" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT = "source-semantic-correspondence-request-v9" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT = "source-semantic-correspondence-response-v4" as const;
export const SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT = "source-semantic-generation-view-v1" as const;
export type SourceSemanticGenerationViewContract = typeof SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT;
export const SourceSemanticGenerationViewContractSchema = z.literal(SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT);

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

function validatePresentation(request: { proposal_contract: string; generation_schema_contract: SourceSemanticGenerationSchemaContract },
  context: z.RefinementCtx): void {
  if (request.proposal_contract !== sourceSemanticPresentationContracts(request.generation_schema_contract).proposal_contract) {
    context.addIssue({ code: "custom", message: "source proposal and generation schema contracts differ" });
  }
}

const SourceSemanticOpenRequestBodySchema = z.object({
  k_version: z.literal(SOURCE_SEMANTIC_K_VERSION),
  normalizer_version: z.literal(SOURCE_SEMANTIC_NORMALIZER_VERSION),
  proposal_contract: z.enum([SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT]),
  source_unit_contract: z.literal(SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT),
  source_scope: z.literal("complete-source").optional(),
  generation_schema_contract: SourceSemanticGenerationSchemaContractSchema,
  generation_view_contract: SourceSemanticGenerationViewContractSchema.optional(),
  generation_task: SourceSemanticGenerationTaskSchema.optional(),
  original_source: z.string().max(1_000_000).optional(),
  revision: SourceSemanticRevisionSchema.optional(),
  producer_capability: ProducerCapability,
  resource_limits: SourceSemanticResourceLimitsSchema,
  attribution_context: UtteranceAttributionSchema,
  assertion_locations: z.array(SourceSemanticAssertionLocationSchema).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly(),
  source_assertions: z.array(z.object({
    assertion_id: SourceAssertionIdSchema, text: z.string().trim().min(1), source_role: z.enum(["user", "assistant"])
  }).strict().readonly()).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly()
}).strict().superRefine((request, context) => {
  validatePresentation(request, context);
  if (request.source_scope === undefined && (request.source_assertions.length > 8 || request.assertion_locations.length > 8)) {
    context.addIssue({ code: "custom", message: "partial source requests permit at most eight source units" });
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
  source_digest: string;
}>;

export type SourceSemanticProposalInput = Readonly<{
  sourceCorpus: string;
  assertionIds: readonly number[];
  sourceScope?: SourceSemanticOpenRequestBody["source_scope"];
  generationViewContract?: SourceSemanticGenerationViewContract;
  generationTask?: SourceSemanticGenerationTask;
  generationSchemaContract?: SourceSemanticGenerationSchemaContract;
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
  proposal_contract: z.enum([SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT]),
  generation_schema_contract: SourceSemanticGenerationSchemaContractSchema,
  assertion_count: z.number().int().positive(),
  reason: SourceReferenceCapacityReasonSchema
}).strict().superRefine(validatePresentation).readonly();
export type SourceSemanticHostPreparation = Readonly<{ status: "ready"; request: SourceSemanticRequest }>
  | z.infer<typeof SourceSemanticUnsupportedSourceSchema>;

export type SourceSemanticQueryProposalInput = Readonly<{
  original_query: string;
  approved_fixed_context?: SourceSemanticApprovedContext;
  attribution_context?: UtteranceAttribution;
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
  revision?: SourceSemanticProposalRevision;
}>;

export type SourceSemanticCorrespondenceProposalInput = Readonly<{
  original_query: string;
  admitted_query_semantics: SourceSemanticQuery;
  source_interpretation_descriptors: readonly SourceInterpretationDescriptor[];
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
  revision?: SourceSemanticProposalRevision;
  generation_policy?: SourceSemanticCorrespondenceGenerationPolicy;
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
  revision?: SourceSemanticProposalRevision;
}>;

export type SourceSemanticCorrespondenceRequest = Readonly<{
  original_query: string;
  contract: typeof SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT
    | typeof SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT
    | typeof SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  admitted_query_semantics: SourceSemanticQuery;
  source_interpretation_descriptors: readonly SourceInterpretationDescriptor[];
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
  catalog: SourceSemanticCorrespondenceEndpointCatalog;
  endpoint_evidence: SourceSemanticCorrespondenceEndpointEvidence;
  revision?: SourceSemanticProposalRevision;
  generation_policy?: SourceSemanticCorrespondenceGenerationPolicy;
  demand?: SourceSemanticCorrespondenceDemand;
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

export function parseSourceSemanticRequest(value: unknown): SourceSemanticRequest {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "source semantic request exceeds its byte bound");
  }
  const parsed = SourceSemanticRequestEnvelopeSchema.parse(value);
  const source_request = SourceSemanticOpenRequestBodySchema.parse(parsed.source_request);
  if (new Set(source_request.source_assertions.map((row) => row.assertion_id)).size !== source_request.source_assertions.length) {
    throw new AlayaError("VALIDATION", "source semantic request has duplicate assertion identities");
  }
  const request = Object.freeze({ ...parsed, source_request }) as SourceSemanticRequest;
  assertSourceSemanticTaskContext(request);
  requestCatalogs.set(request, sourceSemanticRequestCatalog(request));
  if (source_request.revision !== undefined) validateSourceSemanticRevision(request, source_request.revision);
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "source semantic request exceeds its byte bound");
  }
  return request;
}

/** Catalog identity and segmentation remain owned by the shared source-reference builder. */
export function sourceSemanticRequestCatalog(request: SourceSemanticRequest): SourceReferenceCatalog {
  const retained = requestCatalogs.get(request);
  if (retained !== undefined) return retained;
  return buildSourceReferenceCatalog(request.source_digest, request.source_request.source_assertions, semanticSha256);
}

function assertionLocations(sourceCorpus: string, units: ReturnType<typeof indexSourceSemanticUnits>) {
  return units.map(row => ({ assertion_id: row.assertion_id,
    source_utf8_span: [Buffer.byteLength(sourceCorpus.slice(0, row.start)), Buffer.byteLength(sourceCorpus.slice(0, row.end))] }));
}

/** Complete original text and catalog units have one source owner; task scope does not select input. */
function assertSourceSemanticTaskContext(request: SourceSemanticRequest): void {
  const body = request.source_request;
  if ((body.generation_task === undefined) !== (body.original_source === undefined)) {
    throw new AlayaError("VALIDATION", "source generation task and original source must appear together");
  }
  if (body.generation_task === undefined || body.original_source === undefined) return;
  if (body.source_scope !== "complete-source" || semanticSha256(body.original_source) !== request.source_digest) {
    throw new AlayaError("CONFLICT", "source generation task requires its exact complete original source");
  }
  const units = indexSourceSemanticUnits(body.original_source);
  if (canonicalJson(units.map(({ assertion_id, text, source_role }) => ({ assertion_id, text, source_role }))) !==
      canonicalJson(body.source_assertions) || canonicalJson(assertionLocations(body.original_source, units)) !==
      canonicalJson(body.assertion_locations)) {
    throw new AlayaError("CONFLICT", "source generation task original text differs from its source units or locations");
  }
  bindUtteranceAttribution(body.attribution_context, body.original_source);
}

export function prepareSourceSemanticRequest(input: SourceSemanticProposalInput): SourceSemanticHostPreparation {
  rejectForbiddenProposalInput(input);
  const units = input.sourceScope === "complete-source"
    ? indexSourceSemanticUnits(input.sourceCorpus) : selectSourceSemanticUnits(input.sourceCorpus, input.assertionIds);
  if (input.generationTask !== undefined && input.sourceScope !== "complete-source") {
    throw new AlayaError("VALIDATION", "source generation task requires complete-source input");
  }
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
  if (input.generationViewContract !== undefined) SourceSemanticGenerationViewContractSchema.parse(input.generationViewContract);
  if (input.generationTask !== undefined) SourceSemanticGenerationTaskSchema.parse(input.generationTask);
  const presentation = sourceSemanticPresentationContracts(input.generationSchemaContract);
  const capacity = sourceReferenceCapacityReason(units);
  if (capacity !== null) {
    if (input.sourceScope !== "complete-source") throw new SourceReferenceCapacityExceeded(capacity);
    if (input.revision !== undefined) throw new AlayaError("CONFLICT", "unsupported source has no legal revision request");
    return SourceSemanticUnsupportedSourceSchema.parse({ status: "unsupported_source", source_digest: sourceDigest,
      source_scope: "complete-source", source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT,
      interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
      k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
      proposal_contract: presentation.proposal_contract,
      generation_schema_contract: presentation.generation_schema_contract,
      assertion_count: units.length, reason: capacity });
  }
  const source_request = SourceSemanticOpenRequestBodySchema.parse({
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    proposal_contract: presentation.proposal_contract,
    source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT,
    ...(input.sourceScope !== undefined ? { source_scope: input.sourceScope } : {}),
    generation_schema_contract: presentation.generation_schema_contract,
    ...(input.generationViewContract === undefined ? {} : { generation_view_contract: input.generationViewContract }),
    ...(input.generationTask === undefined ? {} : { generation_task: input.generationTask, original_source: input.sourceCorpus }),
    producer_capability: producer,
    resource_limits: limits,
    attribution_context: bindUtteranceAttribution(input.attribution_context ?? UNKNOWN_UTTERANCE_ATTRIBUTION, input.sourceCorpus),
    assertion_locations: assertionLocations(input.sourceCorpus, units),
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
  const base: SourceSemanticQueryRequest = {
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
  const request = input.revision === undefined ? base : {
    ...base, revision: assertSourceSemanticProposalRevision("query", base, input.revision)
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "query proposal request exceeds its byte bound");
  }
  return request;
}

export function buildSourceSemanticCorrespondenceRequest(
  input: SourceSemanticCorrespondenceProposalInput
): SourceSemanticCorrespondenceRequest {
  return captureSourceSemanticCorrespondenceRequest(input, SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT);
}

function captureSourceSemanticCorrespondenceRequest(
  input: SourceSemanticCorrespondenceProposalInput,
  scopedContract: typeof SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT
    | typeof SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT
): SourceSemanticCorrespondenceRequest {
  rejectForbiddenProposalInput(input);
  const admitted_query_semantics = SourceSemanticQuerySchema.parse(input.admitted_query_semantics);
  if (admitted_query_semantics.original_query_digest !== originalQueryDigest(input.original_query)) {
    throw new AlayaError("VALIDATION", "semantic_correspondence request does not bind the original query");
  }
  const parsedPolicy = input.generation_policy === undefined
    ? undefined
    : SourceSemanticCorrespondenceGenerationPolicySchema.parse(input.generation_policy);
  const scoped = parsedPolicy?.kind === "branch_demand";
  const source_interpretation_descriptors = z.array(SourceInterpretationDescriptorSchema).min(1)
    .max(scoped && scopedContract === SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT ? 1 : 64)
    .parse(input.source_interpretation_descriptors);
  countSourceSemanticCorrespondenceJsonBytes(source_interpretation_descriptors,
    SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES, "semantic_correspondence descriptors exceed input budget");
  const descriptors = source_interpretation_descriptors.map((row, index) => ({
    source_interpretation_handle: `source${index + 1}`, interpretation: row.interpretation
  }));
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(admitted_query_semantics, descriptors);
  const demand = scoped
    ? sourceSemanticCorrespondenceDemand(admitted_query_semantics, catalog, parsedPolicy)
    : undefined;
  const requestBase = {
    contract: scoped
      ? scopedContract
      : SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    admitted_query_semantics,
    original_query: input.original_query,
    source_interpretation_descriptors,
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits),
    catalog,
    ...(scoped ? { generation_policy: parsedPolicy, demand } : {})
  };
  const baseBytes = countSourceSemanticCorrespondenceJsonBytes({ ...requestBase, endpoint_evidence: null },
    SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES) - 4;
  const base: SourceSemanticCorrespondenceRequest = { ...requestBase,
    endpoint_evidence: buildSourceSemanticCorrespondenceEndpointEvidence(admitted_query_semantics, descriptors, catalog,
      SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES - baseBytes)
  };
  const request = input.revision === undefined ? base : {
    ...base, revision: assertSourceSemanticProposalRevision("semantic_correspondence", base, input.revision)
  };
  if (Buffer.byteLength(JSON.stringify(request)) > SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES) {
    throw new AlayaError("VALIDATION", "semantic_correspondence request exceeds input budget");
  }
  return request;
}

/** Rebuild captured routing fields from their owners, including historical v8 descriptor cardinality. */
export function parseSourceSemanticCorrespondenceRequest(value: unknown): SourceSemanticCorrespondenceRequest {
  countSourceSemanticCorrespondenceJsonBytes(value, SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES);
  const captured = z.object({
    contract: z.enum([SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT,
      SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT]),
    k_version: z.literal(SOURCE_SEMANTIC_K_VERSION), original_query: z.string(),
    admitted_query_semantics: SourceSemanticQuerySchema,
    source_interpretation_descriptors: z.array(SourceInterpretationDescriptorSchema).min(1).max(64),
    producer_capability: ProducerCapability, resource_limits: SourceSemanticResourceLimitsSchema,
    catalog: z.unknown(), endpoint_evidence: z.unknown(), revision: SourceSemanticProposalRevisionSchema.optional(),
    generation_policy: SourceSemanticCorrespondenceGenerationPolicySchema.optional(), demand: z.unknown().optional()
  }).strict().parse(value);
  const rebuilt = captureSourceSemanticCorrespondenceRequest({
    ...captured, producer_id: captured.producer_capability.producer_id,
    producer_version: captured.producer_capability.producer_version
  }, captured.contract === SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT
    ? SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT : SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT);
  if (canonicalJson(rebuilt) !== canonicalJson(captured)) {
    throw new AlayaError("CONFLICT", "captured correspondence request differs from its query, descriptor or demand owner");
  }
  return rebuilt;
}

/** Current table generation schema, without profile enums. */
export function sourceSemanticResponseJsonSchema(request?: SourceSemanticRequest): object {
  const selected = request === undefined ? undefined : parseSourceSemanticRequest(request).source_request.generation_schema_contract;
  return selected === SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT ? sourceSemanticInlineJsonSchema() : sourceSemanticTableJsonSchema();
}


function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function derefJsonSchema(root: Record<string, unknown>, node: Record<string, unknown>): Record<string, unknown> {
  if (typeof node.$ref !== "string") return node;
  const pointer = node.$ref;
  if (!pointer.startsWith("#/")) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
  let current: unknown = root;
  for (const part of pointer.slice(2).split("/")) {
    current = isJsonSchemaObject(current) ? current[part.replace(/~1/gu, "/").replace(/~0/gu, "~")] : undefined;
    if (!isJsonSchemaObject(current)) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
  }
  if (!isJsonSchemaObject(current)) throw new AlayaError("VALIDATION", `unresolved generation schema pointer ${pointer}`);
  return derefJsonSchema(root, current);
}

function queryReferenceSchema(schema: Record<string, unknown>, target: Record<string, unknown>): object {
  const resolved = derefJsonSchema(schema, target);
  const variants = Array.isArray(resolved.oneOf) ? resolved.oneOf : Array.isArray(resolved.anyOf) ? resolved.anyOf : [];
  for (const variant of variants) {
    if (!isJsonSchemaObject(variant)) continue;
    const shape = derefJsonSchema(schema, variant);
    const properties = isJsonSchemaObject(shape.properties) ? shape.properties : undefined;
    const kind = isJsonSchemaObject(properties?.kind) ? derefJsonSchema(schema, properties.kind) : undefined;
    if (Array.isArray(kind?.enum) && kind.enum.length === 1 && kind.enum[0] === "reference") return structuredClone(shape);
  }
  throw new AlayaError("VALIDATION", "query target schema is missing a local reference variant");
}

/** Use one producer declaration location; historical receive syntax remains unchanged. */
function constrainQueryGenerationNodes(schema: Record<string, unknown>, body: Record<string, unknown>): void {
  const properties = isJsonSchemaObject(body.properties) ? body.properties : undefined;
  const nodes = isJsonSchemaObject(properties?.nodes) ? properties.nodes : undefined;
  if (!isJsonSchemaObject(nodes?.items)) throw new AlayaError("VALIDATION", "query carrier schema is missing nodes.items");
  const node = derefJsonSchema(schema, nodes.items);
  const variants = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : [];
  let found = false;
  for (const variant of variants) {
    if (!isJsonSchemaObject(variant)) continue;
    const shape = derefJsonSchema(schema, variant);
    const fields = isJsonSchemaObject(shape.properties) ? shape.properties : undefined;
    if (isJsonSchemaObject(fields?.reporter)) fields.reporter = queryReferenceSchema(schema, fields.reporter);
    if (!isJsonSchemaObject(fields?.arguments)) continue;
    if (!isJsonSchemaObject(fields.arguments.items)) throw new AlayaError("VALIDATION", "query role schema is missing items");
    const argument = derefJsonSchema(schema, fields.arguments.items);
    if (!isJsonSchemaObject(argument.properties) || !isJsonSchemaObject(argument.properties.excerpt)
      || !isJsonSchemaObject(argument.properties.target)) {
      throw new AlayaError("VALIDATION", "query role schema is missing excerpt or target");
    }
    argument.properties.target = queryReferenceSchema(schema, argument.properties.target);
    argument.required = [...new Set([...(Array.isArray(argument.required) ? argument.required : []), "excerpt"])];
    found = true;
  }
  if (!found) throw new AlayaError("VALIDATION", "query carrier schema is missing statement arguments");
}

/** Derive producer constraints from the carrier body owner; do not copy its grammar. */
function constrainQueryGenerationSchema(envelope: object): object {
  const schema = structuredClone(envelope) as Record<string, unknown>;
  const properties = isJsonSchemaObject(schema.properties) ? schema.properties : undefined;
  if (!isJsonSchemaObject(properties?.query)) {
    throw new AlayaError("VALIDATION", "query generation schema is missing properties.query");
  }
  const body = structuredClone(derefJsonSchema(schema, properties.query));
  constrainQueryGenerationNodes(schema, body);
  const bodyProperties = isJsonSchemaObject(body.properties) ? body.properties : undefined;
  if (body.anyOf !== undefined || body.oneOf !== undefined || bodyProperties?.requested_operation === undefined
    || !isJsonSchemaObject(bodyProperties.entities) || !isJsonSchemaObject(bodyProperties.alternatives)
    || bodyProperties.alternatives.items === undefined) {
    throw new AlayaError("VALIDATION", "query carrier body cannot encode the operation/input generation union");
  }
  if (!isJsonSchemaObject(bodyProperties.entities.items)) throw new AlayaError("VALIDATION", "query entity schema is missing items");
  const entity = derefJsonSchema(schema, bodyProperties.entities.items);
  const declarations = Array.isArray(entity.oneOf) ? entity.oneOf : Array.isArray(entity.anyOf) ? entity.anyOf : [];
  if (declarations.length === 0) throw new AlayaError("VALIDATION", "query entity schema is missing declaration variants");
  for (const declaration of declarations) {
    if (!isJsonSchemaObject(declaration)) throw new AlayaError("VALIDATION", "invalid query entity declaration schema");
    const shape = derefJsonSchema(schema, declaration);
    if (!isJsonSchemaObject(shape.properties) || !isJsonSchemaObject(shape.properties.excerpt)) {
      throw new AlayaError("VALIDATION", "query entity declaration schema is missing excerpt");
    }
    shape.required = [...new Set([...(Array.isArray(shape.required) ? shape.required : []), "excerpt"])];
  }
  body.required = [...new Set([...(Array.isArray(body.required) ? body.required : []), "entities"])];
  const { contract, entities, nodes, ...remaining } = bodyProperties;
  body.properties = { contract, entities, nodes, ...remaining };
  const itemNode = isJsonSchemaObject(bodyProperties.alternatives.items)
    ? bodyProperties.alternatives.items : { $ref: bodyProperties.alternatives.items };
  const items = structuredClone(derefJsonSchema(schema, itemNode));
  if (!isJsonSchemaObject(items.properties) || items.properties.evidence_inputs === undefined) {
    throw new AlayaError("VALIDATION", "query alternative schema is missing evidence_inputs");
  }
  const withOperation = structuredClone(body);
  const required = Array.isArray(withOperation.required) ? [...withOperation.required as string[]] : [];
  if (!required.includes("requested_operation")) required.push("requested_operation");
  withOperation.required = required;
  const withoutInputs = structuredClone(body);
  const residualItems = structuredClone(items);
  delete (residualItems.properties as Record<string, unknown>).evidence_inputs;
  if (Array.isArray(residualItems.required)) {
    residualItems.required = (residualItems.required as string[]).filter((key) => key !== "evidence_inputs");
  }
  (withoutInputs.properties as Record<string, unknown>).alternatives = {
    ...structuredClone(bodyProperties.alternatives), items: residualItems
  };
  const defsKey = schema.$defs !== undefined ? "$defs" : schema.definitions !== undefined ? "definitions" : "$defs";
  const defs = isJsonSchemaObject(schema[defsKey]) ? schema[defsKey] as Record<string, unknown> : {};
  for (const name of ["queryRequiresRequestedOperation", "queryOmitsEvidenceInputs"]) {
    if (defs[name] !== undefined) throw new AlayaError("VALIDATION", `generation schema already defines ${defsKey}.${name}`);
  }
  schema[defsKey] = {
    ...defs,
    queryRequiresRequestedOperation: withOperation,
    queryOmitsEvidenceInputs: withoutInputs
  };
  properties.query = {
    ...(properties.query.readOnly === undefined ? {} : { readOnly: properties.query.readOnly }),
    anyOf: [{ $ref: `#/${defsKey}/queryRequiresRequestedOperation` }, { $ref: `#/${defsKey}/queryOmitsEvidenceInputs` }]
  };
  return schema;
}

/** Generation envelope for query semantics. Syntax follows the request contract; never inferred from body fields. */
export function sourceSemanticQueryResponseJsonSchema(): object {
  return sourceSemanticProducerEnvelopeJsonSchema(constrainQueryGenerationSchema(producerResponseJsonSchema(z.object({
    contract: z.literal(SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT),
    outcome: sourceSemanticProducerGenerationOutcomeSchema("query"),
    query: SourceSemanticQueryCarrierBodySchema.optional()
  }).strict().readonly(), "ref")), "query");
}

/** Historical v4 assessment envelope; a request selects the request-aware generation envelope. */
export function sourceSemanticCorrespondenceResponseJsonSchema(
  request?: SourceSemanticCorrespondenceRequest
): object {
  if (request?.contract === SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT) {
    return sourceSemanticCorrespondenceFlatResponseJsonSchema(request);
  }
  if (request !== undefined) {
    return sourceSemanticCorrespondenceGenerationResponseJsonSchema({
      original_query: request.original_query,
      admitted_query_semantics: request.admitted_query_semantics,
      catalog: request.catalog,
      ...(request.demand === undefined ? {} : { demand: request.demand }),
      ...(request.contract === SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT
        ? { response_contract: SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_GENERATION_RESPONSE_CONTRACT } : {})
    });
  }
  return sourceSemanticProducerEnvelopeJsonSchema(producerResponseJsonSchema(z.object({
    contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT),
    outcome: sourceSemanticProducerGenerationOutcomeSchema("correspondence"),
    semantic_correspondence: SourceSemanticCorrespondenceAssessmentSchema.optional()
  }).strict().readonly()), "correspondence");
}

/** Current source-table prompt bytes are owned by the table guidance. */
export function sourceSemanticSystemPrompt(request: SourceSemanticRequest): string {
  const source = parseSourceSemanticRequest(request).source_request;
  return sourceSemanticGenerationSystemPrompt(source.generation_schema_contract, source.generation_task);
}

export const SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT = [
  `Propose query meaning for the original query only, using ${SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT}.`,
  "Decide meaning in this order, using only the original query and approved fixed context; the model chooses relations, referents, scope and qualifications. The host derives IDs, sorts, incidence and evidence branches, not omitted meaning.",
  '1. Identify the requested result and task. A property answer needs that property relation: a name is a value of has name, distinct from the named object. Days attended per week counts distinct days, not class sessions per week. For advice, recommendation, comparison or calculation retain requested_operation:{reading,support:{kind:"query_text",excerpt}}. Current advice seeks useful advice or candidates for its stated topic; a historical request event is sought only when the query explicitly asks about that past request. Polite can/could you wording normally requests the task. Preserve the actual target, population, distinctness and qualifications without inventing preferences or useful facts.',
  '2. Choose referents and returns. Declare every named/free entity once in entities, with an exact query excerpt; use [] when none exist. Unknown answers and lawful witnesses are free; speakers, addressees and definite participants are named even before source identity is known. A free excerpt grounds its role, not its value or class. Local keys are arbitrary identifiers, never text evidence or identity. Mark only requested entities, statements or operators return:true on their declarations; Boolean questions and operation inputs have no fabricated returns. Keep an unresolved named referent named and locate an unresolved_referent gap, or abstain if no usable faithful meaning remains. Unknown source correspondence alone requires no gap.',
  '3. Build the direct answer conditions as one conjunction of the requested relation and all its stated restrictions. Each answer branch must carry its own participants, class, time, modality, unit and population restrictions in predicates/roles or located gaps. Named descriptions retain their referent constraint; free values require connected class or property relations. Excerpts and requested_operation do not supply missing predicates. A qualified direct comparison can be asserted without either numeric operand fact: express which metric, owner and operands are compared in the answer relation itself, rather than requiring both values. If no faithful answer relation is expressible, retain conditions:[] with the operation and inputs.',
  '4. Add independently useful evidence_inputs:[{conditions:[...]}] for the requested operation. Qualify each input independently, including its event, participants, classification, time and units. Separate alternative input actions instead of joining all actions into the answer. Inputs do not execute the task or prove its result. A reference to an event shares identity but imports neither its occurrence nor its classifications. Reuse a keyed event with {kind:"occurrence",key} when its full condition is needed, and also include connected qualification conditions needed by this branch.',
  '5. Set scope and evidence act. Use statement:{predicate,arguments,content?} and explicit operators; content preserves what another event says, asks or requires, without separately asserting the embedded event. possible, not, reported and conditional retain their governing scope. Omit required_evidence_act for ordinary factual questions: the current question form does not request source question evidence. Use required_evidence_act:{act,excerpt} only when the query explicitly seeks a source question or directive, on that independently sought root. entailed_at_source requests inference; asserted_at_source requests a literal assertion. Marking an input event as returned or as a source question changes what evidence is sought.',
  '6. Retain qualifications and residuals. Encode tense relative to the approved interpretation clock, completion/aspect, modality and units in meaningful predicates/roles, or query.gaps:[{kind,affected_ids,support:[{kind:"query_text",excerpt}],description?}]. A bare event lemma does not encode past occurrence. Preserve only stated temporal restrictions; invent no dates. affected_ids names declared semantic entity, occurrence/frame or domain keys, or [] for unrepresented meaning; serialization tokens are not gap targets. Omit outcome.gaps so the host echoes this single list. A gap records missing or unsupported meaning, not a substitute for expressible meaning or a complete answer. Do not add a gap solely because a requested operation is unexecuted; the host derives execution status from requested_operation. Execution status neither supplies nor removes a faithful answer relation or its qualified inputs.',
  '7. Use existing evaluation forms when applicable. domains are {key,excerpt}; universal evaluation is {kind:"forall",domain,binder,local_variables}, with a body-bound binder that cannot be returned. Population restrictions are not named entities or invented censuses; unknown members do not imply an unresolved referent. Nested universals remain unsupported. Counterexample alternatives use purpose:"counterexample". Comparison evaluation is {kind:"comparison",domain,operation:"lt"|"le"|"eq"|"ge"|"gt"|"minimum"|"maximum",left,right?,strict,metric,unit,context,scope:"asserted"|"preserve"}; declare operands as entities and return only operand keys. Pairwise strict is true only for lt/gt; extrema omit right and choose strictness explicitly. Evaluation has no nested meaning.',
  `8. Serialize the chosen meaning. A nesting path has at most ${SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH + 1} statement/operator nodes; deeper meaning remains a located gap. Declare entities before nodes; all argument and reporter targets use {kind:"reference",key}, with reporters entity-only. Every role carries its own exact original-query excerpt, including event references and free input values. Serialize each expression occurrence once in nodes with a separate node token, then branch roots; conditions and operator content/antecedent/consequent/operands contain tokens, never embedded expressions. Tokens resolve once, with no cycles or unreachable nodes. Semantic event references do not make branch roots. Emit meaning, not answers, graphs, hashes, programs, execution statistics, ranking or verdicts.`,
  `Complete neutral examples, not the current input: ${JSON.stringify(sourceSemanticQueryExamples)}. Contrast current advice with a past advice request, object identity with its name, and days per week with session frequency. The bead comparison keeps a qualified direct answer separate from its operand inputs; the elapsed-hours inputs each reuse their own qualified event.`
].join(" ");

export const SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT = [
  "The original_query is the evidence text. Every supplied query_excerpt and query_support.excerpt must copy an exact substring from it, preserving its inflection and language; normalized role or predicate readings are not evidence excerpts.",
  "Propose semantic_correspondence as source-semantic-correspondence-assessment-v1 over the advertised catalog.",
  "Use contextual equivalence only. Semantic correspondence cannot rank or answer. Do not emit answers, ranking, seeds, programs, verdicts, or chosen results.",
  "Do not invent source-interpretation structure or rewrite query semantics. Do not copy host hashes or assemble internal query-semantics or source-interpretation endpoint objects.",
  "Name the target interpretation with request-local handle source1, source2, ... in descriptor order. Assess every advertised qeN exactly once for that interpretation, even when no equivalence is supported. Do not assess source endpoints as query endpoints.",
  "For each query endpoint, use status supported with a nonempty equivalents array containing every proposed contextual equivalent seN, or status unresolved with an explanation of the unestablished obligation. Never leave an endpoint out or put an unsupported pair in an unresolved record. Keep all supported many-to-many pairs; do not pick a preferred pair or enumerate every possible query/source pair. Only request-schema-eligible referent and slot handles may omit query_excerpt; predicate handles and source words still require an exact original-query excerpt. For eligible handles, omit query_excerpt when relying on stored host provenance.",
  "Each supported equivalent retains source_semantic_support and adds bounded grounding. Retain exact query_excerpt only when the handle is not eligible to omit it. For a reference, explain its full denotation using the admitted reference, source mention and use, and relevant scope or context evidence; matching a word or entity type alone is insufficient. For predicates and slots, explain the local relation. Grounding and unresolved explanations are inspectable proposals, not certificates and not answers. Omit optional applicable_context when no additional source-context qualification is proposed. If supplied, use the actual containing source frame or operator ID: the source occurrence itself or a governing ancestor via embedding or operator ownership. Do not use a query endpoint, catalog handle, label, status, or category word. Referent equivalents omit applicable_context.",
  "A set-valued query may have multiple asserted source frames. Preserve each supported predicate and returned-variable slot relation on its actual frame; do not collapse frames onto the first hit. If a slot is unsupported, assess it unresolved rather than fabricate a binding. Partial supported assessments remain available for native composition.",
  "An endpoint pair must express the same contextual meaning, not merely related topics or similar entity types. A named query target keeps its actual meaning. A free answer variable is not the requester or a named source participant merely because both denote people. If no supported pair exists, submit explicit unresolved assessments; abstain only if you cannot provide the assessment. Partial overlap must not invent missing equivalences.",
  'Optional domains map {query_domain,source_domain,query_support,source_semantic_support}. Explicit conditional membership assumptions are {query_variable,source_domain,restrictions:[],status:"member"|"excluded",query_support,description}; use only assumptions stated in the query/context, never infer identity from a matching surface name. Closed source domains cannot acquire novel assumed members.',
  "Domain identifiers are exact admitted_query_semantics.domains[].id and the selected source interpretation's domains[].id. A frame, entity, statement, endpoint handle or conceptual category is not a domain identifier. If the source interpretation has no declared domains, omit domains and membership_assumptions or return empty arrays. Ordinary free-answer questions do not require inventing finite-domain membership. The source must already supply any domain you reference.",
  "An interpreted semantic_correspondence has no gap channel: omit outcome.gaps or send []. Explicit unresolved endpoint assessments are not world-negation or canonical C gaps."
].join(" ");

const CORRESPONDENCE_FULL_ASSESS =
  "Assess every advertised qeN exactly once for that interpretation, even when no equivalence is supported. Do not assess source endpoints as query endpoints.";

export function sourceSemanticCorrespondenceSystemPrompt(
  request?: SourceSemanticCorrespondenceRequest
): string {
  if (request?.contract === SOURCE_SEMANTIC_CORRESPONDENCE_SCOPED_REQUEST_CONTRACT) {
    return sourceSemanticCorrespondenceFlatSystemPrompt(request, SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT);
  }
  if (request?.contract !== SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT
    || request.generation_policy?.kind !== "branch_demand"
    || request.demand === undefined) {
    return SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT;
  }
  const handles = request.demand.demanded_handles.join(", ");
  return SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT.replace(
    CORRESPONDENCE_FULL_ASSESS,
    `Assess every demanded query endpoint exactly once for that interpretation (${handles}), even when no equivalence is supported. Do not assess host-unassessed remainder; omitted remainder is unassessed, not unresolved. Do not assess source endpoints as query endpoints.`
  );
}
