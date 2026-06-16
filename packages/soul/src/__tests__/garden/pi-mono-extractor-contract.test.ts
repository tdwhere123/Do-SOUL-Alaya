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

  it("default fetch transport POSTs to {baseUrl}/chat/completions with bearer auth and JSON body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"signals":[]}' } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      // No injected complete: exercises the production fetch default.
      const extractor = createPiMonoExtractor({
        apiKey: "sk-live",
        model: "custom-model",
        endpoint: "https://proxy.example.test/v1/chat/completions"
      });

      await expect(
        extractor.extract({
          systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
          userPrompt: "turn payload"
        })
      ).resolves.toEqual({
        rawJson: '{"signals":[]}',
        extractorMeta: {
          recoveryKind: "none",
          retryCount: 0,
          retryClassification: "success_first_try"
        }
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://proxy.example.test/v1/chat/completions");
      expect(init!.method).toBe("POST");
      const headers = init!.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-live");
      expect(headers["content-type"]).toBe("application/json");
      expect(JSON.parse(init!.body as string)).toEqual({
        model: "custom-model",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: OFFICIAL_API_SYSTEM_PROMPT },
          { role: "user", content: "turn payload" }
        ]
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps invalid JSON, timeout, and transport failures to typed extractor errors", async () => {
    const invalidJsonExtractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      // Both attempts return un-recoverable text so the retry budget is
      // spent and the typed error escapes.
      complete: vi.fn(async () => createAssistantMessage("not json")),
      getModel: vi.fn(() => createModel()),
      sleep: vi.fn(async () => undefined),
      random: vi.fn(() => 0.5)
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
      // 4xx-other-than-429: hard fail, no retry.
      complete: vi.fn(async () => {
        const err = new Error("HTTP 401 unauthorized");
        (err as { status?: number }).status = 401;
        throw err;
      }),
      getModel: vi.fn(() => createModel()),
      sleep: vi.fn(async () => undefined),
      random: vi.fn(() => 0.5)
    });
    await expect(transportExtractor.extract({ systemPrompt: "system", userPrompt: "turn" }))
      .rejects.toMatchObject({ name: "SignalExtractorError", kind: "transport_failure", retryCount: 0 } satisfies Partial<SignalExtractorError>);
  });
});

// Phase A.3 instrument coverage: tryRecoverJson must salvage three quirks
// observed on yunwu.ai-routed gpt-4.1-mini extraction calls without
// fabricating content. Each strategy is invoked through the public
// extract() seam so the recoveryKind / retryCount surfaces on the meta.
describe("pi-mono-extractor JSON recovery (Phase A.3)", () => {
  it("strips a ```json markdown fence wrapping the envelope", async () => {
    const wrapped = '```json\n{"signals":[]}\n```';
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => createAssistantMessage(wrapped)),
      getModel: vi.fn(() => createModel()),
      sleep: vi.fn(async () => undefined),
      random: vi.fn(() => 0.5)
    });
    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta).toEqual({
      recoveryKind: "markdown_strip",
      retryCount: 0,
      retryClassification: "success_first_try"
    });
  });

  it("strips trailing prose after a balanced top-level object", async () => {
    const trailing = '{"signals":[]}\n\nNote: the turn had no durable facts.';
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => createAssistantMessage(trailing)),
      getModel: vi.fn(() => createModel()),
      sleep: vi.fn(async () => undefined),
      random: vi.fn(() => 0.5)
    });
    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta).toEqual({
      recoveryKind: "trailing_strip",
      retryCount: 0,
      retryClassification: "success_first_try"
    });
  });

  it("closes unbalanced trailing brackets on a truncated envelope", async () => {
    // Truncated mid-array: missing the closing "]}" and a dangling comma.
    const truncated = '{"signals":[{"signal_kind":"potential_claim","object_kind":"u","confidence":0.5,"matched_text":"x"},';
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => createAssistantMessage(truncated)),
      getModel: vi.fn(() => createModel()),
      sleep: vi.fn(async () => undefined),
      random: vi.fn(() => 0.5)
    });
    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    const parsed = JSON.parse(result.rawJson) as { signals: unknown[] };
    expect(parsed.signals).toHaveLength(1);
    expect(result.extractorMeta).toEqual({
      recoveryKind: "balanced_close",
      retryCount: 0,
      retryClassification: "success_first_try"
    });
  });

  it("returns recoveryKind=none when the body is already strict JSON", async () => {
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => createAssistantMessage('{"signals":[]}')),
      getModel: vi.fn(() => createModel())
    });
    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    expect(result.extractorMeta).toEqual({
      recoveryKind: "none",
      retryCount: 0,
      retryClassification: "success_first_try"
    });
  });

  it("throws invalid_json with failure_max_retries after the full retry budget", async () => {
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => createAssistantMessage("entirely freeform prose")),
      getModel: vi.fn(() => createModel()),
      sleep: vi.fn(async () => undefined),
      random: vi.fn(() => 0.5)
    });
    // Budget is 3 retries (4 total attempts) — retryCount on the thrown
    // error reflects the FINAL failed attempt's index. retryClassification
    // labels the terminal branch.
    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "t" }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "invalid_json",
        retryCount: 3,
        retryClassification: "failure_max_retries"
      } satisfies Partial<SignalExtractorError>);
  });
});

// Phase A.3 instrument coverage: a single retry on recoverable failure
// (empty body, parse error, HTTP 5xx, HTTP 429). Auth/4xx must NOT retry.
describe("pi-mono-extractor retry-with-jitter (Phase A.3)", () => {
  it("retries once after empty assistant text and surfaces retryCount=1 on success", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const random = vi.fn(() => 0.5);
    const complete = vi
      .fn<NonNullable<Parameters<typeof createPiMonoExtractor>[0]["complete"]>>()
      // First call: empty text triggers readTextContent throw.
      .mockImplementationOnce(async () => createAssistantMessage(""))
      // Second call: clean JSON body.
      .mockImplementationOnce(async () => createAssistantMessage('{"signals":[]}'));
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random
    });
    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta).toEqual({
      recoveryKind: "none",
      retryCount: 1,
      retryClassification: "success_after_retry"
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Attempt 1 backoff window: 250-500ms (base) per computeJitterMs.
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(250);
    expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(500);
  });

  it("retries up to the budget on HTTP 5xx then surfaces failure_max_retries", async () => {
    const sleep = vi.fn(async () => undefined);
    const complete = vi.fn(async () => {
      const err = new Error("garden extraction HTTP 502");
      (err as { status?: number }).status = 502;
      throw err;
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random: vi.fn(() => 0)
    });
    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "t" }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "transport_failure",
        retryCount: 3,
        retryClassification: "failure_max_retries"
      } satisfies Partial<SignalExtractorError>);
    // Budget = 1 first try + 3 retries = 4 attempts.
    expect(complete).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("retries on HTTP 429 (rate limit) and surfaces success_after_retry", async () => {
    const sleep = vi.fn(async () => undefined);
    const complete = vi
      .fn<NonNullable<Parameters<typeof createPiMonoExtractor>[0]["complete"]>>()
      .mockImplementationOnce(async () => {
        const err = new Error("HTTP 429 rate limited");
        (err as { status?: number }).status = 429;
        throw err;
      })
      .mockImplementationOnce(async () => createAssistantMessage('{"signals":[]}'));
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random: vi.fn(() => 0.25)
    });
    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    expect(result.extractorMeta?.retryCount).toBe(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on HTTP 4xx other than 429 (auth/quota) and labels failure_non_retryable_4xx", async () => {
    const sleep = vi.fn(async () => undefined);
    const complete = vi.fn(async () => {
      const err = new Error("HTTP 403 forbidden");
      (err as { status?: number }).status = 403;
      throw err;
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random: vi.fn(() => 0.5)
    });
    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "t" }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "transport_failure",
        retryCount: 0,
        retryClassification: "failure_non_retryable_4xx"
      } satisfies Partial<SignalExtractorError>);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries timeouts exactly once before surfacing failure_timeout", async () => {
    // Timeouts spend a separate (smaller) budget so a chronic slow path
    // cannot 4x the bench wall time — at most ONE retry on timeout.
    const sleep = vi.fn(async () => undefined);
    const complete = vi.fn(async () => {
      throw new Error("request timed out");
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random: vi.fn(() => 0.5)
    });
    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "t", timeoutMs: 10 }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "timeout",
        retryClassification: "failure_timeout"
      } satisfies Partial<SignalExtractorError>);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("caps the retry budget at MAX_EXTRACTOR_RETRIES extra attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const complete = vi.fn(async () => {
      const err = new Error("HTTP 503");
      (err as { status?: number }).status = 503;
      throw err;
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random: vi.fn(() => 0.5)
    });
    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "t" }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "transport_failure",
        retryCount: 3,
        retryClassification: "failure_max_retries"
      } satisfies Partial<SignalExtractorError>);
    // 4 = first attempt + 3 retries. Never 5.
    expect(complete).toHaveBeenCalledTimes(4);
  });

  // invariant: bumping the retry budget to 3 with exponential jittered
  // backoff is the v0.3.11 root-cause fix for the silent-fallback gap
  // (yunwu.ai gpt-4.1-mini empty-text storms outlasting a 1-retry policy).
  // The 5xx-then-success path must surface success_after_retry on the FINAL
  // (3rd) attempt, with retryCount=3 visible in the meta — the dump
  // consumer (compute-provider.dumpInvalidResponseDiagnostic) uses that
  // count to attribute partial recovery vs chronic failure.
  it("retries 3 times on transient 5xx then succeeds with retryCount=3", async () => {
    const sleep = vi.fn(async () => undefined);
    const complete = vi
      .fn<NonNullable<Parameters<typeof createPiMonoExtractor>[0]["complete"]>>()
      .mockImplementationOnce(async () => {
        const err = new Error("HTTP 503 svc unavailable");
        (err as { status?: number }).status = 503;
        throw err;
      })
      .mockImplementationOnce(async () => {
        const err = new Error("HTTP 503 svc unavailable");
        (err as { status?: number }).status = 503;
        throw err;
      })
      .mockImplementationOnce(async () => {
        const err = new Error("HTTP 503 svc unavailable");
        (err as { status?: number }).status = 503;
        throw err;
      })
      .mockImplementationOnce(async () => createAssistantMessage('{"signals":[]}'));
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random: vi.fn(() => 0)
    });
    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta).toEqual({
      recoveryKind: "none",
      retryCount: 3,
      retryClassification: "success_after_retry"
    });
    expect(complete).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  // invariant: HTTP 401 / 403 / 422 are deterministic — retrying spends
  // quota with no chance of success. The terminal classification must be
  // failure_non_retryable_4xx so the bench dump and the
  // seed_extraction_path live_extraction_failures counter both observe a
  // single failed attempt, never a quadrupled quota burn.
  it("does NOT retry on HTTP 401 (auth) and surfaces retryCount=0", async () => {
    const sleep = vi.fn(async () => undefined);
    const complete = vi.fn(async () => {
      const err = new Error("HTTP 401 unauthorized");
      (err as { status?: number }).status = 401;
      throw err;
    });
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel()),
      sleep,
      random: vi.fn(() => 0)
    });
    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "t" }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "transport_failure",
        retryCount: 0,
        retryClassification: "failure_non_retryable_4xx"
      } satisfies Partial<SignalExtractorError>);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

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
