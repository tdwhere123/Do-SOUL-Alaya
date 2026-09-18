import { z } from "zod";
import {
  AlayaError, SOURCE_SEMANTIC_ALIGNMENT_CONTRACT, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SourceSemanticAlignmentSchema,
  SourceSemanticOutcomeSchema, SourceSemanticQuerySchema, SourceSemanticResponseEnvelopeSchema,
  normalizeSourceSemantics, sourceSemanticQueryIdentity,
  type SourceSemanticAlignment, type SourceSemanticDraft, type SourceSemanticInterpretation,
  type SourceSemanticOutcome, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_ALIGNMENT_RESPONSE_CONTRACT, SOURCE_SEMANTIC_QUERY_RESPONSE_CONTRACT,
  buildSourceSemanticAlignmentRequest, buildSourceSemanticQueryRequest, buildSourceSemanticRequest,
  parseSourceSemanticRequest, semanticSha256,
  type SourceSemanticAlignmentProposalInput, type SourceSemanticAlignmentRequest,
  type SourceSemanticHDescriptor, type SourceSemanticProposalInput, type SourceSemanticQueryProposalInput,
  type SourceSemanticQueryRequest, type SourceSemanticRequest
} from "./source-semantic-request.js";

export const MAX_SOURCE_SEMANTIC_RESPONSE_BYTES = 1024 * 1024;
const HOST_ONLY_OUTCOMES = new Set(["no_eligible_source", "unexercised", "preparation_required"]);

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
  outcome: SourceSemanticOutcome;
  provider_attempts: 0 | 1;
  request: SourceSemanticQueryRequest;
  query?: SourceSemanticQuery;
  raw_response_id?: string;
  rawJson?: string;
}>;

export type SourceSemanticAlignmentProposalResult = Readonly<{
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
  const received = proposeSourceSemantics({ ...input, assertionIds: [] });
  if (received.outcome.status !== "no_eligible_source" || received.provider_attempts !== 0) {
    throw new AlayaError("CONFLICT", "deterministic empty source semantics cannot contain a proposal");
  }
  return received;
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
  const envelope = SourceSemanticResponseEnvelopeSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return { ...attempt, outcome: { status: "invalid", reason: "malformed_response" } };
  }
  const { outcome, draft } = envelope.data;
  if (HOST_ONLY_OUTCOMES.has(outcome.status)) {
    return { ...attempt, outcome: { status: "invalid", reason: "host_only_outcome" } };
  }
  if (outcome.status !== "interpreted" || draft === undefined) return { ...attempt, outcome };
  return admitInterpretedDraft(draft, request, input, attempt);
}

export function proposeQuerySemantics(
  input: SourceSemanticQueryProposalInput,
  injected?: Readonly<{ rawJson: string }>,
  parseQuery: ParseSourceSemanticQueryProposal = parseSourceSemanticQueryProposal
): SourceSemanticQueryProposalResult {
  const request = buildSourceSemanticQueryRequest(input);
  if (injected === undefined) {
    return { outcome: { status: "unexercised" }, provider_attempts: 0, request };
  }
  return receiveQuerySemantics(injected.rawJson, request, parseQuery);
}

export function receiveQuerySemantics(
  rawJson: string, request: SourceSemanticQueryRequest, parseQuery: ParseSourceSemanticQueryProposal = parseSourceSemanticQueryProposal
): SourceSemanticQueryProposalResult {
  const attempt = bindAttempt(rawJson, request);
  const bounded = boundRawJson(rawJson, request.resource_limits.output_byte_limit, attempt);
  if (bounded !== undefined) return bounded;
  const parsed = parseResponseJson(rawJson, attempt);
  if (parsed.status !== "ok") return parsed.result;
  const envelope = queryResponseSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return { ...attempt, outcome: { status: "invalid", reason: "malformed_response" } };
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
    if (query.original_query_digest !== request.original_query_digest) {
      return { ...attempt, outcome: { status: "invalid", reason: "query_digest_mismatch" } };
    }
    return { ...attempt, outcome: { status: "interpreted", gaps: query.gaps }, query };
  } catch (error) {
    return { ...attempt, outcome: { status: "invalid", reason: reasonOf(error) } };
  }
}

export function proposeAlignmentSemantics(
  input: SourceSemanticAlignmentProposalInput,
  injected?: Readonly<{ rawJson: string }>
): SourceSemanticAlignmentProposalResult {
  const request = buildSourceSemanticAlignmentRequest(input);
  if (injected === undefined) {
    return { outcome: { status: "unexercised" }, provider_attempts: 0, request };
  }
  return receiveAlignmentSemantics(injected.rawJson, request);
}

export function receiveAlignmentSemantics(
  rawJson: string, request: SourceSemanticAlignmentRequest
): SourceSemanticAlignmentProposalResult {
  const attempt = bindAttempt(rawJson, request);
  const bounded = boundRawJson(rawJson, request.resource_limits.output_byte_limit, attempt);
  if (bounded !== undefined) return bounded;
  const parsed = parseResponseJson(rawJson, attempt);
  if (parsed.status !== "ok") return parsed.result;
  const envelope = alignmentResponseSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return { ...attempt, outcome: { status: "invalid", reason: "malformed_response" } };
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
    if (alignment.q_id !== sourceSemanticQueryIdentity(request.admitted_q, semanticSha256)) {
      return { ...attempt, outcome: { status: "invalid", reason: "alignment_q_mismatch" } };
    }
    if (!request.h_descriptors.some((row) => row.h_id === alignment.h_id)) {
      return { ...attempt, outcome: { status: "invalid", reason: "alignment_h_mismatch" } };
    }
    return { ...attempt, outcome: { status: "interpreted", gaps: [] }, alignment };
  } catch (error) {
    return { ...attempt, outcome: { status: "invalid", reason: reasonOf(error) } };
  }
}

/** Parses a proposed Q. Core `admitSourceSemanticQuery` is the admission owner. */
export function parseSourceSemanticQueryProposal(input: Readonly<{
  original_query: string; request: SourceSemanticQueryRequest; query: SourceSemanticQuery;
}>): SourceSemanticQuery {
  void input.original_query;
  return SourceSemanticQuerySchema.parse(input.query);
}

function admitInterpretedDraft(
  draft: SourceSemanticDraft, request: SourceSemanticRequest, input: SourceSemanticProposalInput,
  attempt: Attempt<SourceSemanticRequest>
): SourceSemanticProposalResult {
  const limits = request.source_request.resource_limits;
  const normalized = normalizeSourceSemantics({
    draft, catalog: request.source_catalog, sha256: semanticSha256,
    source: {
      source_id: input.source_id, source_version: input.source_version,
      content_digest: `sha256:${semanticSha256(input.sourceCorpus)}`
    },
    producer_id: request.source_request.producer_capability.producer_id,
    producer_version: request.source_request.producer_capability.producer_version,
    contract_version: SOURCE_SEMANTIC_PACKET_CONTRACT,
    ...(limits.work_units !== undefined && limits.memory_bytes !== undefined
      ? { budget: { work_units: limits.work_units, memory_bytes: limits.memory_bytes } } : {})
  });
  if (normalized.status === "resource_exhausted") return { ...attempt, outcome: { status: "resource_exhausted" }, draft };
  if (normalized.status !== "normalized") {
    return { ...attempt, outcome: { status: "invalid", reason: normalized.reason }, draft };
  }
  return {
    ...attempt, outcome: { status: "interpreted", gaps: draft.gaps }, draft,
    interpretation: normalized.interpretation
  };
}

function bindSource(request: SourceSemanticRequest, input: SourceSemanticProposalInput): void {
  if (semanticSha256(input.sourceCorpus) !== request.source_catalog.source_digest) {
    throw new AlayaError("CONFLICT", "source semantic source generation mismatch");
  }
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const truncated = /end of JSON|Unterminated string|Unexpected end|Expected ',' or '\}'|Expected property name/iu.test(message);
    return { status: "fail", result: { ...attempt, outcome: truncated
      ? { status: "truncated" } : { status: "invalid", reason: "malformed_json" } } };
  }
}

function materializeQuery(body: unknown, request: SourceSemanticQueryRequest): SourceSemanticQuery {
  const record = asRecord(body);
  return SourceSemanticQuerySchema.parse({
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT,
    original_query_digest: request.original_query_digest,
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version,
    contract_version: SOURCE_SEMANTIC_QUERY_CONTRACT,
    variables: record.variables, alternatives: record.alternatives,
    return_variables: record.return_variables, gaps: record.gaps ?? []
  });
}

function materializeAlignment(body: unknown, request: SourceSemanticAlignmentRequest): unknown {
  const record = asRecord(body);
  const h_id = typeof record.h_id === "string" ? record.h_id : singleHId(request.h_descriptors);
  return {
    contract: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
    h_id,
    q_id: sourceSemanticQueryIdentity(request.admitted_q, semanticSha256),
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version,
    contract_version: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
    correspondences: record.correspondences
  };
}

function singleHId(descriptors: readonly SourceSemanticHDescriptor[]): string {
  if (descriptors.length !== 1) throw new AlayaError("VALIDATION", "alignment requires an h_id among the descriptors");
  return descriptors[0]!.h_id;
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

const queryResponseSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_QUERY_RESPONSE_CONTRACT),
  outcome: SourceSemanticOutcomeSchema,
  query: z.unknown().optional()
}).strict().readonly();

const alignmentResponseSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_ALIGNMENT_RESPONSE_CONTRACT),
  outcome: SourceSemanticOutcomeSchema,
  alignment: z.unknown().optional()
}).strict().readonly();
