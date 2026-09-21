import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  boundedArtifactEntryExists,
  readBoundedCanonicalUtf8Artifact
} from "../cache-audit/bounded-artifact-reader.js";
import { writeBytesExclusiveDurable } from "./manifest/durable-exclusive-publication.js";

export const PROVIDER_RAW_ATTEMPT_CONTRACT = "provider-raw-attempt-v1" as const;
const MAX_RETAINED_RAW_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
}).strict();

const ProviderRawAttemptSchema = z.object({
  contract: z.literal(PROVIDER_RAW_ATTEMPT_CONTRACT),
  cache_key: z.string().regex(/^[0-9a-f]{64}$/u),
  attempt_ordinal: z.number().int().positive(),
  kind: z.enum(["query", "alignment", "source_semantic"]),
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
  extracted_at: z.string().min(1)
}).strict();

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

export function bindProviderRawAttempt(
  raw: ProviderRawAttempt,
  expected: Readonly<{
    cacheKey: string;
    kind: ProviderRawAttempt["kind"];
    model: string;
    requestProfile: string;
    requestDigest: string;
  }>
): ProviderRawAttempt {
  if (raw.cache_key !== expected.cacheKey || raw.kind !== expected.kind ||
      raw.model !== expected.model || raw.request_profile !== expected.requestProfile ||
      raw.request_digest !== expected.requestDigest) {
    throw new ProviderRawAttemptIdentityError(
      `provider raw attempt identity mismatch: ${expected.cacheKey}`
    );
  }
  return raw;
}

export function readProviderRawAttempt(
  root: string, key: string, ordinal: number
): ProviderRawAttempt | undefined {
  const path = providerRawAttemptPath(root, key, ordinal);
  if (!boundedArtifactEntryExists(path)) return undefined;
  const record = ProviderRawAttemptSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: MAX_RECORD_BYTES, label: "provider raw attempt"
  })));
  if (record.cache_key !== key || record.attempt_ordinal !== ordinal) {
    throw new ProviderRawAttemptIdentityError(`provider raw attempt identity mismatch: ${key}`);
  }
  return record;
}

export function writeProviderRawAttempt(input: Readonly<{
  root: string;
  cacheKey: string;
  attemptOrdinal: number;
  kind: ProviderRawAttempt["kind"];
  model: string;
  requestProfile: string;
  requestDigest: string;
  decodedText: string;
  finishReason: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  transportPhase?: string;
}>): ProviderRawAttempt {
  const original = Buffer.from(input.decodedText, "utf8");
  const truncated = original.byteLength > MAX_RETAINED_RAW_BYTES;
  const retained = truncated ? original.subarray(0, MAX_RETAINED_RAW_BYTES).toString("utf8") : input.decodedText;
  const record = ProviderRawAttemptSchema.parse({
    contract: PROVIDER_RAW_ATTEMPT_CONTRACT,
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
    extracted_at: new Date().toISOString()
  });
  const path = providerRawAttemptPath(input.root, input.cacheKey, input.attemptOrdinal);
  mkdirSync(dirname(path), { recursive: true });
  writeBytesExclusiveDurable(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
  return record;
}

export function requestEnvelopeDigest(requestJson: string): string {
  return createHash("sha256").update(requestJson, "utf8").digest("hex");
}
