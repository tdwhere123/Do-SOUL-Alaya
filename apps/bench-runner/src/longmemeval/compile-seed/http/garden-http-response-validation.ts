import type { ChatCompletionResponseInspection } from "../../extraction/chat-completion-response.js";
import { inspectExtractionRawJson } from "../../extraction/content-closure.js";
import {
  markOutputTokenTruncation
} from "./output-token-retry.js";
import { markGardenHttpFailure } from "./garden-http-failure-attempt.js";

export function extractValidGardenHttpContent(
  response: ChatCompletionResponseInspection
): string {
  if (response.finishReason === "length") {
    throw markGardenHttpFailure(markOutputTokenTruncation(
      new Error("garden extraction stopped at the provider output-token limit")
    ), {
      kind: "response_schema_error",
      phase: "response_schema"
    });
  }
  const content = response.content;
  if (content.trim().length === 0) {
    throw markGardenHttpFailure(new Error("garden extraction returned no content"), {
      kind: "empty_response",
      phase: "response_schema"
    });
  }
  try {
    inspectExtractionRawJson(content);
  } catch (parseError) {
    throw markGardenHttpFailure(new Error(
      `garden extraction returned unparseable content: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`
    ), {
      kind: "response_parse_error",
      phase: "response_parse",
      rawBody: content
    });
  }
  return content;
}
