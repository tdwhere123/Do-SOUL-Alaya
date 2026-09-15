import type { ChatCompletionResponseInspection } from "../../extraction/chat-completion-response.js";
import type { BenchProviderUsage } from "../compile-seed-types.js";
import type { ProviderCompletionWitness } from "@do-soul/alaya-engine-gateway";
import {
  markOutputTokenTruncation
} from "./output-token-retry.js";
import { markGardenHttpFailure } from "./garden-http-failure-attempt.js";
import { inspectExtractionRawEnvelope } from "../../extraction/content-closure.js";

export function extractValidGardenHttpContent(
  response: ChatCompletionResponseInspection,
  validation: "default_envelope" | "caller_owned" = "default_envelope"
): string {
  if (response.finishReason === "length") {
    throw markGardenHttpFailure(markOutputTokenTruncation(
      new Error("garden extraction stopped at the provider output-token limit")
    ), {
      kind: "response_schema_error",
      phase: "response_schema",
      ...(response.usage === undefined ? {} : { usage: response.usage })
    });
  }
  const content = response.content;
  if (content.trim().length === 0) {
    throw markGardenHttpFailure(new Error("garden extraction returned no content"), {
      kind: "empty_response",
      phase: "response_schema",
      ...(response.usage === undefined ? {} : { usage: response.usage })
    });
  }
  if (validation === "default_envelope") {
    validateDefaultExtractionEnvelope(content, response.usage);
  }
  return content;
}

export function buildGardenHttpAttemptResponse(
  response: ChatCompletionResponseInspection,
  maxOutputTokens: number | undefined,
  validation: "default_envelope" | "caller_owned",
  completion?: ProviderCompletionWitness
) {
  return {
    rawJson: extractValidGardenHttpContent(response, validation),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    responseMetadata: {
      finishReason: response.finishReason,
      ...(completion === undefined ? {} : {
        completionContractVersion: 1 as const,
        completionWitness: completion.witness
      }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
    }
  };
}

function validateDefaultExtractionEnvelope(
  content: string,
  usage: BenchProviderUsage | undefined
): void {
  try {
    inspectExtractionRawEnvelope(content);
  } catch (parseError) {
    throw markGardenHttpFailure(new Error(
      `garden extraction returned unparseable content: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`
    ), {
      kind: "response_parse_error",
      phase: "response_parse",
      rawBody: content,
      ...(usage === undefined ? {} : { usage })
    });
  }
}
