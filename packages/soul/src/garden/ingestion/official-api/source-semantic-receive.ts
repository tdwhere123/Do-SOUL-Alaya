import { z } from "zod";
import {
  AlayaError, SOURCE_SEMANTIC_ALIGNMENT_CONTRACT, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SourceSemanticAlignmentProducerBodySchema, SourceSemanticAlignmentSchema,
  SourceSemanticGapSchema, SourceSemanticOutcomeSchema, SourceSemanticQueryProducerBodySchema,
  SourceSemanticQuerySchema,
  SourceSemanticResponseEnvelopeSchema, SourceSemanticOutcomeGapBindingSchema, sourceSemanticValidationDiagnostics,
  materializeSourceSemanticProposal, materializeSourceSemanticContentProposal, buildSourceReferenceCatalog,
  materializeSourceSemanticExpressionProposal, SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT,
  materializeSourceSemanticCompactProposal, SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  normalizeSourceSemantics, sourceSemanticQueryIdentity, verifySourceSemanticDisposition, canonicalJson,
  type SourceSemanticAlignment, type SourceSemanticDraft, type SourceSemanticInterpretation,
  type SourceSemanticOutcome, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_ALIGNMENT_RESPONSE_CONTRACT, SOURCE_SEMANTIC_QUERY_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
  buildSourceSemanticAlignmentRequest, buildSourceSemanticQueryRequest, buildSourceSemanticRequest,
  parseSourceSemanticRequest, semanticSha256, rejectForbiddenProposalInput,
  type SourceSemanticAlignmentProposalInput, type SourceSemanticAlignmentRequest,
  type SourceSemanticHDescriptor, type SourceSemanticProposalInput, type SourceSemanticQueryProposalInput,
  type SourceSemanticQueryRequest, type SourceSemanticRequest
} from "./source-semantic-request.js";

import { buildOfficialApiSourceRequest } from "./extraction-request.js";
import { indexOfficialApiSourceAssertions } from "../../triage/grounding/source-locator.js";

export const MAX_SOURCE_SEMANTIC_RESPONSE_BYTES = 1024 * 1024;
const HOST_ONLY_OUTCOMES = new Set(["no_eligible_source", "unavailable", "unexercised", "preparation_required"]);

export type SourceSemanticProposalResult = Readonly<{
  outcome: SourceSemanticOutcome;
  provider_attempts: 0 | 1;
  request: SourceSemanticRequest;
  draft?: SourceSemanticDraft;
  interpretation?: SourceSemanticInterpretation;
  raw_response_id?: string;
  rawJson?: string;
}>;

export type SourceSemanticQueryProposalResult = Readonly<{
  system_prompt: string;
  outcome: SourceSemanticOutcome;
  provider_attempts: 0 | 1;
  request: SourceSemanticQueryRequest;
  query?: SourceSemanticQuery;
  raw_response_id?: string;
  rawJson?: string;
}>;

export type SourceSemanticAlignmentProposalResult = Readonly<{
  system_prompt: string;
  outcome: SourceSemanticOutcome;
  provider_attempts: 0 | 1;
  request: SourceSemanticAlignmentRequest;
  alignment?: SourceSemanticAlignment;
  raw_response_id?: string;
  rawJson?: string;
}>;

export type ParseSourceSemanticQueryProposal = (input: Readonly<{
  original_query: string;
  request: SourceSemanticQueryRequest;
  query: SourceSemanticQuery;
}>) => SourceSemanticQuery;

type Attempt<T> = Readonly<{ provider_attempts: 1; request: T; raw_response_id: string; rawJson: string }>;

export function proposeSourceSemantics(
  input: SourceSemanticProposalInput,
  injected?: Readonly<{ rawJson: string }>
): SourceSemanticProposalResult {
  const request = buildSourceSemanticRequest(input);
  if (request.source_request.source_assertions.length === 0) {
    return { outcome: { status: "no_eligible_source", provider_attempts: 0 }, provider_attempts: 0, request };
  }
  if (injected === undefined) {
    return { outcome: { status: "unexercised" }, provider_attempts: 0, request };
  }
  return receiveSourceSemantics(injected.rawJson, request, input);
}

/** Host-only empty catalog. A model envelope claiming no_eligible_source remains invalid. */
export function completeEmptySourceSemantics(
  requestValue: SourceSemanticRequest,
  input: SourceSemanticProposalInput
): SourceSemanticProposalResult {
  const request = parseSourceSemanticRequest(requestValue);
  if (request.source_request.source_assertions.length !== 0 || input.assertionIds.length !== 0) {
    throw new AlayaError("CONFLICT", "deterministic empty source semantics requires no eligible assertions");
  }
  bindSource(request, input);
  return { outcome: { status: "no_eligible_source", provider_attempts: 0 }, provider_attempts: 0, request };
}

export function receiveSourceSemantics(
  rawJson: string, requestValue: SourceSemanticRequest, input: SourceSemanticProposalInput
): SourceSemanticProposalResult {
  const request = parseSourceSemanticRequest(requestValue);
  const attempt = bindAttempt(rawJson, request);
  const bounded = boundRawJson(rawJson, request.source_request.resource_limits.output_byte_limit, attempt);
  if (bounded !== undefined) return bounded;
  bindSource(request, input);
  const parsed = parseResponseJson(rawJson, attempt);
  if (parsed.status !== "ok") return parsed.result;
  // Marker-absent v3 requests are retained only for historical raw/cache replay.
  // Remove this branch when those archives use an offline-only legacy reader.
  let envelope: ReturnType<typeof SourceSemanticResponseEnvelopeSchema.safeParse>;
  const limits = request.source_request.resource_limits;
  const compact = request.source_request.proposal_contract === SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT;
  const expression = request.source_request.proposal_contract === SOURCE_SEMANTIC_EXPRESSION_PROPOSAL_CONTRACT;
  const meter = compact || expression || request.source_request.proposal_contract === SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT
    ? new SourceSemanticResourceLedger({ work_units: limits.work_units ?? 200000, memory_bytes: limits.memory_bytes ?? 20000000 }) : undefined;
  try {
    envelope = request.source_request.proposal_contract === undefined
      ? SourceSemanticResponseEnvelopeSchema.safeParse(parsed.value)
      : compact ? { success: true, data: materializeSourceSemanticCompactProposal(parsed.value, meter) }
      : expression ? { success: true, data: materializeSourceSemanticExpressionProposal(parsed.value, meter) }
      : meter !== undefined ? { success: true, data: materializeSourceSemanticContentProposal(parsed.value, meter) }
      : { success: true, data: materializeSourceSemanticProposal(parsed.value) };
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return { ...attempt, outcome: { status: "resource_exhausted" } };
    return { ...attempt, outcome: invalidProposalOutcome(error) };
  }
  if (!envelope.success) {
    return { ...attempt, outcome: invalidSchemaOutcome(envelope.error) };
  }
  const { outcome, draft } = envelope.data;
  if (HOST_ONLY_OUTCOMES.has(outcome.status)) {
    return { ...attempt, outcome: { status: "invalid", reason: "host_only_outcome" } };
  }
  if (outcome.status === "no_executable_proposition") {
    try { return { ...attempt, outcome: verifySourceSemanticDisposition(outcome, request.source_catalog, semanticSha256) }; }
    catch { return { ...attempt, outcome: { status: "invalid", reason: "unbound_disposition_support" } }; }
  }
  if (outcome.status !== "interpreted" || draft === undefined) return { ...attempt, outcome };
  return admitInterpretedDraft(draft, request, input, attempt, meter);
}

export function proposeQuerySemantics(
  input: SourceSemanticQueryProposalInput,
  injected?: Readonly<{ rawJson: string }>,
  parseQuery: ParseSourceSemanticQueryProposal = parseSourceSemanticQueryProposal
): SourceSemanticQueryProposalResult {
  const request = buildSourceSemanticQueryRequest(input);
  if (injected === undefined) {
    return { outcome: { status: "unexercised" }, provider_attempts: 0, request,
      system_prompt: SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT };
  }
  return { ...receiveQuerySemantics(injected.rawJson, request, parseQuery), system_prompt: SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT };
}

function receiveQuerySemantics(
  rawJson: string, request: SourceSemanticQueryRequest, parseQuery: ParseSourceSemanticQueryProposal = parseSourceSemanticQueryProposal
): Omit<SourceSemanticQueryProposalResult, "system_prompt"> {
  const attempt = bindAttempt(rawJson, request);
  const bounded = boundRawJson(rawJson, request.resource_limits.output_byte_limit, attempt);
  if (bounded !== undefined) return bounded;
  const parsed = parseResponseJson(rawJson, attempt);
  if (parsed.status !== "ok") return parsed.result;
  const envelope = queryResponseSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return { ...attempt, outcome: invalidSchemaOutcome(envelope.error) };
  }
  if (HOST_ONLY_OUTCOMES.has(envelope.data.outcome.status)) {
    return { ...attempt, outcome: { status: "invalid", reason: "host_only_outcome" } };
  }
  if (envelope.data.outcome.status !== "interpreted") return { ...attempt, outcome: envelope.data.outcome };
  if (envelope.data.query === undefined) {
    return { ...attempt, outcome: { status: "invalid", reason: "interpreted_query_required" } };
  }
  try {
    const query = parseQuery({ original_query: request.original_query, request, query: materializeQuery(envelope.data.query, request) });
    const reportedGaps = envelope.data.outcome.gaps;
    if (reportedGaps !== undefined) {
      SourceSemanticOutcomeGapBindingSchema.parse({
        outcome: { status: "interpreted", gaps: reportedGaps }, gaps: query.gaps
      });
    }
    if (query.original_query_digest !== request.original_query_digest) {
      return { ...attempt, outcome: { status: "invalid", reason: "query_digest_mismatch" } };
    }
    return { ...attempt, outcome: { status: "interpreted", gaps: query.gaps }, query };
  } catch (error) {
    return { ...attempt, outcome: invalidProposalOutcome(error) };
  }
}

export function proposeAlignmentSemantics(
  input: SourceSemanticAlignmentProposalInput,
  injected?: Readonly<{ rawJson: string }>
): SourceSemanticAlignmentProposalResult {
  const request = buildSourceSemanticAlignmentRequest(input);
  if (injected === undefined) {
    return { outcome: { status: "unexercised" }, provider_attempts: 0, request,
      system_prompt: SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT };
  }
  return { ...receiveAlignmentSemantics(injected.rawJson, request), system_prompt: SOURCE_SEMANTIC_ALIGNMENT_SYSTEM_PROMPT };
}

function receiveAlignmentSemantics(
  rawJson: string, request: SourceSemanticAlignmentRequest
): Omit<SourceSemanticAlignmentProposalResult, "system_prompt"> {
  const attempt = bindAttempt(rawJson, request);
  const bounded = boundRawJson(rawJson, request.resource_limits.output_byte_limit, attempt);
  if (bounded !== undefined) return bounded;
  const parsed = parseResponseJson(rawJson, attempt);
  if (parsed.status !== "ok") return parsed.result;
  const envelope = alignmentResponseSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return { ...attempt, outcome: invalidSchemaOutcome(envelope.error) };
  }
  if (HOST_ONLY_OUTCOMES.has(envelope.data.outcome.status)) {
    return { ...attempt, outcome: { status: "invalid", reason: "host_only_outcome" } };
  }
  if (envelope.data.outcome.status !== "interpreted") return { ...attempt, outcome: envelope.data.outcome };
  if (envelope.data.alignment === undefined) {
    return { ...attempt, outcome: { status: "invalid", reason: "interpreted_alignment_required" } };
  }
  try {
    const alignment = SourceSemanticAlignmentSchema.parse(materializeAlignment(envelope.data.alignment, request));
    SourceSemanticOutcomeGapBindingSchema.parse({
      outcome: { status: "interpreted", gaps: envelope.data.outcome.gaps ?? [] }, gaps: []
    });
    if (alignment.q_id !== sourceSemanticQueryIdentity(request.admitted_q, semanticSha256)) {
      return { ...attempt, outcome: { status: "invalid", reason: "alignment_q_mismatch" } };
    }
    if (!request.h_descriptors.some((row) => row.h_id === alignment.h_id)) {
      return { ...attempt, outcome: { status: "invalid", reason: "alignment_h_mismatch" } };
    }
    return { ...attempt, outcome: { status: "interpreted", gaps: [] }, alignment };
  } catch (error) {
    return { ...attempt, outcome: invalidProposalOutcome(error) };
  }
}

/** Parses a proposed Q. Core `admitSourceSemanticQuery` is the admission owner. */
function parseSourceSemanticQueryProposal(input: Readonly<{
  original_query: string; request: SourceSemanticQueryRequest; query: SourceSemanticQuery;
}>): SourceSemanticQuery {
  void input.original_query;
  return SourceSemanticQuerySchema.parse(input.query);
}

function admitInterpretedDraft(
  draft: SourceSemanticDraft, request: SourceSemanticRequest, input: SourceSemanticProposalInput,
  attempt: Attempt<SourceSemanticRequest>, meter?: SourceSemanticResourceLedger
): SourceSemanticProposalResult {
  const limits = request.source_request.resource_limits;
  const normalized = normalizeSourceSemantics({
    draft, catalog: request.source_catalog, sha256: semanticSha256,
    source: {
      source_id: input.source_id, source_version: input.source_version,
      content_digest: `sha256:${semanticSha256(input.sourceCorpus)}`,
      ...(request.source_request.assertion_locations === undefined ? {} : { assertion_locations: request.source_request.assertion_locations })
    },
    producer_id: request.source_request.producer_capability.producer_id,
    producer_version: request.source_request.producer_capability.producer_version,
    contract_version: SOURCE_SEMANTIC_PACKET_CONTRACT,
    normalizer_version: request.source_request.normalizer_version,
    ...(meter === undefined ? {} : { meter }),
    ...(limits.work_units !== undefined && limits.memory_bytes !== undefined
      ? { budget: { work_units: limits.work_units, memory_bytes: limits.memory_bytes } } : {})
  });
  if (normalized.status === "resource_exhausted") return { ...attempt, outcome: { status: "resource_exhausted" }, draft };
  if (normalized.status !== "normalized") {
    return { ...attempt, outcome: { status: "invalid", reason: normalized.reason }, draft };
  }
  return {
    ...attempt, outcome: { status: "interpreted", gaps: normalized.interpretation.gaps }, draft,
    interpretation: normalized.interpretation
  };
}

function bindSource(request: SourceSemanticRequest, input: SourceSemanticProposalInput): void {
  const ids = request.source_request.source_assertions.map((row) => row.assertion_id);
  const expected = request.source_request.source_unit_contract === undefined
    ? historicalSourceBinding(input.sourceCorpus, ids)
    : buildSourceSemanticRequest({ ...input, assertionIds: ids, sourceScope: request.source_request.source_scope });
  if (canonicalJson(expected.source_catalog) !== canonicalJson(request.source_catalog) ||
    canonicalJson(expected.source_request.source_assertions) !== canonicalJson(request.source_request.source_assertions) ||
    request.source_request.assertion_locations !== undefined && canonicalJson(expected.source_request.assertion_locations) !== canonicalJson(request.source_request.assertion_locations)) {
    throw new AlayaError("CONFLICT", "source semantic assertion locations differ from the source owner");
  }
  if (semanticSha256(input.sourceCorpus) !== request.source_catalog.source_digest) {
    throw new AlayaError("CONFLICT", "source semantic source generation mismatch");
  }
}

/** Retained raw/cache requests predate source units. Remove after offline archive migration. */
function historicalSourceBinding(sourceCorpus: string, ids: readonly number[]) {
  const source = buildOfficialApiSourceRequest(sourceCorpus, ids);
  const selectedIds = new Set(ids);
  const indexed = indexOfficialApiSourceAssertions(sourceCorpus).filter((row) => selectedIds.has(row.assertion_id));
  return {
    source_catalog: buildSourceReferenceCatalog(semanticSha256(sourceCorpus), source.source_assertions, semanticSha256),
    source_request: { source_assertions: source.source_assertions, assertion_locations: indexed.map((row) => {
      return { assertion_id: row.assertion_id, source_utf8_span: [Buffer.byteLength(sourceCorpus.slice(0, row.start)), Buffer.byteLength(sourceCorpus.slice(0, row.end))] };
    }) }
  };
}

function bindAttempt<T>(rawJson: string, request: T): Attempt<T> {
  return { provider_attempts: 1, request, raw_response_id: `sha256:${semanticSha256(rawJson)}`, rawJson };
}

function boundRawJson<T>(rawJson: string, requestLimit: number, attempt: Attempt<T>):
  (Attempt<T> & { outcome: SourceSemanticOutcome }) | undefined {
  const limit = Math.min(MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, requestLimit);
  if (Buffer.byteLength(rawJson, "utf8") > limit) return { ...attempt, outcome: { status: "truncated" } };
  if (rawJson.length === 0) return { ...attempt, outcome: { status: "transport_failure" } };
  return undefined;
}

function parseResponseJson<T>(rawJson: string, attempt: Attempt<T>):
  { status: "ok"; value: unknown } | { status: "fail"; result: Attempt<T> & { outcome: SourceSemanticOutcome } } {
  try {
    return { status: "ok", value: JSON.parse(rawJson) };
  } catch {
    return { status: "fail", result: { ...attempt, outcome: { status: "invalid", reason: "malformed_json" } } };
  }
}

function materializeQuery(body: unknown, request: SourceSemanticQueryRequest): SourceSemanticQuery {
  const record = asRecord(body);
  rejectForbiddenProposalInput(record);
  const parsed = SourceSemanticQueryProducerBodySchema.parse(record);
  return SourceSemanticQuerySchema.parse({
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT,
    original_query_digest: request.original_query_digest,
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version,
    contract_version: SOURCE_SEMANTIC_QUERY_CONTRACT,
    variables: parsed.variables,
    alternatives: parsed.alternatives,
    return_variables: parsed.return_variables,
    gaps: parsed.gaps,
    ...(parsed.domains === undefined ? {} : { domains: parsed.domains }),
    ...(parsed.evaluation === undefined ? {} : { evaluation: parsed.evaluation })
  });
}

function materializeAlignment(body: unknown, request: SourceSemanticAlignmentRequest): unknown {
  const record = asRecord(body);
  rejectForbiddenProposalInput(record);
  const parsed = SourceSemanticAlignmentProducerBodySchema.parse(record);
  return {
    contract: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
    h_id: bindAlignmentHandle(parsed.h, request.h_descriptors),
    q_id: sourceSemanticQueryIdentity(request.admitted_q, semanticSha256),
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version,
    contract_version: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
    correspondences: parsed.correspondences,
    ...(parsed.domains === undefined ? {} : { domains: parsed.domains }),
    ...(parsed.membership_assumptions === undefined ? {} : { membership_assumptions: parsed.membership_assumptions })
  };
}

function bindAlignmentHandle(handle: string | undefined, descriptors: readonly SourceSemanticHDescriptor[]): string {
  if (handle === undefined) {
    if (descriptors.length !== 1) {
      throw new AlayaError("VALIDATION", "alignment to multiple descriptors requires a request-local handle");
    }
    return descriptors[0]!.h_id;
  }
  const descriptor = descriptors[Number(handle.slice(1)) - 1];
  if (descriptor === undefined) {
    throw new AlayaError("VALIDATION", "alignment handle does not name a supplied descriptor");
  }
  return descriptor.h_id;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AlayaError("VALIDATION", "proposal body must be an object");
  }
  return value as Record<string, unknown>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "invalid_proposal";
}

function invalidSchemaOutcome(error: z.ZodError): SourceSemanticOutcome {
  return { status: "invalid", reason: "malformed_response", diagnostics: sourceSemanticValidationDiagnostics(error) };
}

function invalidProposalOutcome(error: unknown): SourceSemanticOutcome {
  return error instanceof z.ZodError ? invalidSchemaOutcome(error) : { status: "invalid", reason: reasonOf(error) };
}

const InterpretedOutcome = z.object({
  status: z.literal("interpreted"),
  gaps: z.array(SourceSemanticGapSchema).max(256).readonly().optional()
}).strict().readonly();
const ProducerResponseOutcomeSchema = z.discriminatedUnion("status", [
  InterpretedOutcome,
  ...SourceSemanticOutcomeSchema.options.filter((option) => option.unwrap().shape.status.value !== "interpreted")
]);

const queryResponseSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_QUERY_RESPONSE_CONTRACT),
  outcome: ProducerResponseOutcomeSchema,
  query: z.unknown().optional()
}).strict().readonly();

const alignmentResponseSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_ALIGNMENT_RESPONSE_CONTRACT),
  outcome: ProducerResponseOutcomeSchema,
  alignment: z.unknown().optional()
}).strict().readonly();
