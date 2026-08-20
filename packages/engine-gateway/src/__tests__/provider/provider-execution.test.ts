import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeProviderChatCompletion,
  computeProviderRetryJitterMs,
  providerExecutionFailureOf,
  type ProviderAttemptFailure
} from "../../provider/chat-completion/index.js";

const REQUEST = {
  providerUrl: "https://provider.test/v1",
  apiKey: "secret",
  model: "model",
  systemPrompt: "system",
  userPrompt: "user"
} as const;

afterEach(() => vi.useRealTimers());

describe("provider execution authority", () => {
  it("owns the preserved bounded exponential jitter schedule", () => {
    expect(computeProviderRetryJitterMs(0, 250, 1_500, () => 0)).toBe(250);
    expect(computeProviderRetryJitterMs(0, 250, 1_500, () => 0.999)).toBe(500);
    expect(computeProviderRetryJitterMs(2, 250, 1_500, () => 0.999)).toBe(1_500);
  });
  it.each([429, 503] as const)("normalizes and retries HTTP %s", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status }))
      .mockResolvedValueOnce(jsonResponse("ok"));
    const failures: ProviderAttemptFailure[] = [];

    const execution = await executeProviderChatCompletion(
      { ...REQUEST, fetchImpl },
      { maxRetries: 1, retryDelaysMs: [0] },
      { onAttemptFailure: (failure) => failures.push(failure) }
    );

    expect(execution).toMatchObject({
      retryClassification: "success_after_retry",
      retryCount: 1,
      result: { text: "ok", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
    });
    expect(failures).toEqual([{
      attempt: 1, kind: "http_error", httpStatus: status, inspectionReason: null
    }]);
  });

  it("treats a synchronous retry waiter as owning the delay", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse("ok"));
    let observeWait: (() => void) | undefined;
    const waited = new Promise<void>((resolve) => {
      observeWait = resolve;
    });
    const waitForRetry = vi.fn(() => observeWait?.());

    const pending = executeProviderChatCompletion(
      { ...REQUEST, fetchImpl },
      { maxRetries: 1, retryDelaysMs: [10_000] },
      { waitForRetry }
    );
    await waited;
    await vi.advanceTimersByTimeAsync(0);

    expect(waitForRetry).toHaveBeenCalledWith(0, 10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toMatchObject({ retryCount: 1 });
  });

  it("normalizes timeout and does not mistake it for caller abort", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = executeProviderChatCompletion(
      { ...REQUEST, timeoutMs: 10, fetchImpl },
      { maxRetries: 0, retryDelaysMs: [] }
    );
    const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("keeps caller abort terminal", async () => {
    const caller = new AbortController();
    caller.abort();
    await expect(executeProviderChatCompletion(
      { ...REQUEST, abortSignal: caller.signal, fetchImpl: vi.fn<typeof fetch>() },
      { maxRetries: 2, retryDelaysMs: [0, 0], retryNetworkErrors: true }
    )).rejects.toMatchObject({ kind: "aborted" });
  });

  it("keeps malformed response terminal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]", {
      headers: { "content-type": "application/json" }
    }));
    await expect(executeProviderChatCompletion(
      { ...REQUEST, fetchImpl },
      { maxRetries: 2, retryDelaysMs: [0, 0] }
    )).rejects.toMatchObject({
      kind: "response_parse_error",
      inspectionReason: "schema"
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("attaches the shared terminal outcome without mutating public error fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("busy", { status: 503 })
    );
    const error = await executeProviderChatCompletion(
      { ...REQUEST, fetchImpl },
      { maxRetries: 1, retryDelaysMs: [0] }
    ).then(() => null, (cause: unknown) => cause);

    expect(providerExecutionFailureOf(error)).toMatchObject({
      retryClassification: "failure_max_retries",
      retryCount: 1,
      failures: [
        { attempt: 1, kind: "http_error", httpStatus: 503 },
        { attempt: 2, kind: "http_error", httpStatus: 503 }
      ]
    });
    expect(Object.keys(error as object)).not.toContain("failures");
  });
});

function jsonResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  }), { headers: { "content-type": "application/json" } });
}
