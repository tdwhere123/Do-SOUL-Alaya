import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS,
  providerChatCompletionsUrl
} from "../../provider/chat-completion/index.js";
import { fetchProviderChatCompletion } from
  "../../provider/chat-completion/fetch-chat-completion.js";

afterEach(() => {
  vi.useRealTimers();
});

const CHAT_REQUEST = {
  providerUrl: "https://proxy.example/v1",
  apiKey: "sk-test",
  model: "mimo-v2.5",
  systemPrompt: "sys",
  userPrompt: "user"
} as const;

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
      httpStatus: 200,
      completion: { mode: "json", complete: true, witness: "message" }
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
    expect(result.completion).toEqual({
      mode: "sse",
      complete: true,
      witness: "done_sentinel"
    });
  });

  it("rejects clean SSE EOF after JSON delta without a completion witness", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));

    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      mode: "sse",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({
      kind: "response_parse_error",
      inspectionReason: "incomplete_stream"
    });
  });

  it("accepts terminal finish_reason as an SSE completion witness", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"},"finish_reason":"stop"}]}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));

    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      mode: "sse",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toMatchObject({
      text: '{"signals":[]}',
      completion: { mode: "sse", complete: true, witness: "finish_reason" }
    });
  });

  it("accepts clean SSE EOF only under the explicit versioned compatibility policy", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"message":{"content":"{\\"signals\\":[]}"}}]}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));

    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      mode: "sse",
      sseCompletionPolicy: "allow_clean_eof_v1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toMatchObject({
      completion: { mode: "sse", complete: true, witness: "profile_clean_eof" }
    });
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
      name: "ProviderChatCompletionError",
      kind: "timeout"
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS);
    await expectation;
    vi.useRealTimers();
  });

  it.each([429, 503] as const)(
    "lets internal timeout win over a hanging HTTP %s diagnostic body",
    async (status) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      let fetchSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return Promise.resolve(hangingBodyResponse(status));
      });

      const pending = fetchProviderChatCompletion({
        ...CHAT_REQUEST,
        abortSignal: caller.signal,
        timeoutMs: 20,
        fetchImpl: fetchImpl as unknown as typeof fetch
      });
      const captured = pending.then(
        () => {
          throw new Error("expected provider timeout");
        },
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(20);
      const error = await captured;

      expect(error).toMatchObject({
        kind: "timeout",
        httpStatus: status
      });
      expect(Object.hasOwn(error as object, "status")).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchSignal).toBeDefined();
      expect(fetchSignal).not.toBe(caller.signal);
      expect(caller.signal.aborted).toBe(false);
      expect(fetchSignal?.aborted).toBe(true);
    }
  );

  it("lets internal timeout win over a hanging 200 success body", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => hangingBodyResponse(200));
    const pending = fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const captured = expect(pending).rejects.toMatchObject({
      kind: "timeout",
      httpStatus: 200
    });
    await vi.advanceTimersByTimeAsync(20);
    await captured;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps caller abort over a hanging HTTP status body", async () => {
    const caller = new AbortController();
    let deliver: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      deliver = resolve;
    }));
    const pending = fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      abortSignal: caller.signal,
      timeoutMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    deliver?.(hangingBodyResponse(400));
    await Promise.resolve();
    caller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted", httpStatus: 400 });
    expect(caller.signal.aborted).toBe(true);
  });

  it("fails closed on a non-OK provider status", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    const error = await fetchProviderChatCompletion({
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: "mimo-v2.5",
      systemPrompt: "sys",
      userPrompt: "user",
      fetchImpl: fetchImpl as unknown as typeof fetch
    }).then(
      () => {
        throw new Error("expected provider failure");
      },
      (cause: unknown) => cause
    );
    expect(error).toMatchObject({
      name: "ProviderChatCompletionError",
      kind: "http_error",
      httpStatus: 429,
      status: 429
    });
    expect(Object.hasOwn(error as object, "status")).toBe(true);
  });

  it("classifies a rejected fetch as a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("connect failed"), { code: "ECONNRESET" });
    });
    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ kind: "network_error" });
  });

  it("classifies a successful-status body-read failure separately from HTTP status", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: vi.fn().mockRejectedValue(new Error("body failed"))
    } as unknown as Response));
    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ kind: "body_read_error", httpStatus: 200 });
  });

  it("keeps HTTP status when the diagnostic error body cannot be read", async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("body failed")); }
    }), { status: 400 }));
    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ kind: "http_error", httpStatus: 400 });
  });

  it("classifies invalid JSON as a response parse failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ kind: "response_parse_error", inspectionReason: "parse" });
  });

  it("classifies a JSON array as a schema inspection failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ kind: "response_parse_error", inspectionReason: "schema" });
  });

  it("classifies a non-object JSON payload as a schema inspection failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("null", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ kind: "response_parse_error", inspectionReason: "schema" });
  });

  it("classifies mixed stream delta and message content as a schema inspection failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {"choices":[{"message":{"content":"b"}}]}\n\n' +
      "data: [DONE]\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));
    await expect(fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      mode: "sse",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toMatchObject({ kind: "response_parse_error", inspectionReason: "schema" });
  });

  it("exposes safe provider identity without retaining the raw error body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 600003, type: "provider_error", message: "secret upstream message" }
    }), { status: 400, headers: { "content-type": "application/json" } }));

    const error = await fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    }).then(
      () => {
        throw new Error("expected provider failure");
      },
      (cause: unknown) => cause
    );

    expect(error).toMatchObject({
      kind: "http_error",
      httpStatus: 400,
      providerCode: "600003",
      providerType: "provider_error",
      bodyDigest: null
    });
    expect(error).not.toHaveProperty("rawBody");
    expect(JSON.stringify(error)).not.toMatch(/secret|rawBody|600003|provider_error/iu);
    expect((error as Error).message).not.toMatch(/secret/iu);
  });

  it("digests a bounded error-body prefix and cancels the unread tail", async () => {
    let cancelled = false;
    const prefix = "x".repeat(16 * 1024);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${prefix}secret-tail`));
      },
      cancel() {
        cancelled = true;
      }
    }), { status: 400 }));

    const error = await fetchProviderChatCompletion({
      ...CHAT_REQUEST,
      fetchImpl: fetchImpl as unknown as typeof fetch
    }).then(
      () => {
        throw new Error("expected provider failure");
      },
      (cause: unknown) => cause
    );

    expect(error).toMatchObject({
      kind: "http_error",
      httpStatus: 400,
      providerCode: null,
      providerType: null,
      bodyDigest: createHash("sha256").update(prefix, "utf8").digest("hex")
    });
    expect((error as Error).message).not.toMatch(/secret-tail/iu);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});

function hangingBodyResponse(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status });
}
