import { describe, expect, it, vi } from "vitest";
import {
  createGardenHttpExtractor,
  type CompileSeedExtractionConfig
} from "../../../bench/compile-seed.js";
import {
  resolveAttemptIdleTimeoutMs,
  withAttemptOutputTokenLimit
} from "../../../bench/compile-seed/http/output-token-retry.js";

const HTTP_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  requestProfile: "provider-default-v1",
  apiKey: "sk-test"
};

describe("createGardenHttpExtractor output-token retries", () => {
  it("starts at 2048 and raises only a length-truncated request to its ceiling", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(successResponse());

    const result = await createExtractor(fetchMock).extract(extractionInput(32_768));

    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 32_768]);
    const prompts = requestUserPrompts(fetchMock);
    expect(prompts[0]).not.toContain("output-token budget");
    expect(prompts[1]).toContain("previous response exhausted the output-token budget");
    expect(prompts[1]).toContain("merge overlapping or entailed catalog assertions");
    expect(result.responseMetadata).toEqual({
      finishReason: "stop",
      maxOutputTokens: 32_768
    });
    expect(result.extractorMeta?.retryClassification).toBe("success_after_retry");
  });

  it("uses the authorized ceiling for a retry-disabled probe", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(successResponse());

    await createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      retryMode: "disabled"
    });

    expect(requestTokenCaps(fetchMock)).toEqual([32_768]);
  });

  it.each([
    [429, "rate limit"],
    [503, "server failure"]
  ])("keeps 2048 for an unrelated %i %s retry", async (status) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, status))
      .mockResolvedValueOnce(successResponse());

    await createExtractor(fetchMock).extract(extractionInput(32_768));

    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 2_048]);
  });

  it("preserves a final ceiling attempt after unrelated transport retries", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(successResponse());

    const result = await createExtractor(fetchMock).extract(extractionInput(32_768));

    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 2_048, 2_048, 32_768]);
    expect(result.responseMetadata).toEqual({
      finishReason: "stop",
      maxOutputTokens: 32_768
    });
  });

  it("does not repeat an identical request after the ceiling also truncates", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(truncatedResponse());

    await expect(createExtractor(fetchMock).extract(extractionInput(32_768)))
      .rejects.toMatchObject({
        benchRetry: { retryCount: 1, retryClassification: "failure_max_retries" }
      });
    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 32_768]);
  });

  it("partitions a truncated assertion batch and merges locator-ordered signals", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(signalResponse(1, "alpha"))
      .mockResolvedValueOnce(signalResponse(2, "beta"));
    const onTransportAttempt = vi.fn(async () => undefined);

    const result = await createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      userPrompt: assertionBatchPrompt([1, 2]),
      onTransportAttempt
    });

    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 2_048, 2_048]);
    expect(requestAssertionIds(fetchMock)).toEqual([[1, 2], [1], [2]]);
    expect(JSON.parse(result.rawJson)).toEqual({
      signals: [signal(1, "alpha"), signal(2, "beta")]
    });
    expect(result.extractorMeta).toMatchObject({
      retryCount: 1,
      retryClassification: "success_after_retry",
      successfulRequestCount: 2
    });
    expect(onTransportAttempt).toHaveBeenCalledTimes(3);
  });

  it("recursively partitions until each successful response fits", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(signalResponse(1, "alpha"))
      .mockResolvedValueOnce(signalResponse(2, "beta"))
      .mockResolvedValueOnce(signalResponse(3, "gamma"));

    const result = await createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      userPrompt: assertionBatchPrompt([1, 2, 3])
    });

    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 2_048, 2_048, 2_048, 2_048]);
    expect(requestAssertionIds(fetchMock)).toEqual([[1, 2, 3], [1, 2], [1], [2], [3]]);
    expect(JSON.parse(result.rawJson)).toEqual({
      signals: [signal(1, "alpha"), signal(2, "beta"), signal(3, "gamma")]
    });
    expect(result.extractorMeta).toMatchObject({
      retryCount: 2,
      successfulRequestCount: 3,
      transportFailures: [{ attempt: 1 }, { attempt: 2 }]
    });
  });

  it("restores original assertion order when a child returns reversed locators", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(signalsResponse([
        signal(2, "beta"), signal(1, "alpha")
      ]))
      .mockResolvedValueOnce(signalsResponse([
        signal(4, "delta"), signal(3, "gamma")
      ]));

    const result = await createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      userPrompt: assertionBatchPrompt([1, 2, 3, 4])
    });

    expect(JSON.parse(result.rawJson)).toEqual({
      signals: [
        signal(1, "alpha"), signal(2, "beta"),
        signal(3, "gamma"), signal(4, "delta")
      ]
    });
  });

  it.each([
    ["missing", { value: "missing locator" }],
    ["malformed", { source_locator: { assertion_id: "1" }, value: "bad locator" }]
  ])("retries a child response with a %s source locator", async (_label, invalidSignal) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(signalsResponse([invalidSignal]))
      .mockResolvedValueOnce(signalResponse(1, "alpha"))
      .mockResolvedValueOnce(signalResponse(2, "beta"));

    const result = await createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      userPrompt: assertionBatchPrompt([1, 2])
    });

    expect(requestAssertionIds(fetchMock)).toEqual([[1, 2], [1], [1], [2]]);
    expect(JSON.parse(result.rawJson)).toEqual({
      signals: [signal(1, "alpha"), signal(2, "beta")]
    });
  });

  it("retries a partition response whose signals envelope is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(contentResponse({}))
      .mockResolvedValueOnce(signalResponse(1, "alpha"))
      .mockResolvedValueOnce(signalResponse(2, "beta"));

    const result = await createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      userPrompt: assertionBatchPrompt([1, 2])
    });

    expect(requestAssertionIds(fetchMock)).toEqual([[1, 2], [1], [1], [2]]);
    expect(JSON.parse(result.rawJson)).toEqual({
      signals: [signal(1, "alpha"), signal(2, "beta")]
    });
  });

  it("includes exact usage from a length response in successful retry totals", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse({ prompt: 10, completion: 5, total: 15 }))
      .mockResolvedValueOnce(successResponse({ prompt: 20, completion: 2, total: 22 }));

    const result = await createExtractor(fetchMock).extract(extractionInput(32_768));

    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 7, totalTokens: 37 });
    expect(result.extractorMeta).toMatchObject({
      usageRequestCount: 2,
      transportFailures: [{
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      }]
    });
  });

  it("retries a child response whose locator belongs to its sibling partition", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(signalResponse(2, "wrong partition"))
      .mockResolvedValueOnce(signalResponse(1, "alpha"))
      .mockResolvedValueOnce(signalResponse(2, "beta"));

    const result = await createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      userPrompt: assertionBatchPrompt([1, 2])
    });

    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 2_048, 2_048, 2_048]);
    expect(requestAssertionIds(fetchMock)).toEqual([[1, 2], [1], [1], [2]]);
    expect(JSON.parse(result.rawJson)).toEqual({
      signals: [signal(1, "alpha"), signal(2, "beta")]
    });
    expect(result.extractorMeta).toMatchObject({
      retryCount: 2,
      successfulRequestCount: 2,
      transportFailures: [{ attempt: 1 }, { attempt: 2 }]
    });
  });

  it("rebases failures around a successful partition before a terminal sibling", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(signalResponse(1, "alpha"))
      .mockResolvedValueOnce(truncatedResponse())
      .mockResolvedValueOnce(truncatedResponse());

    await expect(createExtractor(fetchMock).extract({
      ...extractionInput(32_768),
      userPrompt: assertionBatchPrompt([1, 2])
    })).rejects.toMatchObject({
      benchRetry: {
        retryCount: 2,
        retryClassification: "failure_max_retries",
        successfulRequestCount: 1,
        transportFailures: [
          { attempt: 1 },
          { attempt: 3 },
          { attempt: 4 }
        ]
      }
    });
    expect(requestTokenCaps(fetchMock)).toEqual([2_048, 2_048, 2_048, 32_768]);
  });

  it("keeps inactivity timeout independent from the attempt token cap", () => {
    const input = { ...extractionInput(32_768), timeoutMs: 960_000 };

    expect(resolveAttemptIdleTimeoutMs(withAttemptOutputTokenLimit(input, false))).toBe(60_000);
    expect(resolveAttemptIdleTimeoutMs(withAttemptOutputTokenLimit(input, true))).toBe(60_000);
  });
});

function createExtractor(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  return createGardenHttpExtractor(HTTP_CONFIG, {
    fetch: fetchMock,
    sleep: vi.fn(async () => undefined),
    random: () => 0
  });
}

function extractionInput(maxOutputTokens: number) {
  return {
    systemPrompt: "s",
    userPrompt: "t",
    maxOutputTokens,
    outputTokenField: "max_tokens" as const
  };
}

function requestTokenCaps(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): number[] {
  return fetchMock.mock.calls.map((call) =>
    (JSON.parse(String(call[1]?.body)) as { max_tokens: number }).max_tokens
  );
}

function requestUserPrompts(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return fetchMock.mock.calls.map((call) => {
    const body = JSON.parse(String(call[1]?.body)) as {
      messages: readonly { readonly role: string; readonly content: string }[];
    };
    return body.messages.findLast(({ role }) => role === "user")?.content ?? "";
  });
}

function requestAssertionIds(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
): readonly (readonly number[])[] {
  return requestUserPrompts(fetchMock).map((prompt) => {
    const request = JSON.parse(prompt.split("\n\n", 1)[0] ?? prompt) as {
      readonly source_assertions: readonly { readonly assertion_id: number }[];
    };
    return request.source_assertions.map(({ assertion_id }) => assertion_id);
  });
}

function assertionBatchPrompt(assertionIds: readonly number[]): string {
  return JSON.stringify({
    schema_version: 2,
    source_locator_contract_version: 2,
    batch_contract_version: 1,
    source_corpus_identity: "a".repeat(64),
    batch_index: 0,
    batch_count: 1,
    source_assertions: assertionIds.map((assertion_id) => ({
      assertion_id,
      text: `User: assertion ${assertion_id}`
    }))
  });
}

function signal(assertionId: number, value: string) {
  return {
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertionId
    },
    value
  };
}

function signalResponse(assertionId: number, value: string): Response {
  return signalsResponse([signal(assertionId, value)]);
}

function signalsResponse(signals: readonly unknown[]): Response {
  return contentResponse({ signals });
}

function contentResponse(content: unknown): Response {
  return sseResponse(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: JSON.stringify(content) } }]
    })}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n"
  );
}

function truncatedResponse(usage?: UsageFixture): Response {
  return sseResponse(
    'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
    terminalFrame("length", usage) +
    "data: [DONE]\n\n"
  );
}

function successResponse(usage?: UsageFixture): Response {
  return sseResponse(
    'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
    terminalFrame("stop", usage) +
    "data: [DONE]\n\n"
  );
}

interface UsageFixture {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

function terminalFrame(finishReason: string, usage?: UsageFixture): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.total
    } })
  })}\n\n`;
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
