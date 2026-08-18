import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});
import {
  DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS,
  fetchProviderChatCompletion,
  providerChatCompletionsUrl
} from "../../provider/chat-completion/index.js";

describe("provider chat completion", () => {
  it("posts a JSON chat completion with the selected profile", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://proxy.example/v1/chat/completions");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "mimo-v2.5",
        temperature: 0,
        response_format: { type: "json_object" },
        reasoning_effort: "none",
        enable_thinking: false
      });
      expect(body.stream).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await fetchProviderChatCompletion({
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: "mimo-v2.5",
      systemPrompt: "sys",
      userPrompt: "user",
      profile: "mimo-v2.5-nonthinking-v1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toEqual({
      text: '{"ok":true}',
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      httpStatus: 200
    });
  });

  it("streams usage-bearing SSE and normalizes the URL", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe(providerChatCompletionsUrl("https://proxy.example/v1/chat/completions"));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      return new Response(
        "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"a\\\"}\" }}]}\n\n" +
        "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n" +
        "data: [DONE]\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });

    const result = await fetchProviderChatCompletion({
      providerUrl: "https://proxy.example/v1/chat/completions",
      apiKey: "sk-test",
      model: "mimo-v2.5",
      systemPrompt: "sys",
      userPrompt: "user",
      mode: "sse",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.text).toBe('{"a"}');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });

  it("aborts within the default timeout when none is provided", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
    );

    const pending = fetchProviderChatCompletion({
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: "mimo-v2.5",
      systemPrompt: "sys",
      userPrompt: "user",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const expectation = expect(pending).rejects.toMatchObject({
      name: "ProviderChatCompletionError"
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS);
    await expectation;
    vi.useRealTimers();
  });

  it("fails closed on a non-OK provider status", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    await expect(fetchProviderChatCompletion({
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: "mimo-v2.5",
      systemPrompt: "sys",
      userPrompt: "user",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ name: "ProviderChatCompletionError", httpStatus: 429 });
  });
});
