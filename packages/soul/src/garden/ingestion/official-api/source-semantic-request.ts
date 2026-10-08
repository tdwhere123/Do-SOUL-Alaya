import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AlayaError, BoundedIdSchema, SourceAssertionIdSchema, SourceSemanticAssertionLocationSchema, SourceSemanticInterpretationSchema, sourceSemanticInterpretationIdentity,
  SourceSemanticQuerySchema, SourceSemanticRequestEnvelopeSchema,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT,
  sourceSemanticTableJsonSchema,
  SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION, SOURCE_SEMANTIC_K_VERSION,
  SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SourceSemanticQueryCarrierBodySchema, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH, SourceSemanticCorrespondenceAssessmentSchema,
  buildSourceReferenceCatalog, buildSourceSemanticCorrespondenceEndpointCatalog,
  buildSourceSemanticCorrespondenceEndpointEvidence, countSourceSemanticCorrespondenceJsonBytes,
  SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES,
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
import { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-table-guidance.js";
import { SourceSemanticRevisionSchema, validateSourceSemanticRevision, type SourceSemanticRevision } from "./source-semantic-revision.js";
import { assertSourceSemanticProposalRevision, type SourceSemanticProposalRevision } from "./source-semantic-proposal-revision.js";
import { sourceSemanticCorrespondenceGenerationResponseJsonSchema } from "./source-semantic-query-provenance.js";
export { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "./source-semantic-table-guidance.js";

export const SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT = "source-semantic-query-request-v9" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT = "source-semantic-correspondence-request-v7" as const;
export const SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT = "source-semantic-correspondence-response-v4" as const;

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
  normalizer_version: z.literal(SOURCE_SEMANTIC_NORMALIZER_VERSION),
  proposal_contract: z.literal(SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT),
  source_unit_contract: z.literal(SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT),
  source_scope: z.literal("complete-source").optional(),
  generation_schema_contract: z.literal(SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT),
  revision: SourceSemanticRevisionSchema.optional(),
  producer_capability: ProducerCapability,
  resource_limits: SourceSemanticResourceLimitsSchema,
  attribution_context: UtteranceAttributionSchema,
  assertion_locations: z.array(SourceSemanticAssertionLocationSchema).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly(),
  source_assertions: z.array(z.object({
    assertion_id: SourceAssertionIdSchema, text: z.string().trim().min(1), source_role: z.enum(["user", "assistant"])
  }).strict().readonly()).max(SOURCE_REFERENCE_MAX_ASSERTIONS).readonly()
}).strict().superRefine((request, context) => {
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
  proposal_contract: z.literal(SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT),
  generation_schema_contract: z.literal(SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT),
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
  contract: typeof SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  admitted_query_semantics: SourceSemanticQuery;
  source_interpretation_descriptors: readonly SourceInterpretationDescriptor[];
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
  catalog: SourceSemanticCorrespondenceEndpointCatalog;
  endpoint_evidence: SourceSemanticCorrespondenceEndpointEvidence;
  revision?: SourceSemanticProposalRevision;
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
      proposal_contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
      generation_schema_contract: SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT,
      assertion_count: units.length, reason: capacity });
  }
  const source_request = SourceSemanticOpenRequestBodySchema.parse({
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    proposal_contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
    source_unit_contract: SOURCE_SEMANTIC_SOURCE_UNIT_CONTRACT,
    ...(input.sourceScope !== undefined ? { source_scope: input.sourceScope } : {}),
    generation_schema_contract: SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT,
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
  rejectForbiddenProposalInput(input);
  const admitted_query_semantics = SourceSemanticQuerySchema.parse(input.admitted_query_semantics);
  if (admitted_query_semantics.original_query_digest !== originalQueryDigest(input.original_query)) {
    throw new AlayaError("VALIDATION", "semantic_correspondence request does not bind the original query");
  }
  const source_interpretation_descriptors = z.array(SourceInterpretationDescriptorSchema).min(1).max(64).parse(input.source_interpretation_descriptors);
  countSourceSemanticCorrespondenceJsonBytes(source_interpretation_descriptors,
    SOURCE_SEMANTIC_CORRESPONDENCE_REQUEST_MAX_BYTES, "semantic_correspondence descriptors exceed input budget");
  const descriptors = source_interpretation_descriptors.map((row, index) => ({
    source_interpretation_handle: `source${index + 1}`, interpretation: row.interpretation
  }));
  const catalog = buildSourceSemanticCorrespondenceEndpointCatalog(admitted_query_semantics, descriptors);
  const requestBase = {
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    admitted_query_semantics,
    original_query: input.original_query,
    source_interpretation_descriptors,
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits),
    catalog
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

/** Current table generation schema, without profile enums. */
export function sourceSemanticResponseJsonSchema(request?: SourceSemanticRequest): object {
  if (request !== undefined) parseSourceSemanticRequest(request);
  return sourceSemanticTableJsonSchema();
}

const QueryCorrespondenceGenerationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("interpreted") }).strict().readonly(),
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
  return constrainQueryGenerationSchema(producerResponseJsonSchema(z.object({
    contract: z.literal(SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT),
    outcome: QueryCorrespondenceGenerationOutcomeSchema,
    query: SourceSemanticQueryCarrierBodySchema.optional()
  }).strict().readonly(), "ref"));
}

/** Historical v4 assessment envelope; a request selects the request-aware generation envelope. */
export function sourceSemanticCorrespondenceResponseJsonSchema(
  request?: SourceSemanticCorrespondenceRequest
): object {
  if (request !== undefined) return sourceSemanticCorrespondenceGenerationResponseJsonSchema(request);
  return producerResponseJsonSchema(z.object({
    contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT),
    outcome: CorrespondenceGenerationOutcomeSchema,
    semantic_correspondence: SourceSemanticCorrespondenceAssessmentSchema.optional()
  }).strict().readonly());
}

/** Current source-table prompt bytes are owned by the table guidance. */
export function sourceSemanticSystemPrompt(request: SourceSemanticRequest): string {
  parseSourceSemanticRequest(request);
  return SOURCE_SEMANTIC_SYSTEM_PROMPT;
}

export const SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT = [
  `Propose query meaning for the original query only, using ${SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT}.`,
  "Describe meaning, not answers or execution. The host builds IDs, sorts, incidence and evidence branches; do not emit graphs, hashes, programs, execution statistics, ranking or verdicts. Omit optional statement/operator keys unless referenced elsewhere. Entity keys express identity; unknown answer values are free targets, not unresolved meaning.",
  "Choose the semantic relation before its serialization. An attribute question needs the specific property relation, not generic possession whose only property label is a local key or excerpt. Preserve the requested property in a meaningful predicate or role. For a request to recommend, compare or calculate, preserve the requested operation and its actual target; polite can/could you wording normally asks for that task, not source evidence of the addressee's ability or a past request event. Do not invent preferences or helpful facts absent from the query. Represent each definite event once: all uses and qualifications of that event must share its declared target, rather than separating a named event from an unconnected event description. A nominal event can be a named target with its type, time and participants expressed by ordinary connected relations.",
  "After entity declarations, serialize each expression occurrence once in query.nodes with its own node token. Then write the branch roots that use these nodes. alternatives.conditions and evidence_inputs[].conditions are arrays of node tokens. A statement/operator content, antecedent, consequent or operands field contains node tokens, never an embedded expression. Tokens are serialization references, separate from semantic local keys. Every token must resolve once; emit only nodes reachable from a branch root, with no unused declarations or cycles. Semantic target references do not make an expression a branch root. An occurrence node uses its semantic key to refer to a declared event and still has its own serialization token.",
  "Decide the answer branch before adding inputs. Put the requested relation, its participants and every stated qualification in conditions; conditions are one conjunction, so do not require operand facts merely because they could help derive an answer. A Boolean question returns no fabricated result entity. A source can state the requested relation directly without supplying operands. For a requested calculation or other operation, also retain requested_operation:{reading,support:{kind:query_text,excerpt}} and independently useful evidence_inputs:[{conditions:[...]}]. Listed alternative operand actions belong in separate evidence_inputs, not extra conjuncts of that operation; requiring every listed action together changes or into and. Each input branch carries its own event, participant, time and other qualifications. Input facts never execute the operation or prove the answer. If no faithful answer relation is expressible, conditions:[] may accompany the operation and inputs; do not turn the inputs into a claimed answer.",
  `A nesting path may contain at most ${SOURCE_SEMANTIC_QUERY_MEANING_MAX_DEPTH + 1} statement/operator nodes. Deeper meaning must remain a located gap; never silently truncate its scope.`,
  'An unknown answer or lawful witness is free; a named person or definite participant is named even when source identity is unknown. Shared incidence does not replace the named participant’s referent obligation. A named target preserves a referentially constrained expression in the original query, including a speaker, addressee, name or definite description; give it one exact query excerpt. A free target binds a value without an additional referent constraint; its excerpt supports a role, not a person. A free target leaves its value unknown without removing its stated nominal restrictions. A local key or support excerpt is not a class predicate. Express a stated class restriction as an ordinary predicate connected to the same variable in each independently sought branch, or keep unrepresentable meaning as a located gap. Named referent constraints and universal population or domain obligations remain distinct. If authorized query context leaves the intended named referent genuinely unresolved, retain named and locate an unresolved_referent gap on it, or abstain when no faithful usable query can be proposed. Unknown source correspondence alone requires no gap. Local keys are arbitrary identifiers, never text evidence or identity. First declare every named/free entity in the required entities table, using [] only when there are no entities. Entity declarations are the only place for kind named/free and entity return:true. All argument targets and reporter targets use {kind:"reference",key} to reuse a declaration. No keys are built in: a query speaker or addressee must be declared as named with its exact original-query excerpt. Free declarations, including a free reporter or evidence-input value, also retain their exact query excerpt. Reporter references remain entity-only.',
  'Use statement:{predicate,arguments,content?} and operators with explicit operands. A role reference to a declared event points to that occurrence; it does not embed the event, import its qualifications into another branch, or change its truth obligation. Give every statement/operator role reference its own exact original-query excerpt. Reuse a keyed event as a full condition with {kind:"occurrence",key} when that branch needs its qualifications. Use content when one event is within what another event says, asks or requires; retain the inner participants under that governing scope, without an independent asserted_at_source root. For generation, every role includes its own excerpt even when an entity declaration also supplies support. Resolve every reference by its declaration, never by its key. possible, not, reported and conditional preserve their scope; a report or hypothetical does not assert its embedded event.',
  "required_evidence_act:{act,excerpt} constrains the speech act of sought evidence. Omit it for ordinary factual questions; select act question/directive only when the original query explicitly seeks that source act, with an exact excerpt supporting the constraint. A source act belongs to an independently sought source root, not its embedded content. Factual questions seek source assertions or entailments, not unconditional world truth. Mark each requested entity, statement or operator with return:true on its declaration; the host derives the return list and IDs. Do not mark containing events or operation inputs as returns. A question word can locate a free answer target; it does not make other constrained participants free.",
  'Optional domains are {key,excerpt}. Universal evaluation is {kind:"forall",domain,binder,local_variables}; binders occur in the body and cannot be returned. entailed_at_source requests inference; asserted_at_source requests a literal assertion. Counterexample alternatives use purpose:"counterexample".',
  "Preserve universal population restrictions as domains and evaluation, not named entities or an invented census. Unknown domain members do not make the query referent unresolved. Nested universals remain unsupported. Preserve tense and temporal relation to the approved interpretation clock, completion/aspect, modality, units and other restrictions in meaningful predicates/roles or a located gap. A bare event lemma, supported participant, arbitrary key or asserted_at_source obligation does not imply that an event happened before the question clock. Do not invent an event date, and do not add a past restriction to a question that has none. A located gap makes represented evidence useful but never a complete answer.",
  'Comparison evaluation is {kind:"comparison",domain,operation:"lt"|"le"|"eq"|"ge"|"gt"|"minimum"|"maximum",left,right?,strict,metric,unit,context,scope:"asserted"|"preserve"} with no nested meaning. Pairwise strict is true only for lt/gt; extrema omit right and explicitly choose strictness. Return only operand keys.',
  "Declare comparison operands as entities; the evaluation refers to their keys. Use only the original query and approved fixed context, never source interpretations or proposed correspondences.",
  'Retain residual meaning in query.gaps:[{kind,affected_ids,support:[{kind:"query_text",excerpt}],description?}]. Excerpts copy exact original text. affected_ids names semantic keys of declared entities, keyed occurrences/frames or domains, or [] for unrepresented meaning; key an occurrence when a gap must name it. Node tokens such as n1 only serialize expressions and are never gap targets. Omit outcome.gaps to let the host echo this single gap list. A gap preserves a limitation; it does not replace meaning that the chosen structure can express.',
  `Complete neutral examples, not the current input: ${JSON.stringify(sourceSemanticQueryExamples)}. Referenced content is not independently asserted; domains are not closed censuses; retained inputs do not claim a computed answer.`
].join(" ");

export const SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT = [
  "The original_query is the evidence text. Every query_excerpt and query_support.excerpt must copy an exact substring from it, preserving its inflection and language; normalized query-semantics predicates are not evidence excerpts.",
  "Propose semantic_correspondence as source-semantic-correspondence-assessment-v1 over the advertised catalog.",
  "Use contextual equivalence only. Semantic correspondence cannot rank or answer. Do not emit answers, ranking, seeds, programs, verdicts, or chosen results.",
  "Do not invent source-interpretation structure or rewrite query semantics. Do not copy host hashes or assemble internal query-semantics or source-interpretation endpoint objects.",
  "Name the target interpretation with request-local handle source1, source2, ... in descriptor order. Assess every advertised qeN exactly once for that interpretation, even when no equivalence is supported. Do not assess source endpoints as query endpoints.",
  "For each query endpoint, use status supported with a nonempty equivalents array containing every proposed contextual equivalent seN, or status unresolved with an exact query_excerpt and explanation of the unestablished obligation. Never leave an endpoint out or put an unsupported pair in an unresolved record. Keep all supported many-to-many pairs; do not pick a preferred pair or enumerate every possible query/source pair. Only request-schema-eligible referent and slot handles may omit query_excerpt; predicate handles and source words still require an exact original-query excerpt.",
  "Each supported equivalent retains exact query_excerpt and source_semantic_support and adds bounded grounding. For a reference, explain its full denotation using the admitted reference, source mention and use, and relevant scope or context evidence; matching a word or entity type alone is insufficient. For predicates and slots, explain the local relation. Grounding and unresolved explanations are inspectable proposals, not certificates and not answers.",
  "A set-valued query may have multiple asserted source frames. Preserve each supported predicate and returned-variable slot relation on its actual frame; do not collapse frames onto the first hit. If a slot is unsupported, assess it unresolved rather than fabricate a binding. Partial supported assessments remain available for native composition.",
  "An endpoint pair must express the same contextual meaning, not merely related topics or similar entity types. A named query target keeps its actual meaning. A free answer variable is not the requester or a named source participant merely because both denote people. If no supported pair exists, submit explicit unresolved assessments; abstain only if you cannot provide the assessment. Partial overlap must not invent missing equivalences.",
  'Optional domains map {query_domain,source_domain,query_support,source_semantic_support}. Explicit conditional membership assumptions are {query_variable,source_domain,restrictions:[],status:"member"|"excluded",query_support,description}; use only assumptions stated in the query/context, never infer identity from a matching surface name. Closed source domains cannot acquire novel assumed members.',
  "Domain identifiers are exact admitted_query_semantics.domains[].id and the selected source interpretation's domains[].id. A frame, entity, statement, endpoint handle or conceptual category is not a domain identifier. If the source interpretation has no declared domains, omit domains and membership_assumptions or return empty arrays. Ordinary free-answer questions do not require inventing finite-domain membership. The source must already supply any domain you reference.",
  "An interpreted semantic_correspondence has no gap channel: omit outcome.gaps or send []. Explicit unresolved endpoint assessments are not world-negation or canonical C gaps."
].join(" ");
