import { describe, expect, it, vi } from "vitest";
import {
  SignalExtractorError,
  createPiMonoExtractor,
  type PiMonoAssistantMessage,
  type PiMonoModel} from "../../../garden/extraction/pi-mono-extractor.js";


describe("pi-mono-extractor JSON recovery (Phase A.3)", () => {
  it("strips a ```json markdown fence wrapping the envelope", async () => {
    const wrapped = '```json\n{"signals":[]}\n```';
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete: vi.fn(async () => createAssistantMessage(wrapped)),
      getModel: vi.fn(() => createModel())
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
      getModel: vi.fn(() => createModel())
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
      getModel: vi.fn(() => createModel())
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

  it("throws invalid_json with failure_non_retryable_response on the first attempt", async () => {
    const complete = vi.fn(async () => createAssistantMessage("entirely freeform prose"));
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      complete,
      getModel: vi.fn(() => createModel())
    });
    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "t" }))
      .rejects.toMatchObject({
        name: "SignalExtractorError",
        kind: "invalid_json",
        retryCount: 0,
        retryClassification: "failure_non_retryable_response"
      } satisfies Partial<SignalExtractorError>);
    expect(complete).toHaveBeenCalledTimes(1);
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
