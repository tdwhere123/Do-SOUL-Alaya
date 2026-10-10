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
  SourceSemanticQueryPresentationSchema, type SourceSemanticQueryPresentation, SourceSemanticCorrespondenceAssessmentSchema,
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
export const SOURCE_SEMANTIC_QUERY_NESTED_REQUEST_CONTRACT = "source-semantic-query-request-v10" as const;
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
  generation_presentation?: SourceSemanticQueryPresentation;
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
  contract: typeof SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT | typeof SOURCE_SEMANTIC_QUERY_NESTED_REQUEST_CONTRACT;
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
  const presentation = SourceSemanticQueryPresentationSchema.parse(
    input.generation_presentation === undefined ? "flat-carrier-v1" : input.generation_presentation);
  const base: SourceSemanticQueryRequest = {
    contract: presentation === "nested-meaning-v1" ? SOURCE_SEMANTIC_QUERY_NESTED_REQUEST_CONTRACT
      : SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT,
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

/** Captured requests select one decoder; output structure cannot change that selection. */
export function sourceSemanticQueryPresentation(request?: Pick<SourceSemanticQueryRequest, "contract">): SourceSemanticQueryPresentation {
  switch (request === undefined ? SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT : request.contract) {
    case SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT: return "flat-carrier-v1";
    case SOURCE_SEMANTIC_QUERY_NESTED_REQUEST_CONTRACT: return "nested-meaning-v1";
    default: throw new AlayaError("VALIDATION", "unsupported query request contract");
  }
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
