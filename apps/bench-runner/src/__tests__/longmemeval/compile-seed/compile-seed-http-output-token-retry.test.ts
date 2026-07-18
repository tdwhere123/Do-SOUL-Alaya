import { describe, expect, it, vi } from "vitest";
import {
  createGardenHttpExtractor,
  type CompileSeedExtractionConfig
} from "../../../longmemeval/compile-seed.js";

const HTTP_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  requestProfile: "provider-default-v1",
  apiKey: "sk-test"
};

describe("createGardenHttpExtractor — output-token retries", () => {
  it("raises a length-truncated response from 2048 to the authorized 4096 ceiling", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        "data: [DONE]\n\n"
      ))
      .mockResolvedValueOnce(sseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n"
      ));
    const result = await createExtractor(fetchMock).extract(extractionInput());

    expect(requestTokenCaps(fetchMock)).toEqual([2048, 4096]);
    expect(result.responseMetadata).toEqual({
      finishReason: "stop",
      maxOutputTokens: 4096
    });
    expect(result.extractorMeta?.retryClassification).toBe("success_after_retry");
  });

  it.each([
    [429, "rate limit"],
    [503, "server failure"]
  ])("keeps 2048 for an unrelated %i %s retry", async (status) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, status))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: '{"signals":[]}' }, finish_reason: "stop" }]
      }));

    await createExtractor(fetchMock).extract(extractionInput());

    expect(requestTokenCaps(fetchMock)).toEqual([2048, 2048]);
  });
});

function createExtractor(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  return createGardenHttpExtractor(HTTP_CONFIG, {
    fetch: fetchMock,
    sleep: vi.fn(async () => undefined),
    random: () => 0
  });
}

function extractionInput() {
  return {
    systemPrompt: "s",
    userPrompt: "t",
    maxOutputTokens: 4096,
    outputTokenField: "max_tokens" as const
  };
}

function requestTokenCaps(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): number[] {
  return fetchMock.mock.calls.map((call) =>
    (JSON.parse(String(call[1]?.body)) as { max_tokens: number }).max_tokens
  );
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
