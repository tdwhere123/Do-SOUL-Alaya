import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { inspectProviderChatCompletionResponse, MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES,
  type ProviderHttpResponseEvidence } from "@do-soul/alaya-engine-gateway";
import { decodeGeminiGenerateContent, isGeminiGenerateContentProfile,
  parseGeminiGenerateContentBody } from "./batch/native-codec.js";
import {
  boundedArtifactEntryExists,
  readBoundedCanonicalUtf8Artifact
} from "../cache-audit/bounded-artifact-reader.js";
import { writeBytesExclusiveDurable } from "./manifest/durable-exclusive-publication.js";
import { assertExtractionAttemptReservation, type ExtractionAttemptLedgerSnapshot } from "../authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../authority/attempt-ledger/outcome.js";
import { BENCH_TRANSPORT_FAILURE_KINDS, BENCH_TRANSPORT_FAILURE_PHASES, BENCH_TERMINAL_RETRY_CLASSIFICATIONS,
  type BenchTransportFailureAttempt, type BenchTerminalRetryClassification } from "../../compile-seed/compile-seed-types.js";

export const PROVIDER_RAW_ATTEMPT_CONTRACT = "provider-raw-attempt-v2" as const;
const PROPOSAL_RAW_ATTEMPT_CONTRACT = "semantic-proposal-raw-attempt-v1" as const;
const STEP_PROVIDER_RAW_ATTEMPT_CONTRACT = "provider-raw-attempt-v3" as const;
const STEP_PROPOSAL_RAW_ATTEMPT_CONTRACT = "semantic-proposal-raw-attempt-v2" as const;
const MAX_RETAINED_RAW_BYTES = 1024 * 1024;
const MAX_RETAINED_RESPONSE_BODY_BYTES = MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES;
// JSON can expand each retained byte to six ASCII bytes. A split UTF-8 code point
// can add two bytes per retained string. The envelope reserve is not a schema
// field limit: metadata is variable, so publication also checks actual bytes.
const MAX_RECORD_ENVELOPE_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 6 * (MAX_RETAINED_RAW_BYTES + 2 + MAX_RETAINED_RESPONSE_BODY_BYTES + 2)
  + MAX_RECORD_ENVELOPE_BYTES;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional()
}).strict();

const HttpResponseSchema = z.object({
  contentType: z.string().nullable(), bodyBase64: z.string(),
  bodyByteLength: z.number().int().nonnegative(), bodySha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bodyTruncated: z.boolean(), bodyComplete: z.boolean()
}).strict();

const RawAttemptFields = {
  cache_key: z.string().regex(/^[0-9a-f]{64}$/u),
  attempt_ordinal: z.number().int().positive(),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  request_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  decoded_text: z.string(),
  decoded_text_truncated: z.boolean(),
  original_byte_length: z.number().int().nonnegative(),
  decoded_text_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  full_replay_possible: z.boolean(),
  finish_reason: z.string().nullable(),
  completion_witness: z.literal("finish_reason").nullable(),
  usage: UsageSchema.nullable(),
  usage_known: z.boolean(),
  transport_phase: z.string().nullable(),
  failure_retryable: z.boolean().optional(),
  failure_classification: z.enum(BENCH_TERMINAL_RETRY_CLASSIFICATIONS).optional(),
  transport_failure: z.object({
    kind: z.enum(BENCH_TRANSPORT_FAILURE_KINDS),
    phase: z.enum(BENCH_TRANSPORT_FAILURE_PHASES),
    httpStatus: z.number().nullable(), fingerprint: z.string(), attempt: z.number().int().positive(),
    usage: UsageSchema.optional()
  }).strict().optional(),
  response_body: z.object({
    text: z.string(), truncated: z.boolean(), original_byte_length: z.number().int().nonnegative(), digest: z.string()
  }).strict().optional(),
  http_response: HttpResponseSchema.optional(),
  extracted_at: z.string().min(1)
};
const SourceAuthorityFields = {
  authority_receipt_digest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  authority_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  source_request_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional()
};
// Source extraction retains its unchanged raw contract; proposal attempts require reservation ownership.
const ProviderRawAttemptSchema = z.discriminatedUnion("contract", [
  z.object({ ...RawAttemptFields, ...SourceAuthorityFields, contract: z.literal(PROVIDER_RAW_ATTEMPT_CONTRACT), kind: z.literal("source_semantic") }).strict(),
  z.object({ ...RawAttemptFields, ...SourceAuthorityFields, contract: z.literal(STEP_PROVIDER_RAW_ATTEMPT_CONTRACT), kind: z.literal("source_semantic") }).strict(),
  z.object({ ...RawAttemptFields, contract: z.literal(PROPOSAL_RAW_ATTEMPT_CONTRACT),
    kind: z.enum(["query", "semantic_correspondence"]),
    attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u)
  }).strict(),
  z.object({ ...RawAttemptFields, contract: z.literal(STEP_PROPOSAL_RAW_ATTEMPT_CONTRACT),
    kind: z.enum(["query", "semantic_correspondence"]),
    attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u)
  }).strict()
]);

export type ProviderRawAttempt = z.infer<typeof ProviderRawAttemptSchema>;

export function providerRawAttemptPath(root: string, key: string, ordinal: number): string {
  return join(root, "provider-raw", key.slice(0, 2), `${key}.${ordinal}.json`);
}

export function providerRawAttemptInputPaths(root: string, key: string): readonly string[] {
  const directory = join(root, "provider-raw", key.slice(0, 2));
  try {
    return [directory, ...matchingRawAttemptNames(directory, key).map(name => join(directory, name))];
  } catch {
    // The directory is still a known input when its entries cannot be listed.
    return [directory];
  }
}

function matchingRawAttemptNames(directory: string, key: string): readonly string[] {
  if (!boundedArtifactEntryExists(directory)) return [];
  return readdirSync(directory).filter(name => name.startsWith(`${key}.`) && name.endsWith(".json"));
}

export function listProviderRawAttempts(root: string, key: string): readonly ProviderRawAttempt[] {
  const directory = join(root, "provider-raw", key.slice(0, 2));
  return matchingRawAttemptNames(directory, key)
    .map((name) => {
      const ordinal = Number(name.slice(key.length + 1, -5));
      const record = readProviderRawAttempt(root, key, ordinal);
      if (record === undefined) throw new AlayaError("CONFLICT", `provider raw attempt missing after listing: ${name}`);
      return record;
    })
    .sort((left, right) => left.attempt_ordinal - right.attempt_ordinal);
}

export class ProviderRawAttemptIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRawAttemptIdentityError";
  }
}

type RawAttemptOwner =
  | { kind: "source_semantic"; attemptLineageDigest?: never;
    authorityReceiptDigest?: string; authorityLineageDigest?: string; sourceRequestSha256?: string }
  | { kind: "query" | "semantic_correspondence"; attemptLineageDigest: string };

export function bindProviderRawAttempt(
  raw: ProviderRawAttempt,
  expected: Readonly<{
    cacheKey: string;
    model: string;
    requestProfile: string;
    requestDigest: string;
  } & RawAttemptOwner>
): ProviderRawAttempt {
  assertProviderRawIntegrity(raw);
  const step = expected.requestProfile === "step-3.5-2603-low-json-schema-v1";
  if (step !== (raw.contract === STEP_PROVIDER_RAW_ATTEMPT_CONTRACT ||
      raw.contract === STEP_PROPOSAL_RAW_ATTEMPT_CONTRACT)) {
    throw new ProviderRawAttemptIdentityError(`provider raw attempt contract/profile mismatch: ${expected.cacheKey}`);
  }
  if (raw.cache_key !== expected.cacheKey || raw.kind !== expected.kind ||
      raw.model !== expected.model || raw.request_profile !== expected.requestProfile ||
      raw.request_digest !== expected.requestDigest ||
      raw.kind === "source_semantic" && expected.kind === "source_semantic" &&
        (expected.authorityReceiptDigest !== undefined && raw.authority_receipt_digest !== expected.authorityReceiptDigest ||
         expected.authorityLineageDigest !== undefined && raw.authority_lineage_digest !== expected.authorityLineageDigest ||
         expected.sourceRequestSha256 !== undefined && raw.source_request_sha256 !== expected.sourceRequestSha256) ||
      raw.kind !== "source_semantic" && raw.attempt_lineage_digest !== expected.attemptLineageDigest) {
    throw new ProviderRawAttemptIdentityError(
      `provider raw attempt identity mismatch: ${expected.cacheKey}`
    );
  }
  return raw;
}

/** A settled source rejection remains final even if admission is attempted again. */
export function verifyProviderRawReservation(
  raw: ProviderRawAttempt, ledger: ExtractionAttemptLedgerSnapshot | undefined,
  purpose: "executable" | "accounting" = "executable"
): "rejected" | undefined {
  assertExtractionAttemptReservation(ledger, raw.cache_key, raw.attempt_ordinal);
  const failure = ledger?.transportFailures.find(attempt => attempt.attemptOrdinal === raw.attempt_ordinal);
  const settlement = ledger?.settledAttempts.find(attempt => attempt.attemptOrdinal === raw.attempt_ordinal);
  const settled = settlement !== undefined;
  // Source admission records a completed but rejected response with its raw digest.
  // It is not a failed HTTP response and must remain replayable as quarantine.
  const sourceRejection = raw.kind === "source_semantic" && raw.transport_failure === undefined &&
    failure?.kind === "response_schema_error" && failure.phase === "response_schema" &&
    failure.httpStatus === null && failure.fingerprint === raw.decoded_text_digest;
  if (failure !== undefined && !sourceRejection && (raw.transport_failure === undefined ||
      failure.kind !== raw.transport_failure.kind || failure.phase !== raw.transport_failure.phase ||
      failure.httpStatus !== raw.transport_failure.httpStatus || failure.fingerprint !== raw.transport_failure.fingerprint) ||
      settled && failure === undefined && raw.transport_failure !== undefined) {
    throw new ProviderRawAttemptIdentityError("provider raw differs from its settled transport outcome");
  }
  if (settlement?.usageSha256 !== undefined &&
      settlement.usageSha256 !== settledAttemptUsageDigest(raw.usage)) {
    throw new ProviderRawAttemptIdentityError("provider raw usage differs from its exact settled attempt");
  }
  // Old ledgers remain readable for attempt accounting. A completed response cannot
  // regain execution authority when its independent settlement witness is absent.
  if (purpose === "executable" && settled && settlement.usageSha256 === undefined &&
      raw.transport_failure === undefined && raw.full_replay_possible &&
      providerRawSuccessEvidenceState(raw) === "bound") {
    throw new ProviderRawAttemptIdentityError("provider raw lacks its exact settled usage witness");
  }
  return sourceRejection ? "rejected" : undefined;
}

/** Retained raw remains readable for accounting even when no complete response can be executed. */
export function providerRawSuccessEvidenceState(
  raw: ProviderRawAttempt
): "bound" | "missing" | "truncated" | "failed" | "unsupported" {
  if (raw.transport_failure !== undefined) return "failed";
  if (raw.request_profile === "step-3.5-2603-low-json-schema-v1") {
    if (raw.http_response === undefined) return "missing";
    return raw.http_response.bodyTruncated || !raw.http_response.bodyComplete ? "truncated" : "bound";
  }
  if (!isGeminiGenerateContentProfile(raw.request_profile)) return "unsupported";
  if (raw.response_body === undefined) return "missing";
  return raw.response_body.truncated ? "truncated" : "bound";
}

export function readProviderRawAttempt(
  root: string, key: string, ordinal: number
): ProviderRawAttempt | undefined {
  const path = providerRawAttemptPath(root, key, ordinal);
  if (!boundedArtifactEntryExists(path)) return undefined;
  const text = readBoundedCanonicalUtf8Artifact({ path, maxBytes: MAX_RECORD_BYTES, label: "provider raw attempt" });
  let record: ProviderRawAttempt;
  try { record = ProviderRawAttemptSchema.parse(JSON.parse(text)); }
  catch { throw new ProviderRawAttemptIdentityError(`provider raw attempt is malformed: ${key}`); }
  if (record.cache_key !== key || record.attempt_ordinal !== ordinal) {
    throw new ProviderRawAttemptIdentityError(`provider raw attempt identity mismatch: ${key}`);
  }
  assertProviderRawIntegrity(record);
  return record;
}

function assertProviderRawIntegrity(raw: ProviderRawAttempt): void {
  const bytes = Buffer.from(raw.decoded_text, "utf8");
  const complete = !raw.decoded_text_truncated;
  const body = raw.response_body;
  const http = raw.http_response;
  const httpBytes = http === undefined ? undefined : Buffer.from(http.bodyBase64, "base64");
  if (raw.full_replay_possible !== complete ||
      raw.usage_known !== (raw.usage !== null) ||
      raw.completion_witness !== (raw.finish_reason === null ? null : "finish_reason") ||
      complete && (bytes.length > MAX_RETAINED_RAW_BYTES || raw.original_byte_length !== bytes.length ||
        raw.decoded_text_digest !== createHash("sha256").update(bytes).digest("hex")) ||
      !complete && (raw.original_byte_length <= MAX_RETAINED_RAW_BYTES || bytes.length > MAX_RETAINED_RAW_BYTES + 2) ||
      body !== undefined && (!body.truncated && (body.original_byte_length > MAX_RETAINED_RESPONSE_BODY_BYTES ||
        Buffer.byteLength(body.text, "utf8") !== body.original_byte_length ||
        createHash("sha256").update(body.text, "utf8").digest("hex") !== body.digest) ||
        body.truncated && (body.original_byte_length <= MAX_RETAINED_RESPONSE_BODY_BYTES ||
          Buffer.byteLength(body.text, "utf8") > MAX_RETAINED_RESPONSE_BODY_BYTES + 2)) ||
      http !== undefined && (httpBytes === undefined ||
        httpBytes.toString("base64") !== http.bodyBase64 ||
        httpBytes.length > MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES ||
        http.bodyTruncated !== (http.bodyByteLength > MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) ||
        !http.bodyTruncated && (httpBytes.length !== http.bodyByteLength ||
          createHash("sha256").update(httpBytes).digest("hex") !== http.bodySha256)) ||
      raw.request_profile === "step-3.5-2603-low-json-schema-v1" &&
        (raw.contract !== STEP_PROVIDER_RAW_ATTEMPT_CONTRACT && raw.contract !== STEP_PROPOSAL_RAW_ATTEMPT_CONTRACT ||
         body !== undefined || raw.transport_failure === undefined &&
           (http === undefined || !http.bodyComplete)) ||
      raw.request_profile !== "step-3.5-2603-low-json-schema-v1" && http !== undefined) {
    throw new ProviderRawAttemptIdentityError(`provider raw attempt integrity mismatch: ${raw.cache_key}`);
  }
  assertCompletePhysicalResponse(raw, httpBytes);
}

function assertCompletePhysicalResponse(raw: ProviderRawAttempt, httpBytes: Buffer | undefined): void {
  // A failed HTTP or parse attempt retains its original failure state; only a completed
  // provider result may claim that normalized text, finish and usage came from these bytes.
  if (raw.transport_failure !== undefined) return;
  let decoded: { text: string; finishReason: string | null; usage?: unknown } | undefined;
  try {
    if (raw.request_profile === "step-3.5-2603-low-json-schema-v1") {
      const http = raw.http_response;
      if (http?.bodyComplete && !http.bodyTruncated && httpBytes !== undefined) {
        decoded = inspectProviderChatCompletionResponse(httpBytes.toString("utf8"), http.contentType, 200,
          { sseCompletionPolicy: "require_witness" });
      }
    } else if (isGeminiGenerateContentProfile(raw.request_profile) &&
        raw.response_body !== undefined && !raw.response_body.truncated) {
      const result = decodeGeminiGenerateContent(parseGeminiGenerateContentBody(raw.response_body.text));
      decoded = { text: result.rawJson, finishReason: result.responseMetadata.finishReason, usage: result.usage };
    }
  } catch {
    throw new ProviderRawAttemptIdentityError(`provider physical response cannot be decoded: ${raw.cache_key}`);
  }
  if (decoded === undefined) return;
  const bytes = Buffer.from(decoded.text, "utf8");
  if (bytes.length !== raw.original_byte_length ||
      createHash("sha256").update(bytes).digest("hex") !== raw.decoded_text_digest ||
      raw.full_replay_possible && decoded.text !== raw.decoded_text ||
      decoded.finishReason !== raw.finish_reason ||
      canonicalJson(decoded.usage ?? null) !== canonicalJson(raw.usage)) {
    throw new ProviderRawAttemptIdentityError(`provider physical response differs from decoded attempt: ${raw.cache_key}`);
  }
}

export function writeProviderRawAttempt(input: Readonly<{
  root: string;
  cacheKey: string;
  attemptOrdinal: number;
  model: string;
  requestProfile: string;
  requestDigest: string;
  decodedText: string;
  finishReason: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  transportPhase?: string;
  transportFailure?: BenchTransportFailureAttempt;
  failureRetryable?: boolean;
  failureClassification?: BenchTerminalRetryClassification;
  responseBody?: string;
  httpResponse?: ProviderHttpResponseEvidence;
} & RawAttemptOwner>): ProviderRawAttempt {
  const original = Buffer.from(input.decodedText, "utf8");
  const truncated = original.byteLength > MAX_RETAINED_RAW_BYTES;
  const retained = truncated ? original.subarray(0, MAX_RETAINED_RAW_BYTES).toString("utf8") : input.decodedText;
  const record = ProviderRawAttemptSchema.parse({
    contract: input.requestProfile === "step-3.5-2603-low-json-schema-v1"
      ? input.kind === "source_semantic" ? STEP_PROVIDER_RAW_ATTEMPT_CONTRACT : STEP_PROPOSAL_RAW_ATTEMPT_CONTRACT
      : input.kind === "source_semantic" ? PROVIDER_RAW_ATTEMPT_CONTRACT : PROPOSAL_RAW_ATTEMPT_CONTRACT,
    ...(input.kind === "source_semantic" ? {} : { attempt_lineage_digest: input.attemptLineageDigest }),
    ...(input.kind !== "source_semantic" || input.authorityReceiptDigest === undefined ? {} : {
      authority_receipt_digest: input.authorityReceiptDigest
    }),
    ...(input.kind !== "source_semantic" || input.authorityLineageDigest === undefined ? {} : {
      authority_lineage_digest: input.authorityLineageDigest
    }),
    ...(input.kind !== "source_semantic" || input.sourceRequestSha256 === undefined ? {} : {
      source_request_sha256: input.sourceRequestSha256
    }),
    cache_key: input.cacheKey,
    attempt_ordinal: input.attemptOrdinal,
    kind: input.kind,
    model: input.model,
    request_profile: input.requestProfile,
    request_digest: input.requestDigest,
    decoded_text: retained,
    decoded_text_truncated: truncated,
    original_byte_length: original.byteLength,
    decoded_text_digest: createHash("sha256").update(original).digest("hex"),
    full_replay_possible: !truncated,
    finish_reason: input.finishReason,
    completion_witness: input.finishReason === null ? null : "finish_reason",
    usage: input.usage ?? null,
    usage_known: input.usage !== undefined,
    transport_phase: input.transportPhase ?? "response_schema",
    ...(input.transportFailure === undefined ? {} : { transport_failure: input.transportFailure }),
    ...(input.failureRetryable === undefined ? {} : { failure_retryable: input.failureRetryable }),
    ...(input.failureClassification === undefined ? {} : { failure_classification: input.failureClassification }),
    ...(input.responseBody === undefined ? {} : { response_body: retainResponseBody(input.responseBody) }),
    ...(input.httpResponse === undefined ? {} : { http_response: input.httpResponse }),
    extracted_at: new Date().toISOString()
  });
  assertProviderRawIntegrity(record);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new ProviderRawAttemptIdentityError("provider raw attempt exceeds its size limit");
  }
  const path = providerRawAttemptPath(input.root, input.cacheKey, input.attemptOrdinal);
  mkdirSync(dirname(path), { recursive: true });
  writeBytesExclusiveDurable(path, bytes);
  return record;
}

function retainResponseBody(text: string) {
  const bytes = Buffer.from(text, "utf8");
  const cap = MAX_RETAINED_RESPONSE_BODY_BYTES;
  return { text: bytes.subarray(0, cap).toString("utf8"), truncated: bytes.length > cap,
    original_byte_length: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
}

export function retainedFailureOutcome(raw: ProviderRawAttempt) {
  if (raw.transport_failure === undefined) return undefined;
  return {
    retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 0,
    terminalRetryClassification: raw.failure_classification ?? "failure_non_retryable_response" as const,
    transportFailures: [raw.transport_failure], usageRequestCount: raw.usage_known ? 1 : 0,
    ...(raw.usage === null ? {} : { usage: raw.usage })
  };
}

export function requestEnvelopeDigest(requestJson: string): string {
  return createHash("sha256").update(requestJson, "utf8").digest("hex");
}
