import type { ChatCompletionResponseInspection } from "../../extraction/chat-completion-response.js";
import type { BenchProviderUsage } from "../compile-seed-types.js";
import {
  markOutputTokenTruncation
} from "./output-token-retry.js";
import { markGardenHttpFailure } from "./garden-http-failure-attempt.js";

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
    validateDefaultSignalsEnvelope(content, response.usage);
  }
  return content;
}

export function buildGardenHttpAttemptResponse(
  response: ChatCompletionResponseInspection,
  maxOutputTokens: number | undefined,
  validation: "default_envelope" | "caller_owned"
) {
  return {
    rawJson: extractValidGardenHttpContent(response, validation),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    responseMetadata: {
      finishReason: response.finishReason,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
    }
  };
}

function validateDefaultSignalsEnvelope(
  content: string,
  usage: BenchProviderUsage | undefined
): void {
  try {
    inspectSignalsEnvelope(content);
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

function inspectSignalsEnvelope(content: string): void {
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null ||
      !Array.isArray((parsed as { readonly signals?: unknown }).signals)) {
    throw new Error("signals array missing");
  }
}
