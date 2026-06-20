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
