import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import {
  SignalExtractorError,
  createPiMonoExtractor
} from "../garden/pi-mono-extractor.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "../garden/compute-provider.js";

describe("pi-mono-extractor-contract", () => {
  it("passes exact prompts and provider options into pi-ai complete", async () => {
    const signal = new AbortController().signal;
    const completeImpl = vi.fn(async () => createAssistantMessage('{"signals":[]}'));
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
    ).resolves.toEqual({ rawJson: '{"signals":[]}' });

    const [seenModel, context, options] = completeImpl.mock.calls[0] as [
      Model<string>,
      Context,
      ProviderStreamOptions
    ];
    expect(seenModel).toBe(model);
    expect(context.systemPrompt).toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(context.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "turn payload"
      })
    ]);
    expect(options.apiKey).toBe("sk-live");
    expect(options.signal).toBe(signal);
    expect(options.timeoutMs).toBe(456);
    expect(options.maxRetries).toBe(0);
    expect(options.onPayload).toEqual(expect.any(Function));
  });

  it("requests JSON mode for OpenAI Responses and Chat Completions payloads", async () => {
    let options: ProviderStreamOptions | undefined;
    const completeImpl = vi.fn(async (_model: Model<string>, _context: Context, seenOptions?: ProviderStreamOptions) => {
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

  it("passes endpoint overrides to pi-ai as an OpenAI-compatible base URL", async () => {
    const completeImpl = vi.fn(async () => createAssistantMessage('{"signals":[]}'));
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

    const [model] = completeImpl.mock.calls[0] as [Model<string>, Context, ProviderStreamOptions];
    expect(model.id).toBe("gpt-4.1-mini");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://proxy.example.test/v1");
  });

  it("maps invalid JSON, timeout, and transport failures to typed extractor errors", async () => {
    const invalidJsonExtractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => createAssistantMessage("not json")),
      getModel: vi.fn(() => createModel())
    });
    await expect(invalidJsonExtractor.extract({ systemPrompt: "system", userPrompt: "turn" }))
      .rejects.toMatchObject({ name: "SignalExtractorError", kind: "invalid_json" } satisfies Partial<SignalExtractorError>);

    const timeoutExtractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => {
        throw new Error("request timed out");
      }),
      getModel: vi.fn(() => createModel())
    });
    await expect(timeoutExtractor.extract({ systemPrompt: "system", userPrompt: "turn", timeoutMs: 5 }))
      .rejects.toMatchObject({ name: "SignalExtractorError", kind: "timeout" } satisfies Partial<SignalExtractorError>);

    const transportExtractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      getModel: vi.fn(() => createModel())
    });
    await expect(transportExtractor.extract({ systemPrompt: "system", userPrompt: "turn" }))
      .rejects.toMatchObject({ name: "SignalExtractorError", kind: "transport_failure" } satisfies Partial<SignalExtractorError>);
  });
});

function createModel(): Model<string> {
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

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1-mini",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}
