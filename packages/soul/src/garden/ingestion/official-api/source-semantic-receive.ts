import { z } from "zod";
import {
  AlayaError, SOURCE_SEMANTIC_PACKET_CONTRACT,
  SourceSemanticCorrespondenceSchema,
  SourceSemanticGapSchema, SourceSemanticOutcomeSchema,
  SourceSemanticQueryGapSchema, SourceSemanticQueryOutcomeGapBindingSchema,
  SourceSemanticQuerySchema, SourceSemanticCorrespondenceAssessmentSchema, materializeSourceSemanticQueryMeaning,
  expandSourceSemanticQueryCarrier,
  materializeSourceSemanticCorrespondenceAssessment,
  SourceSemanticOutcomeGapBindingSchema, sourceSemanticValidationDiagnostics,
  SourceSemanticInterpretationSchema,
  materializeSourceSemanticTableProposal,
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  normalizeSourceSemantics, sourceSemanticQueryIdentity,
  verifySourceSemanticDisposition, canonicalJson,
  type SourceSemanticCorrespondence, type SourceSemanticCorrespondenceAssessment, type SourceSemanticDraft,
  type SourceSemanticInterpretation,
  type SourceSemanticOutcome, type SourceSemanticQuery,
  type SourceSemanticQueryOutcome
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
  buildSourceSemanticCorrespondenceRequest, buildSourceSemanticQueryRequest, buildSourceSemanticRequest,
  parseSourceSemanticRequest, sourceSemanticRequestCatalog, semanticSha256, rejectForbiddenProposalInput,
  type SourceSemanticCorrespondenceProposalInput, type SourceSemanticCorrespondenceRequest,
  type SourceInterpretationDescriptor, type SourceSemanticProposalInput, type SourceSemanticQueryProposalInput,
  type SourceSemanticQueryRequest, type SourceSemanticRequest
} from "./source-semantic-request.js";

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
  outcome: SourceSemanticQueryOutcome;
  provider_attempts: 0 | 1;
  request: SourceSemanticQueryRequest;
  query?: SourceSemanticQuery;
  raw_response_id?: string;
  rawJson?: string;
}>;

export type SourceSemanticCorrespondenceProposalResult = Readonly<{
  system_prompt: string;
  outcome: SourceSemanticOutcome;
  provider_attempts: 0 | 1;
  request: SourceSemanticCorrespondenceRequest;
  semantic_correspondence?: SourceSemanticCorrespondence;
  assessment?: SourceSemanticCorrespondenceAssessment;
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
  const result = decodeSourceSemantics(rawJson, request, input);
  if (result.interpretation === undefined) {
    const { interpretation: _absent, ...withoutInterpretation } = result;
    return withoutInterpretation;
  }
  return { ...result, interpretation: SourceSemanticInterpretationSchema.parse(result.interpretation) };
}

function decodeSourceSemantics(
  rawJson: string, request: SourceSemanticRequest, input: SourceSemanticProposalInput
): SourceSemanticProposalResult {
  const attempt = bindAttempt(rawJson, request);
  const bounded = boundRawJson(rawJson, request.source_request.resource_limits.output_byte_limit, attempt);
  if (bounded !== undefined) return bounded;
  bindSource(request, input);
  const parsed = parseResponseJson(rawJson, attempt);
  if (parsed.status !== "ok") return parsed.result;
  const limits = request.source_request.resource_limits;
  const meter = new SourceSemanticResourceLedger({
    work_units: limits.work_units ?? 200000, memory_bytes: limits.memory_bytes ?? 20000000
  });
  let envelope: ReturnType<typeof materializeSourceSemanticTableProposal>;
  try {
    envelope = materializeSourceSemanticTableProposal(parsed.value,
      { catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256 }, meter);
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return { ...attempt, outcome: { status: "resource_exhausted" } };
    return { ...attempt, outcome: invalidProposalOutcome(error) };
  }
  const { outcome, draft } = envelope;
  if (HOST_ONLY_OUTCOMES.has(outcome.status)) {
    return { ...attempt, outcome: { status: "invalid", reason: "host_only_outcome" } };
  }
  if (outcome.status === "no_executable_proposition") {
    try { return { ...attempt, outcome: verifySourceSemanticDisposition(outcome, sourceSemanticRequestCatalog(request), semanticSha256) }; }
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
  const envelope = QueryMeaningResponseSchema.safeParse(parsed.value);
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
    const meter = new SourceSemanticResourceLedger({
      work_units: request.resource_limits.work_units ?? 200000,
      memory_bytes: request.resource_limits.memory_bytes ?? 20000000
    });
    meter.retain(envelope.data.outcome, "query response outcome");
    const query = parseQuery({ original_query: request.original_query, request,
      query: materializeQuery(envelope.data.query, request, meter) });
    meter.retain(query, "query receive result");
    if (canonicalJson(query.approved_fixed_context) !== canonicalJson(request.approved_fixed_context ?? null) ||
        canonicalJson(query.attribution_context) !== canonicalJson(request.attribution_context)) {
      return { ...attempt, outcome: { status: "invalid", reason: "query_context_mismatch" } };
    }
    const reportedGaps = envelope.data.outcome.gaps;
    if (reportedGaps !== undefined) {
      SourceSemanticQueryOutcomeGapBindingSchema.parse({
        outcome: { status: "interpreted", gaps: reportedGaps }, gaps: query.gaps
      });
    }
    if (query.original_query_digest !== request.original_query_digest) {
      return { ...attempt, outcome: { status: "invalid", reason: "query_digest_mismatch" } };
    }
    return { ...attempt, outcome: { status: "interpreted", gaps: query.gaps }, query };
  } catch (error) {
    if (error instanceof SourceSemanticResourceExhausted) return { ...attempt, outcome: { status: "resource_exhausted" } };
    return { ...attempt, outcome: invalidProposalOutcome(error) };
  }
}

export function proposeCorrespondenceSemantics(
  input: SourceSemanticCorrespondenceProposalInput,
  injected?: Readonly<{ rawJson: string }>
): SourceSemanticCorrespondenceProposalResult {
  const request = buildSourceSemanticCorrespondenceRequest(input);
  if (injected === undefined) {
    return { outcome: { status: "unexercised" }, provider_attempts: 0, request,
      system_prompt: SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT };
  }
  return { ...receiveCorrespondenceSemantics(injected.rawJson, request), system_prompt: SOURCE_SEMANTIC_CORRESPONDENCE_SYSTEM_PROMPT };
}

function receiveCorrespondenceSemantics(
  rawJson: string, request: SourceSemanticCorrespondenceRequest
): Omit<SourceSemanticCorrespondenceProposalResult, "system_prompt"> {
  const attempt = bindAttempt(rawJson, request);
  const bounded = boundRawJson(rawJson, request.resource_limits.output_byte_limit, attempt);
  if (bounded !== undefined) return bounded;
  const parsed = parseResponseJson(rawJson, attempt);
  if (parsed.status !== "ok") return parsed.result;
  const envelope = CorrespondenceAssessmentResponseSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return { ...attempt, outcome: invalidSchemaOutcome(envelope.error) };
  }
  if (HOST_ONLY_OUTCOMES.has(envelope.data.outcome.status)) {
    return { ...attempt, outcome: { status: "invalid", reason: "host_only_outcome" } };
  }
  if (envelope.data.outcome.status !== "interpreted") return { ...attempt, outcome: envelope.data.outcome };
  if (envelope.data.semantic_correspondence === undefined) {
    return { ...attempt, outcome: { status: "invalid", reason: "interpreted_correspondence_required" } };
  }
  try {
    const semantic_correspondence = SourceSemanticCorrespondenceSchema.parse(materializeCorrespondence(envelope.data.semantic_correspondence, request));
    const assessment = SourceSemanticCorrespondenceAssessmentSchema.parse(envelope.data.semantic_correspondence);
    SourceSemanticOutcomeGapBindingSchema.parse({
      outcome: { status: "interpreted", gaps: envelope.data.outcome.gaps ?? [] }, gaps: []
    });
    if (semantic_correspondence.query_semantics_id !== sourceSemanticQueryIdentity(request.admitted_query_semantics, semanticSha256)) {
      return { ...attempt, outcome: { status: "invalid", reason: "correspondence_query_semantics_mismatch" } };
    }
    if (!request.source_interpretation_descriptors.some((row) => row.source_interpretation_id === semantic_correspondence.source_interpretation_id)) {
      return { ...attempt, outcome: { status: "invalid", reason: "correspondence_source_interpretation_mismatch" } };
    }
    return { ...attempt, outcome: { status: "interpreted", gaps: [] }, semantic_correspondence, assessment };
  } catch (error) {
    return { ...attempt, outcome: invalidProposalOutcome(error) };
  }
}

/** Parses proposed query semantics. Core `admitSourceSemanticQuery` is the admission owner. */
function parseSourceSemanticQueryProposal(input: Readonly<{
  original_query: string; request: SourceSemanticQueryRequest; query: SourceSemanticQuery;
}>): SourceSemanticQuery {
  void input.original_query;
  return SourceSemanticQuerySchema.parse(input.query);
}

function admitInterpretedDraft(
  draft: SourceSemanticDraft, request: SourceSemanticRequest, input: SourceSemanticProposalInput,
  attempt: Attempt<SourceSemanticRequest>, meter: SourceSemanticResourceLedger
): SourceSemanticProposalResult {
  const limits = request.source_request.resource_limits;
  const normalization = {
    draft, catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256,
    source: {
      source_id: input.source_id, source_version: input.source_version,
      content_digest: `sha256:${semanticSha256(input.sourceCorpus)}`,
      attribution_context: request.source_request.attribution_context,
      assertion_locations: request.source_request.assertion_locations
    },
    producer_id: request.source_request.producer_capability.producer_id,
    producer_version: request.source_request.producer_capability.producer_version,
    contract_version: SOURCE_SEMANTIC_PACKET_CONTRACT,
    normalizer_version: request.source_request.normalizer_version,
    meter,
    ...(limits.work_units !== undefined && limits.memory_bytes !== undefined
      ? { budget: { work_units: limits.work_units, memory_bytes: limits.memory_bytes } } : {})
  };
  const normalized = normalizeSourceSemantics(normalization);
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
  const expected = buildSourceSemanticRequest({ ...input, assertionIds: ids, sourceScope: request.source_request.source_scope });
  if (canonicalJson(sourceSemanticRequestCatalog(expected)) !== canonicalJson(sourceSemanticRequestCatalog(request)) ||
    canonicalJson(expected.source_request.source_assertions) !== canonicalJson(request.source_request.source_assertions) ||
    canonicalJson(expected.source_request.attribution_context) !== canonicalJson(request.source_request.attribution_context) ||
    canonicalJson(expected.source_request.assertion_locations) !== canonicalJson(request.source_request.assertion_locations)) {
    throw new AlayaError("CONFLICT", "source semantic assertion locations differ from the source owner");
  }
  if (semanticSha256(input.sourceCorpus) !== sourceSemanticRequestCatalog(request).source_digest) {
    throw new AlayaError("CONFLICT", "source semantic source generation mismatch");
  }
}

function bindAttempt<T>(rawJson: string, request: T): Attempt<T> {
  return { provider_attempts: 1, request, raw_response_id: `sha256:${semanticSha256(rawJson)}`, rawJson };
}

function boundRawJson<T>(rawJson: string, requestLimit: number, attempt: Attempt<T>):
  (Attempt<T> & { outcome: Exclude<SourceSemanticOutcome, { status: "interpreted" }> }) | undefined {
  const limit = Math.min(MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, requestLimit);
  if (Buffer.byteLength(rawJson, "utf8") > limit) return { ...attempt, outcome: { status: "truncated" } };
  if (rawJson.length === 0) return { ...attempt, outcome: { status: "transport_failure" } };
  return undefined;
}

function parseResponseJson<T>(rawJson: string, attempt: Attempt<T>):
  { status: "ok"; value: unknown } | { status: "fail"; result: Attempt<T> & { outcome: Exclude<SourceSemanticOutcome, { status: "interpreted" }> } } {
  try {
    return { status: "ok", value: JSON.parse(rawJson) };
  } catch {
    return { status: "fail", result: { ...attempt, outcome: { status: "invalid", reason: "malformed_json" } } };
  }
}

function materializeQuery(
  body: unknown, request: SourceSemanticQueryRequest, meter: SourceSemanticResourceLedger
): SourceSemanticQuery {
  const record = asRecord(body);
  rejectForbiddenProposalInput(record);
  const envelope = {
    original_query: request.original_query,
    original_query_digest: request.original_query_digest,
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version,
    approved_fixed_context: request.approved_fixed_context ?? null,
    attribution_context: request.attribution_context
  };
  return materializeSourceSemanticQueryMeaning(
    expandSourceSemanticQueryCarrier(record, request.resource_limits, meter), envelope, meter
  );
}

function materializeCorrespondence(body: unknown, request: SourceSemanticCorrespondenceRequest): unknown {
  const record = asRecord(body);
  rejectForbiddenProposalInput(record);
  const parsed = z.object({ source_interpretation_handle: z.string() }).passthrough().parse(record);
  return materializeSourceSemanticCorrespondenceAssessment(record, request.catalog, {
    original_query: request.original_query,
    source_interpretation_id: bindCorrespondenceHandle(parsed.source_interpretation_handle, request.source_interpretation_descriptors),
    query_semantics_id: sourceSemanticQueryIdentity(request.admitted_query_semantics, semanticSha256),
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version
  });
}

function bindCorrespondenceHandle(handle: string, descriptors: readonly SourceInterpretationDescriptor[]): string {
  const match = /^source([1-9][0-9]{0,2})$/u.exec(handle);
  const descriptor = match === null ? undefined : descriptors[Number(match[1]) - 1];
  if (descriptor === undefined) {
    throw new AlayaError("VALIDATION", "semantic_correspondence handle does not name a supplied descriptor");
  }
  return descriptor.source_interpretation_id;
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

function invalidSchemaOutcome(error: z.ZodError): Extract<SourceSemanticOutcome, { status: "invalid" }> {
  return { status: "invalid", reason: "malformed_response", diagnostics: sourceSemanticValidationDiagnostics(error) };
}

function invalidProposalOutcome(error: unknown): Extract<SourceSemanticOutcome, { status: "invalid" }> {
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
const QueryResponseOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("interpreted"),
    gaps: z.array(SourceSemanticQueryGapSchema).max(256).readonly().optional() }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter((option) => option.unwrap().shape.status.value !== "interpreted")
]);

const QueryMeaningResponseSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT),
  outcome: QueryResponseOutcomeSchema,
  query: z.unknown().optional()
}).strict().readonly();
const CorrespondenceAssessmentResponseSchema = z.object({
  contract: z.literal(SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT),
  outcome: ProducerResponseOutcomeSchema,
  semantic_correspondence: z.unknown().optional()
}).strict().readonly();
