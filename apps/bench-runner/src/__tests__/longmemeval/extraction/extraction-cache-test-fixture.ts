import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  computeSystemPromptSha256,
  writeExtractionCacheManifest,
  type ExtractionRequestProfile
} from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { openExtractionAttemptLedger } from
  "../../../runs/extraction/authority/attempt-ledger.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../runs/extraction/authority/receipt-limits.js";

const TEST_EXTRACTION_PROVIDER_URL = "https://provider.invalid/v1";

export const TEST_PROVIDER_COMPLETION_METADATA = Object.freeze({
  finishReason: "stop" as const,
  completionContractVersion: 1 as const,
  completionWitness: "message" as const
});

export const TEST_CACHED_PROVIDER_COMPLETION_METADATA = Object.freeze({
  finish_reason: "stop" as const,
  completion_contract_version: 1 as const,
  completion_witness: "message" as const
});

export function providerBackedExtractionResult<Extras extends object = Record<never, never>>(
  rawJson: string,
  extras?: Extras
) {
  const responseMetadata = (extras as {
    readonly responseMetadata?: Readonly<Record<string, unknown>>;
  } | undefined)?.responseMetadata;
  return {
    ...extras,
    rawJson,
    responseMetadata: { ...responseMetadata, ...TEST_PROVIDER_COMPLETION_METADATA }
  };
}

/** A custom delegate fixture backed by the bytes of an actual chat-completion Response. */
export async function providerBackedResponseResult<Extras extends object = Record<never, never>>(
  input: { readonly userPrompt: string; readonly onTransportAttempt?: () => void | Promise<void> },
  rawJson: string, extras?: Extras
) {
  await input.onTransportAttempt?.();
  const result = providerBackedExtractionResult(rawJson, extras);
  const usage = (result as { readonly usage?: {
    readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number
  } }).usage;
  const response = Response.json({
    choices: [{ message: { content: rawJson }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage: {
      prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens
    } })
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { ...result, httpResponse: {
    contentType: response.headers.get("content-type"),
    bodyBase64: bytes.toString("base64"), bodyByteLength: bytes.length,
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
    bodyTruncated: false, bodyComplete: true
  } };
}

/** A bounded local attempt ledger for tests that exercise the cache port directly. */
export function fixtureAttemptAuthority(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly startingMissing?: number;
}) {
  const startingMissing = input.startingMissing ?? 1;
  const lineageDigest = createHash("sha256")
    .update(`fixture-attempt-authority:${input.cacheRoot}`).digest("hex");
  const ledger = openExtractionAttemptLedger({
    cacheRoot: input.cacheRoot, lineageDigest,
    cacheIdentity: { model: input.model, requestProfile: input.requestProfile },
    startingMissing,
    maximumAttempts: computeExtractionFillAttemptCeiling(startingMissing),
    successfulShardCeiling: startingMissing
  });
  return {
    onTransportAttempt: ledger.reserveAttemptOrdinal,
    providerAttemptLineageDigest: lineageDigest,
    onLiveExtractionOutcome: ledger.recordTransportOutcome,
    onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
    onDeterministicExtractionSucceeded: ledger.commitDeterministicShard,
    onLiveExtractionFailed: ledger.abandonPendingShard
  };
}

export function testExtractionTransportProvenance(model: string) {
  return {
    provider_url_sha256: `sha256:${"a".repeat(64)}`,
    model
  };
}

export function writeExtractionCacheTestManifest(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly modelFamily?: string;
  readonly providerUrl?: string;
  readonly requestProfile?: ExtractionRequestProfile;
}): void {
  writeExtractionCacheManifest(input.cacheRoot, {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    source_packing: "reference-eight",
    extraction_model: input.model,
    model_family: input.modelFamily ?? input.model,
    request_profile: input.requestProfile ?? "provider-default-v1",
    provider_url: input.providerUrl ?? TEST_EXTRACTION_PROVIDER_URL,
    system_prompt_sha256: computeSystemPromptSha256(input.systemPrompt),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "test-fixture",
    dataset_revision: "test-fixture",
    storage: "git-tracked",
    built_at: "2026-07-12T00:00:00.000Z",
    builder: "test"
  });
}

export { TEST_EXTRACTION_PROVIDER_URL };
import { createHash } from "node:crypto";
