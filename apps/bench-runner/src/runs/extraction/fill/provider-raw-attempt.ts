import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  boundedArtifactEntryExists,
  readBoundedCanonicalUtf8Artifact
} from "../cache-audit/bounded-artifact-reader.js";
import { writeBytesExclusiveDurable } from "./manifest/durable-exclusive-publication.js";
import { assertExtractionAttemptReservation, type ExtractionAttemptLedgerSnapshot } from "../authority/attempt-ledger.js";
import { BENCH_TRANSPORT_FAILURE_KINDS, BENCH_TRANSPORT_FAILURE_PHASES, BENCH_TERMINAL_RETRY_CLASSIFICATIONS,
  type BenchTransportFailureAttempt, type BenchTerminalRetryClassification } from "../../compile-seed/compile-seed-types.js";

export const PROVIDER_RAW_ATTEMPT_CONTRACT = "provider-raw-attempt-v2" as const;
const PROPOSAL_RAW_ATTEMPT_CONTRACT = "semantic-proposal-raw-attempt-v1" as const;
const MAX_RETAINED_RAW_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
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
  extracted_at: z.string().min(1)
};
// Source extraction retains its unchanged raw contract; proposal attempts require reservation ownership.
const ProviderRawAttemptSchema = z.discriminatedUnion("kind", [
  z.object({ ...RawAttemptFields, contract: z.literal(PROVIDER_RAW_ATTEMPT_CONTRACT), kind: z.literal("source_semantic") }).strict(),
  z.object({ ...RawAttemptFields, contract: z.literal(PROPOSAL_RAW_ATTEMPT_CONTRACT),
    kind: z.enum(["query", "semantic_correspondence"]),
    attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u)
  }).strict()
]);

export type ProviderRawAttempt = z.infer<typeof ProviderRawAttemptSchema>;

export function providerRawAttemptPath(root: string, key: string, ordinal: number): string {
  return join(root, "provider-raw", key.slice(0, 2), `${key}.${ordinal}.json`);
}

export function listProviderRawAttempts(root: string, key: string): readonly ProviderRawAttempt[] {
  const directory = join(root, "provider-raw", key.slice(0, 2));
  if (!boundedArtifactEntryExists(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${key}.`) && name.endsWith(".json"))
    .map((name) => {
      const ordinal = Number(name.slice(key.length + 1, -5));
      const record = readProviderRawAttempt(root, key, ordinal);
      if (record === undefined) throw new Error(`provider raw attempt missing after listing: ${name}`);
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
  | { kind: "source_semantic"; attemptLineageDigest?: never }
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
  if (raw.cache_key !== expected.cacheKey || raw.kind !== expected.kind ||
      raw.model !== expected.model || raw.request_profile !== expected.requestProfile ||
      raw.request_digest !== expected.requestDigest ||
      raw.kind !== "source_semantic" && raw.attempt_lineage_digest !== expected.attemptLineageDigest) {
    throw new ProviderRawAttemptIdentityError(
      `provider raw attempt identity mismatch: ${expected.cacheKey}`
    );
  }
  return raw;
}

export function assertProviderRawReservation(
  raw: ProviderRawAttempt, ledger: ExtractionAttemptLedgerSnapshot | undefined
): void {
  assertExtractionAttemptReservation(ledger, raw.cache_key, raw.attempt_ordinal);
  const failure = ledger?.transportFailures.find(attempt => attempt.attemptOrdinal === raw.attempt_ordinal);
  const settled = ledger?.settledAttempts.some(attempt => attempt.attemptOrdinal === raw.attempt_ordinal);
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
  if (raw.full_replay_possible !== complete ||
      raw.usage_known !== (raw.usage !== null) ||
      raw.completion_witness !== (raw.finish_reason === null ? null : "finish_reason") ||
      complete && (bytes.length > MAX_RETAINED_RAW_BYTES || raw.original_byte_length !== bytes.length ||
        raw.decoded_text_digest !== createHash("sha256").update(bytes).digest("hex")) ||
      !complete && (raw.original_byte_length <= MAX_RETAINED_RAW_BYTES || bytes.length > MAX_RETAINED_RAW_BYTES + 2) ||
      body !== undefined && (!body.truncated && (Buffer.byteLength(body.text, "utf8") !== body.original_byte_length ||
        createHash("sha256").update(body.text, "utf8").digest("hex") !== body.digest) ||
        body.truncated && (body.original_byte_length <= 64 * 1024 || Buffer.byteLength(body.text, "utf8") > 64 * 1024 + 2))) {
    throw new ProviderRawAttemptIdentityError(`provider raw attempt integrity mismatch: ${raw.cache_key}`);
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
} & RawAttemptOwner>): ProviderRawAttempt {
  const original = Buffer.from(input.decodedText, "utf8");
  const truncated = original.byteLength > MAX_RETAINED_RAW_BYTES;
  const retained = truncated ? original.subarray(0, MAX_RETAINED_RAW_BYTES).toString("utf8") : input.decodedText;
  const record = ProviderRawAttemptSchema.parse({
    contract: input.kind === "source_semantic" ? PROVIDER_RAW_ATTEMPT_CONTRACT : PROPOSAL_RAW_ATTEMPT_CONTRACT,
    ...(input.kind === "source_semantic" ? {} : { attempt_lineage_digest: input.attemptLineageDigest }),
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
    extracted_at: new Date().toISOString()
  });
  const path = providerRawAttemptPath(input.root, input.cacheKey, input.attemptOrdinal);
  mkdirSync(dirname(path), { recursive: true });
  writeBytesExclusiveDurable(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
  return record;
}

function retainResponseBody(text: string) {
  const bytes = Buffer.from(text, "utf8");
  // Leave space for escaped JSON and decoded text in the bounded record.
  const cap = 64 * 1024;
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
