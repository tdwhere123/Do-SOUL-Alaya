import { describe, expect, it } from "vitest";
import { extractContentFromChatCompletionBody } from
  "../../../longmemeval/extraction/chat-completion-response.js";

describe("extractContentFromChatCompletionBody", () => {
  it("concatenates delta content across data frames up to done", () => {
    const body =
      'data: {"choices":[{"delta":{"content":"ab"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"cd"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "abcd"
    );
  });

  it("ignores valid non-content frames around assistant content", () => {
    const body =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"internal"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"total_tokens":42}}\n\n' +
      "data: [DONE]\n\n";

    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      '{"signals":[]}'
    );
  });

  it("detects SSE from a leading data field without its content type", () => {
    const body = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
    expect(extractContentFromChatCompletionBody(body, null)).toBe("x");
  });

  it("returns empty content for a done-only stream", () => {
    expect(
      extractContentFromChatCompletionBody("data: [DONE]\n\n", "text/event-stream")
    ).toBe("");
  });

  it("ignores blank and comment lines", () => {
    const body =
      ": ping\n\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "ok"
    );
  });

  it("reads message content from a compliant plain JSON body", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "json-content" } }]
    });
    expect(extractContentFromChatCompletionBody(body, "application/json")).toBe(
      "json-content"
    );
  });

  it("rejects malformed data JSON even after a valid content prefix", () => {
    const body =
      'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
      "data: {bad\n\n" +
      "data: [DONE]\n\n";
    expect(() =>
      extractContentFromChatCompletionBody(body, "text/event-stream")
    ).toThrow(/chunk is not valid JSON/i);
  });

  it("rejects an empty data event instead of treating it as a heartbeat", () => {
    expect(() =>
      extractContentFromChatCompletionBody(
        "data:\n\ndata: [DONE]\n\n",
        "text/event-stream"
      )
    ).toThrow(/chunk is not valid JSON/i);
  });

  it("takes content once when a frame carries delta and message content", () => {
    const body =
      'data: {"choices":[{"delta":{"content":"x"},"message":{"content":"x"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "x"
    );
  });
});
