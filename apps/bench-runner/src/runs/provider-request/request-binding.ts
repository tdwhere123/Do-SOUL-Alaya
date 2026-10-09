import { createHash } from "node:crypto";
import { isChatSemanticRequestProfile, type StepSemanticRequestProfile, type InternSemanticRequestProfile, AlayaError } from "@do-soul/alaya-protocol";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { prepareSemanticProviderRequest } from "../compile-seed/http/semantic-provider-http.js";
import { isNativeGeminiRequestProfile, type NativeGeminiRequestProfile } from "../extraction/request-profile.js";
import { attemptInputByteUpperBound } from "../extraction/authority/receipt-limits.js";
import { buildExtractionTransportProvenance, resolveExtractionTransportRoute } from "../extraction/transport-route.js";
import { normalizeGeminiEndpoint } from "../provider/gemini-endpoint.js";

export const SOURCE_SEMANTIC_PROPOSAL_SCHEMA_NAME = "source_semantic_proposal" as const;
export const SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME = "source_evidence_selection" as const;
export const SOURCE_EVIDENCE_PRESERVATION_SCHEMA_NAME = "source_evidence_preservation" as const;
export const PAGE_SUPPORT_COMPARISON_SCHEMA_NAME = "page_support_comparison" as const;

const MILLION = 1_000_000;

/** The actual sender owns encoding and route resolution, including thinking settings. */
export function bindSemanticProviderRequest(
  config: CompileSeedExtractionConfig,
  request: { systemPrompt: string; userPrompt: string; maxOutputTokens: number; responseJsonSchema: object },
  schemaName: string
) {
  const encoded = prepareSemanticProviderRequest(config, {
    ...request, retryMode: "disabled",
    outputTokenField: isChatSemanticRequestProfile(config.requestProfile) ? "max_tokens" : "maxOutputTokens",
    validateRawJson: () => undefined
  }, schemaName);
  const route = resolveExtractionTransportRoute(config);
  return {
    inputByteUpper: attemptInputByteUpperBound(encoded.body),
    requestDigest: createHash("sha256").update(JSON.stringify([encoded.url.href, encoded.body])).digest("hex"),
    transportProvenance: buildExtractionTransportProvenance({
      ...config,
      transportProviderUrl: isChatSemanticRequestProfile(config.requestProfile)
        ? route.providerUrl : normalizeGeminiEndpoint(route.providerUrl).origin
    })
  };
}

/** Exact wire identity for a cache key. Encoding uses the named schema and a credential-free config. */
export function semanticProviderRequestCacheKey(input: Readonly<{
  identityPrefix: string;
  model: string;
  requestProfile: string;
  systemPrompt: string;
  userPrompt: string;
  schema: object;
  maxOutputTokens: number;
  providerUrl: string;
  schemaName: string;
}>): string {
  const requestProfile = semanticRequestProfile(input.requestProfile);
  const wire = prepareSemanticProviderRequest({
    model: input.model, requestProfile, providerUrl: input.providerUrl, apiKey: null
  }, {
    systemPrompt: input.systemPrompt, userPrompt: input.userPrompt, maxOutputTokens: input.maxOutputTokens,
    responseJsonSchema: input.schema,
    outputTokenField: isChatSemanticRequestProfile(requestProfile) ? "max_tokens" : "maxOutputTokens",
    retryMode: "disabled", validateRawJson: () => undefined
  }, input.schemaName);
  return createHash("sha256")
    .update(input.identityPrefix, "utf8").update("\u0000", "utf8")
    .update(input.model, "utf8").update("\u0000", "utf8")
    .update(input.requestProfile, "utf8").update("\u0000", "utf8")
    .update(input.systemPrompt, "utf8").update("\u0000", "utf8")
    .update(input.userPrompt, "utf8").update("\u0000", "utf8")
    .update(wire.url.href, "utf8").update("\u0000", "utf8")
    .update(wire.body, "utf8").update("\u0000", "utf8")
    .update(String(input.maxOutputTokens), "utf8")
    .digest("hex");
}

function semanticRequestProfile(
  requestProfile: string
): NativeGeminiRequestProfile | StepSemanticRequestProfile | InternSemanticRequestProfile {
  if (isNativeGeminiRequestProfile(requestProfile) || isChatSemanticRequestProfile(requestProfile)) {
    return requestProfile;
  }
  throw new AlayaError("VALIDATION", "semantic provider request requires a native semantic request profile");
}

export function estimatedSemanticProviderUpperUsd(
  preflight: Readonly<{
    maximum_attempts: number;
    max_output_tokens: number;
    maximum_input_tokens_per_attempt: number;
  }>,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number
): number {
  const perAttempt = (
    preflight.maximum_input_tokens_per_attempt * inputUsdPerMillion +
    preflight.max_output_tokens * outputUsdPerMillion
  ) / MILLION;
  return perAttempt * preflight.maximum_attempts;
}
