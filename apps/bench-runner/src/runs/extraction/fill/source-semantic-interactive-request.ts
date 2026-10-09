import { isChatSemanticRequestProfile, SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT } from "@do-soul/alaya-protocol";
import { parseSourceSemanticRequest, sourceSemanticResponseJsonSchema, sourceSemanticGenerationInput } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import { prepareSemanticProviderRequest } from
  "../../compile-seed/http/semantic-provider-http.js";
import type { SourceRequestLine } from "../request-artifact.js";
import { requestEnvelopeDigest } from "./provider-raw-attempt.js";

export const SOURCE_SEMANTIC_INTERACTIVE_WIRE_DIGEST_CONTRACT = "source-semantic-interactive-wire-v1" as const;

export function sourceSemanticInteractiveInput(line: SourceRequestLine) {
  const request = parseSourceSemanticRequest(JSON.parse(line.userPrompt));
  return { systemPrompt: line.systemPrompt, userPrompt: sourceSemanticGenerationInput(request),
    responseJsonSchema: sourceSemanticResponseJsonSchema(request) };
}

/** The exact logical source descriptor is encoded once for preflight and dispatch. */
export function prepareSourceSemanticRequestWire(
  config: CompileSeedExtractionConfig, line: SourceRequestLine, maxOutputTokens: number
) {
  return prepareSemanticProviderRequest(config, {
    ...sourceSemanticInteractiveInput(line),
    maxOutputTokens, retryMode: "disabled",
    outputTokenField: isChatSemanticRequestProfile(config.requestProfile) ? "max_tokens" : "maxOutputTokens"
  }, "source_semantic");
}

export function sourceSemanticRequestWireDigest(
  config: CompileSeedExtractionConfig, line: SourceRequestLine, maxOutputTokens: number
): string {
  const selected = parseSourceSemanticRequest(JSON.parse(line.userPrompt)).source_request;
  if (!isChatSemanticRequestProfile(config.requestProfile) && selected.generation_view_contract === undefined &&
      selected.generation_schema_contract === SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT) {
    return requestEnvelopeDigest(line.userPrompt);
  }
  return sourceSemanticInteractiveWireSha256(config, line, maxOutputTokens);
}

/** Versioned full native URL/body digest for new interactive review; legacy raw request_digest is unchanged. */
export function sourceSemanticInteractiveWireSha256(
  config: CompileSeedExtractionConfig, line: SourceRequestLine, maxOutputTokens: number
): string {
  const request = prepareSourceSemanticRequestWire(config, line, maxOutputTokens);
  return requestEnvelopeDigest(JSON.stringify([request.url.href, request.body]));
}
