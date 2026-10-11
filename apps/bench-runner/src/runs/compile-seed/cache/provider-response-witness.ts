import { createHash } from "node:crypto";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { decodeGeminiGenerateContent, isCompleteGeminiFinish, parseGeminiGenerateContentBody } from
  "../../extraction/fill/batch/native-codec.js";
import { decodeBoundedResponseBytes } from "../../extraction/fill/batch/http.js";
import { inspectProviderChatCompletionResponse } from
  "@do-soul/alaya-engine-gateway";
import { isNativeGeminiRequestProfile } from "../../extraction/request-profile.js";
import type { BenchProviderUsage, BenchTransportResponseWitness } from "../compile-seed-types.js";
import { computeCacheKey } from "./cache-key.js";
import { parseOfficialApiExtractionRequest } from "@do-soul/alaya-soul";
import { assertRetainedPartitionedRequests, composePartitionedExtraction } from
  "../http/garden-http-assertion-partition.js";
import type { CachedExtractionResponseMetadata } from "./cached-response-metadata.js";

export interface CachedProviderResponseWitness {
  readonly attempt_ordinal: number;
  readonly witness: BenchTransportResponseWitness;
  readonly usage: BenchProviderUsage | null;
}

export function inspectRetainedInteractiveResponses(input: {
  readonly cacheKey: string;
  readonly model: string;
  readonly requestProfile: Parameters<typeof computeCacheKey>[1];
  readonly rawJson: string;
  readonly attemptOrdinal: number;
  readonly requestIdentity?: { readonly system_prompt: string; readonly user_prompt: string };
  readonly responses?: readonly CachedProviderResponseWitness[];
  readonly responseMetadata?: CachedExtractionResponseMetadata;
}): readonly CachedProviderResponseWitness[] {
  const { requestIdentity, responses } = input;
  if (requestIdentity === undefined || responses === undefined || responses.length === 0 ||
      computeCacheKey(input.model, input.requestProfile,
        requestIdentity.system_prompt, requestIdentity.user_prompt) !== input.cacheKey) {
    throw new AlayaError("CONFLICT", "interactive provider request/response witness is missing");
  }
  let previousOrdinal = 0;
  let physicalFinish: string | null = null;
  let physicalWitness: string | undefined;
  for (const response of responses) {
    if (!Number.isSafeInteger(response.attempt_ordinal) ||
        response.attempt_ordinal <= previousOrdinal ||
        typeof response.witness.userPrompt !== "string" ||
        sha256(response.witness.userPrompt) !== response.witness.requestSha256 ||
        typeof response.witness.rawJson !== "string" ||
        response.usage !== null && !validUsage(response.usage)) {
      throw new AlayaError("CONFLICT", "interactive provider response witness is invalid");
    }
    previousOrdinal = response.attempt_ordinal;
    const physical = response.witness.httpResponse;
    if (physical === undefined) {
      throw new AlayaError("CONFLICT", "interactive physical provider response is missing");
    }
    const body = Buffer.from(physical.bodyBase64, "base64");
    if (!physical.bodyComplete || physical.bodyTruncated ||
        body.length !== physical.bodyByteLength ||
        sha256(body) !== physical.bodySha256 ||
        body.toString("base64") !== physical.bodyBase64) {
      throw new AlayaError("CONFLICT", "interactive provider response bytes are incomplete or changed");
    }
    const decoded = isNativeGeminiRequestProfile(input.requestProfile)
      ? decodeGeminiGenerateContent(parseGeminiGenerateContentBody(decodeBoundedResponseBytes(body)))
      : inspectProviderChatCompletionResponse(body,
        physical.contentType, 200);
    const rawJson = "rawJson" in decoded ? decoded.rawJson : decoded.text;
    physicalFinish = "rawJson" in decoded ? decoded.responseMetadata.finishReason : decoded.finishReason;
    physicalWitness = "rawJson" in decoded
      ? decoded.responseMetadata.completionWitness : decoded.completion?.witness;
    if ("rawJson" in decoded ? !isCompleteGeminiFinish(physicalFinish) :
        physicalFinish === "length" || decoded.completion?.complete !== true) {
      throw new AlayaError("CONFLICT", "interactive physical provider response is incomplete");
    }
    if (rawJson !== response.witness.rawJson ||
        canonicalJson(decoded.usage ?? null) !== canonicalJson(response.usage)) {
      throw new AlayaError("CONFLICT", "interactive provider response decoding changed");
    }
  }
  const last = responses.at(-1)!;
  const metadata = input.responseMetadata;
  if (metadata?.completion_contract_version !== 1 ||
      (responses.length === 1
        ? metadata.finish_reason !== physicalFinish || metadata.completion_witness !== physicalWitness
        : metadata.finish_reason !== null || metadata.completion_witness !== "partition_composition")) {
    throw new AlayaError("CONFLICT", "interactive provider completion differs from retained physical responses");
  }
  if (last.attempt_ordinal !== input.attemptOrdinal ||
      responses.length === 1 && last.witness.userPrompt !== requestIdentity.user_prompt ||
      responses.length === 1 && last.witness.rawJson !== input.rawJson) {
    throw new AlayaError("CONFLICT", "interactive provider response differs from cached extraction");
  }
  if (responses.length > 1) {
    const request = parseOfficialApiExtractionRequest(JSON.parse(requestIdentity.user_prompt));
    const witnesses = responses.map((response) => response.witness);
    assertRetainedPartitionedRequests(request, witnesses);
    if (composePartitionedExtraction(request, witnesses) !== input.rawJson) {
      throw new AlayaError("CONFLICT", "partition composition differs from retained physical responses");
    }
  }
  return responses;
}

function validUsage(value: BenchProviderUsage): boolean {
  return [value.inputTokens, value.outputTokens, value.totalTokens].every((part) =>
    Number.isSafeInteger(part) && part >= 0);
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
