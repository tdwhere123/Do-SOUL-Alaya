import { parseSourceSemanticRequest, sourceSemanticResponseJsonSchema } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { prepareSemanticProviderRequest, STEP_SEMANTIC_REQUEST_PROFILE } from
  "../../compile-seed/http/semantic-provider-http.js";
import type { SourceRequestLine } from "../request-artifact.js";
import { requestEnvelopeDigest } from "./provider-raw-attempt.js";

export const SOURCE_SEMANTIC_INTERACTIVE_WIRE_DIGEST_CONTRACT = "source-semantic-interactive-wire-v1" as const;

/** The exact logical source descriptor is encoded once for preflight and dispatch. */
export function prepareSourceSemanticRequestWire(
  config: CompileSeedExtractionConfig, line: SourceRequestLine, maxOutputTokens: number
) {
  return prepareSemanticProviderRequest(config, {
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt,
    ...(config.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE ? {
      responseJsonSchema: sourceSemanticResponseJsonSchema(parseSourceSemanticRequest(JSON.parse(line.userPrompt)))
    } : {}),
    maxOutputTokens, retryMode: "disabled",
    outputTokenField: config.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE ? "max_tokens" : "maxOutputTokens"
  }, "source_semantic");
}

export function sourceSemanticRequestWireDigest(
  config: CompileSeedExtractionConfig, line: SourceRequestLine, maxOutputTokens: number
): string {
  if (config.requestProfile !== STEP_SEMANTIC_REQUEST_PROFILE) return requestEnvelopeDigest(line.userPrompt);
  return sourceSemanticInteractiveWireSha256(config, line, maxOutputTokens);
}

/** Versioned full native URL/body digest for new interactive review; legacy raw request_digest is unchanged. */
export function sourceSemanticInteractiveWireSha256(
  config: CompileSeedExtractionConfig, line: SourceRequestLine, maxOutputTokens: number
): string {
  const request = prepareSourceSemanticRequestWire(config, line, maxOutputTokens);
  return requestEnvelopeDigest(JSON.stringify([request.url.href, request.body]));
}
