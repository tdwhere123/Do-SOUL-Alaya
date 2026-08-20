import { describe, expect, it, vi } from "vitest";
import {
  SignalExtractorError,
  createPiMonoExtractor,
  type PiMonoAssistantMessage,
  type PiMonoContext,
  type PiMonoModel,
  type PiMonoStreamOptions
} from "../../garden/pi-mono-extractor.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "../../garden/compute-provider.js";

// The `complete` seam shape — used as the explicit generic on vi.fn so
// mock.calls[i] is typed as [PiMonoModel, PiMonoContext, PiMonoStreamOptions?]
// instead of vitest's default `[]` inference from a zero-arg arrow.
type PiMonoCompleteFn = NonNullable<
  Parameters<typeof createPiMonoExtractor>[0]["complete"]
>;

describe("pi-mono-extractor-contract", () => {
  it("passes exact prompts and provider options into the transport seam", async () => {
    const signal = new AbortController().signal;
    const completeImpl = vi.fn<PiMonoCompleteFn>(async () =>
      createAssistantMessage('{"signals":[]}')
    );
    const model = createModel();
    const extractor = createPiMonoExtractor({
      apiKey: "sk-live",
      model: "gpt-4.1-mini",
      complete: completeImpl,
      getModel: vi.fn(() => model)
    });

    await expect(
      extractor.extract({
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        userPrompt: "turn payload",
        abortSignal: signal,
        timeoutMs: 456
      })
    ).resolves.toEqual({
      rawJson: '{"signals":[]}',
      extractorMeta: {
        recoveryKind: "none",
        retryCount: 0,
        retryClassification: "success_first_try"
      }
    });

    const firstCall = completeImpl.mock.calls[0]!;
    const [seenModel, context, options] = firstCall;
    expect(seenModel).toBe(model);
    expect(context.systemPrompt).toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(context.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "turn payload"
      })
    ]);
    // options is non-null on every production call (the extractor always
    // passes apiKey / signal / maxRetries / onPayload).
    expect(options).toBeDefined();
    expect(options!.apiKey).toBe("sk-live");
    expect(options!.signal).toBe(signal);
    expect(options!.timeoutMs).toBe(456);
    expect(options!.maxRetries).toBe(0);
    expect(options!.temperature).toBe(0);
    expect(options!.onPayload).toEqual(expect.any(Function));
    // The fetch transport builds its chat/completions body from these inputs:
    // exact system/user messages, temperature 0, JSON response_format.
    const body = options!.onPayload!(
      {
        model: seenModel.id,
        temperature: options!.temperature,
        messages: [
          { role: "system", content: context.systemPrompt },
          { role: "user", content: context.messages[0]!.content }
        ]
      },
      seenModel
    );
    expect(body).toEqual({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: OFFICIAL_API_SYSTEM_PROMPT },
        { role: "user", content: "turn payload" }
      ]
    });
  });

  it("requests JSON mode for OpenAI Responses and Chat Completions payloads", async () => {
    let options: PiMonoStreamOptions | undefined;
    const completeImpl = vi.fn(async (_model: PiMonoModel, _context: PiMonoContext, seenOptions?: PiMonoStreamOptions) => {
      options = seenOptions;
      return createAssistantMessage('{"signals":[]}');
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: completeImpl,
      getModel: vi.fn(() => createModel())
    });

    await extractor.extract({
      systemPrompt: "system",
      userPrompt: "turn"
    });

    expect(options?.onPayload?.({ input: [], stream: true }, createModel())).toEqual({
      input: [],
      stream: true,
      temperature: 0,
      text: { format: { type: "json_object" } }
    });
    expect(options?.onPayload?.({ messages: [], stream: true }, createModel())).toEqual({
      messages: [],
      stream: true,
      temperature: 0,
      response_format: { type: "json_object" }
    });
  });

  it("resolves endpoint overrides into the OpenAI-compatible base URL on the seam", async () => {
    const completeImpl = vi.fn<PiMonoCompleteFn>(async () =>
      createAssistantMessage('{"signals":[]}')
    );
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "custom-model",
      endpoint: "https://proxy.example.test/v1/chat/completions",
      complete: completeImpl,
      getModel: vi.fn(() => createModel())
    });

    await extractor.extract({
      systemPrompt: "system",
      userPrompt: "turn"
    });

    const [model] = completeImpl.mock.calls[0]!;
    expect(model.id).toBe("gpt-4.1-mini");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://proxy.example.test/v1");
  });

  it("does not infer retry policy from a 5xx-shaped injected port error", async () => {
    const complete = vi.fn(async () => {
      const error = new Error("HTTP 503 Service Unavailable");
      (error as { status?: number }).status = 503;
      throw error;
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-live",
      model: "custom-model",
      complete
    });
    await expect(
      extractor.extract({ systemPrompt: "sys", userPrompt: "turn" })
    ).rejects.toMatchObject({
      kind: "transport_failure",
      retryClassification: "failure_transport_port"
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not retry a 4xx from the injected transport", async () => {
    const complete = vi.fn(async () => {
      const error = new Error("HTTP 401 Unauthorized");
      (error as { status?: number }).status = 401;
      throw error;
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-live",
      model: "custom-model",
      complete
    });
    await expect(
      extractor.extract({ systemPrompt: "sys", userPrompt: "turn" })
    ).rejects.toMatchObject({
      kind: "transport_failure",
      retryClassification: "failure_transport_port"
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("maps invalid JSON, timeout, and transport failures to typed extractor errors", async () => {
    const invalidJsonComplete = vi.fn(async () => createAssistantMessage("not json"));
    const invalidJsonExtractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: invalidJsonComplete,
      getModel: vi.fn(() => createModel())
    });
    await expect(invalidJsonExtractor.extract({ systemPrompt: "system", userPrompt: "turn" }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "invalid_json",
        retryCount: 0,
        retryClassification: "failure_non_retryable_response"
      } satisfies Partial<SignalExtractorError>);
    expect(invalidJsonComplete).toHaveBeenCalledTimes(1);

    const timeoutExtractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => {
        throw new SignalExtractorError("timeout", "request timed out", {
          retryClassification: "failure_timeout"
        });
      }),
      getModel: vi.fn(() => createModel())
    });
    await expect(timeoutExtractor.extract({ systemPrompt: "system", userPrompt: "turn", timeoutMs: 5 }))
      .rejects.toMatchObject({ name: "SignalExtractorError", kind: "timeout" } satisfies Partial<SignalExtractorError>);

    const transportExtractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      // 4xx-other-than-429: hard fail, no retry.
      complete: vi.fn(async () => {
        const err = new Error("HTTP 401 unauthorized");
        (err as { status?: number }).status = 401;
        throw err;
      }),
      getModel: vi.fn(() => createModel())
    });
    await expect(transportExtractor.extract({ systemPrompt: "system", userPrompt: "turn" }))
      .rejects.toMatchObject({ name: "SignalExtractorError", kind: "transport_failure", retryCount: 0 } satisfies Partial<SignalExtractorError>);
  });
});

// Phase A.3 instrument coverage: tryRecoverJson must salvage three quirks
// observed on yunwu.ai-routed gpt-4.1-mini extraction calls without
// fabricating content. Each strategy is invoked through the public
// extract() seam so the recoveryKind / retryCount surfaces on the meta.

function createModel(): PiMonoModel {
  return {
    id: "gpt-4.1-mini",
    name: "GPT 4.1 mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192
  };
}

function createAssistantMessage(text: string): PiMonoAssistantMessage {
  return {
    content: [{ type: "text", text }]
  };
}
