import { afterEach, describe, expect, it, vi } from "vitest";
import { createGardenHttpExtractor } from
  "../../../../longmemeval/compile-seed/compile-seed-http.js";
import type { CompileSeedExtractionConfig } from
  "../../../../longmemeval/compile-seed/compile-seed-types.js";

const HTTP_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  requestProfile: "provider-default-v1",
  apiKey: "sk-test"
};

afterEach(() => vi.useRealTimers());

describe("garden HTTP stream progress timeout", () => {
  it("keeps an active SSE response alive beyond one idle window", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamingResponse());
    const pending = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0
    }).extract({
      systemPrompt: "s",
      userPrompt: "t",
      timeoutMs: 20,
      retryMode: "disabled"
    });

    await vi.advanceTimersByTimeAsync(60);

    await expect(pending).resolves.toMatchObject({
      rawJson: '{"signals":[]}',
      extractorMeta: { retryClassification: "success_first_try" }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out after an active SSE response stops making progress", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(stallingResponse());
    const pending = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0
    }).extract({
      systemPrompt: "s",
      userPrompt: "t",
      timeoutMs: 20,
      retryMode: "disabled"
    });
    const rejection = expect(pending).rejects.toMatchObject({
      benchRetry: { retryClassification: "failure_timeout" }
    });

    await vi.advanceTimersByTimeAsync(35);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function streamingResponse(): Response {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"{\\"signals\\":"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"[]}"}}]}\n\n',
    "data: [DONE]\n\n"
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk, index) => {
        setTimeout(() => controller.enqueue(encoder.encode(chunk)), 15 * (index + 1));
      });
      setTimeout(() => controller.close(), 50);
    }
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function stallingResponse(): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"{"}}]}\n\n'
      )), 10);
    }
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}
