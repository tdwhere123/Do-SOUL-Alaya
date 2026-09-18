import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AlayaError, BoundedIdSchema, SourceAssertionIdSchema, SourceSemanticHandleSchema,
  SourceSemanticQuerySchema, SourceSemanticRequestEnvelopeSchema, SourceSemanticResponseEnvelopeSchema,
  SOURCE_SEMANTIC_ALIGNMENT_CONTRACT, SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION, SOURCE_SEMANTIC_K_VERSION,
  SOURCE_SEMANTIC_NORMALIZER_VERSION, SOURCE_SEMANTIC_PACKET_CONTRACT, SOURCE_SEMANTIC_QUERY_CONTRACT,
  buildSourceReferenceCatalog, canonicalJson,
  type SourceInterpretationProfile, type SourceReferenceCatalog, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceRequest } from "./extraction-request.js";

export const SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT = "source-semantic-query-request-v1" as const;
export const SOURCE_SEMANTIC_QUERY_RESPONSE_CONTRACT = "source-semantic-query-response-v1" as const;
export const SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT = "source-semantic-alignment-request-v1" as const;
export const SOURCE_SEMANTIC_ALIGNMENT_RESPONSE_CONTRACT = "source-semantic-alignment-response-v1" as const;

const FORBIDDEN_PROPOSAL_KEYS = [
  "answers", "answer", "ranking", "seeds", "seed", "programs", "program",
  "verdicts", "verdict", "QueryProgram", "query_program", "answer_ids", "answerIds"
] as const;

export const SourceSemanticResourceLimitsSchema = z.object({
  output_byte_limit: z.number().int().min(1024).max(1024 * 1024),
  work_units: z.number().int().nonnegative().optional(),
  memory_bytes: z.number().int().nonnegative().optional()
}).strict().readonly();

const ProducerCapability = z.object({
  producer_id: BoundedIdSchema,
  producer_version: z.string().min(1).max(1024),
  proposes: z.literal("draft_semantics")
}).strict().readonly();

export const SourceSemanticOpenRequestBodySchema = z.object({
  k_version: z.literal(SOURCE_SEMANTIC_K_VERSION),
  normalizer_version: z.literal(SOURCE_SEMANTIC_NORMALIZER_VERSION),
  producer_capability: ProducerCapability,
  resource_limits: SourceSemanticResourceLimitsSchema,
  source_assertions: z.array(z.object({
    assertion_id: SourceAssertionIdSchema, text: z.string().trim().min(1)
  }).strict().readonly()).max(8).readonly()
}).strict().readonly();

const ApprovedContextSchema = z.object({
  context_id: BoundedIdSchema, notes: z.string().min(1).max(1024).optional()
}).strict().readonly();

export const SourceSemanticHDescriptorSchema = z.object({
  h_id: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  source_id: BoundedIdSchema,
  source_version: BoundedIdSchema,
  frames: z.array(z.object({
    id: SourceSemanticHandleSchema,
    predicate_reading: z.string().min(1).max(256),
    slots: z.array(z.object({
      id: SourceSemanticHandleSchema, role_reading: z.string().min(1).max(256)
    }).strict().readonly()).max(8).readonly()
  }).strict().readonly()).max(256).readonly()
}).strict().readonly();

export type SourceSemanticResourceLimits = z.infer<typeof SourceSemanticResourceLimitsSchema>;
export type SourceSemanticOpenRequestBody = z.infer<typeof SourceSemanticOpenRequestBodySchema>;
export type SourceSemanticApprovedContext = z.infer<typeof ApprovedContextSchema>;
export type SourceSemanticHDescriptor = z.infer<typeof SourceSemanticHDescriptorSchema>;

export type SourceSemanticRequest = Readonly<{
  schema_version: typeof SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION;
  interpretation_contract: typeof SOURCE_SEMANTIC_PACKET_CONTRACT;
  source_request: SourceSemanticOpenRequestBody;
  source_catalog: SourceReferenceCatalog;
  profile?: SourceInterpretationProfile;
}>;

export type SourceSemanticProposalInput = Readonly<{
  sourceCorpus: string;
  assertionIds: readonly number[];
  source_id: string;
  source_version: string;
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
  profile?: SourceInterpretationProfile;
}>;

export type SourceSemanticQueryProposalInput = Readonly<{
  original_query: string;
  approved_fixed_context?: SourceSemanticApprovedContext;
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
}>;

export type SourceSemanticAlignmentProposalInput = Readonly<{
  admitted_q: SourceSemanticQuery;
  h_descriptors: readonly SourceSemanticHDescriptor[];
  producer_id: string;
  producer_version: string;
  resource_limits?: Partial<SourceSemanticResourceLimits>;
}>;

export type SourceSemanticQueryRequest = Readonly<{
  contract: typeof SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  original_query: string;
  original_query_digest: string;
  approved_fixed_context?: SourceSemanticApprovedContext;
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
}>;

export type SourceSemanticAlignmentRequest = Readonly<{
  contract: typeof SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT;
  k_version: typeof SOURCE_SEMANTIC_K_VERSION;
  admitted_q: SourceSemanticQuery;
  h_descriptors: readonly SourceSemanticHDescriptor[];
  producer_capability: z.infer<typeof ProducerCapability>;
  resource_limits: SourceSemanticResourceLimits;
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

export function parseSourceSemanticRequest(value: unknown): SourceSemanticRequest {
  const parsed = SourceSemanticRequestEnvelopeSchema.parse(value);
  const source_request = SourceSemanticOpenRequestBodySchema.parse(parsed.source_request);
  if (new Set(source_request.source_assertions.map((row) => row.assertion_id)).size !== source_request.source_assertions.length) {
    throw new AlayaError("VALIDATION", "source semantic request has duplicate assertion identities");
  }
  const catalog = buildSourceReferenceCatalog(parsed.source_catalog.source_digest, source_request.source_assertions, semanticSha256);
  if (canonicalJson(catalog) !== canonicalJson(parsed.source_catalog)) {
    throw new AlayaError("CONFLICT", "source semantic request catalog mismatch");
  }
  const request = { ...parsed, source_request } as SourceSemanticRequest;
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 1_000_000) {
    throw new AlayaError("VALIDATION", "source semantic request exceeds its byte bound");
  }
  return request;
}

export function buildSourceSemanticRequest(input: SourceSemanticProposalInput): SourceSemanticRequest {
  rejectForbiddenProposalInput(input);
  const extraction = buildOfficialApiSourceRequest(input.sourceCorpus, input.assertionIds);
  const source_request = SourceSemanticOpenRequestBodySchema.parse({
    k_version: SOURCE_SEMANTIC_K_VERSION,
    normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits),
    source_assertions: extraction.source_assertions
  });
  return parseSourceSemanticRequest({
    schema_version: SOURCE_SEMANTIC_ENVELOPE_SCHEMA_VERSION,
    interpretation_contract: SOURCE_SEMANTIC_PACKET_CONTRACT,
    source_request,
    source_catalog: buildSourceReferenceCatalog(semanticSha256(input.sourceCorpus), source_request.source_assertions, semanticSha256),
    ...(input.profile !== undefined ? { profile: input.profile } : {})
  });
}

export function sourceSemanticRequestIdentity(request: SourceSemanticRequest): string {
  return `sha256:${semanticSha256(canonicalJson(parseSourceSemanticRequest(request)))}`;
}

export function buildSourceSemanticQueryRequest(input: SourceSemanticQueryProposalInput): SourceSemanticQueryRequest {
  rejectForbiddenProposalInput(input);
  if (input.original_query.trim().length === 0) {
    throw new AlayaError("VALIDATION", "query proposal requires the original query");
  }
  const original_query = input.original_query;
  if (original_query.length > 8192) throw new AlayaError("VALIDATION", "original query exceeds its bound");
  return {
    contract: SOURCE_SEMANTIC_QUERY_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    original_query,
    original_query_digest: `sha256:${semanticSha256(original_query)}`,
    ...(input.approved_fixed_context !== undefined
      ? { approved_fixed_context: ApprovedContextSchema.parse(input.approved_fixed_context) } : {}),
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits)
  };
}

export function buildSourceSemanticAlignmentRequest(
  input: SourceSemanticAlignmentProposalInput
): SourceSemanticAlignmentRequest {
  rejectForbiddenProposalInput(input);
  const admitted_q = SourceSemanticQuerySchema.parse(input.admitted_q);
  const h_descriptors = z.array(SourceSemanticHDescriptorSchema).min(1).max(64).parse(input.h_descriptors);
  return {
    contract: SOURCE_SEMANTIC_ALIGNMENT_REQUEST_CONTRACT,
    k_version: SOURCE_SEMANTIC_K_VERSION,
    admitted_q,
    h_descriptors,
    producer_capability: producerCapability(input.producer_id, input.producer_version),
    resource_limits: resourceLimits(input.resource_limits)
  };
}

/** Open-mode JSON Schema from the 02 envelope. No profile content enums. */
export function sourceSemanticResponseJsonSchema(): object {
  return z.toJSONSchema(SourceSemanticResponseEnvelopeSchema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
    }
  });
}

export const SOURCE_SEMANTIC_SYSTEM_PROMPT = [
  "Propose one source-local semantic draft using source-interpretation-v3.",
  'Return strict JSON {"contract":"source-interpretation-response-v3","outcome":OUTCOME,"draft":DRAFT_IF_INTERPRETED}.',
  "Ask only for draft semantics: mention handles with catalog first/last selections, referents, frames with predicate and role readings, slot definitions versus bindings, operators, context owners, lexical/additional/dominating support, and explicit gaps.",
  "Do not emit host hashes, character or UTF-8 offsets, entry_roots, asserted_at_scope, persistent IDs, QueryProgram, seeds, scores, ranking, answers, or verdicts.",
  "A supplied profile is an optional adapter, not an admission prerequisite. Novel predicate and role readings are allowed.",
  "Select inclusive first/last segment IDs shown in source_catalog. Never copy quotation text, invent offsets, or cross assertion boundaries.",
  "Explicit predicate support needs valid mention handles; implicit support needs supporting context and a reading. Empty or omitted support is a gap, not implicit.",
  "Unresolved referents are local. Do not mint a global unknown. Record unsupported meaning as gaps.",
  "Outcome interpreted requires a draft; abstained, invalid, quarantine, truncated, and transport failures must not carry a draft.",
  "Do not infer world truth or confidence. Admission of a draft does not certify language fidelity."
].join(" ");

export const SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT = [
  "Propose query interpretation for the original query only, using source-semantic-query-v1 body fields.",
  "Return variables, frames, role requirements, context obligations, finite alternatives, and located gaps.",
  "Do not emit answers, ranking, seeds, QueryProgram, programs, verdicts, or source answer IDs.",
  "Bind meaning to the original query text. Approved fixed context is given; do not invent H or A."
].join(" ");

export const SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT = [
  "Propose alignment correspondences from admitted Q endpoints to the supplied H descriptors.",
  "Use contextual equivalence only. Do not emit answers, ranking, seeds, programs, verdicts, or chosen results.",
  "Do not invent H structure or rewrite Q."
].join(" ");
