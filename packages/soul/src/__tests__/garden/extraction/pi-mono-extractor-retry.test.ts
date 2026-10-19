import { afterAll, describe, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../../apps/bench-runner/src/__tests__/support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterAll(() => {
  isolation.strict.restore();
  isolation.safe.restore();
  expect(isolation.safe.violations).toEqual([]);
  expect(isolation.strict.forbidden).toEqual([]);
});
import {
  SignalExtractorError,
  createPiMonoExtractor,
  type PiMonoAssistantMessage
} from "../../../garden/extraction/pi-mono-extractor.js";

describe("pi-mono transport-neutral completion port", () => {
  it("does not infer HTTP retry policy from an injected port error", async () => {
    const complete = vi.fn(async () => {
      throw Object.assign(new Error("HTTP 503"), { status: 503 });
    });
    const extractor = createPiMonoExtractor({ apiKey: "sk-test", model: "model", complete });

    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "u" }))
      .rejects.toMatchObject({
        kind: "transport_failure",
        retryClassification: "failure_transport_port"
      } satisfies Partial<SignalExtractorError>);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("preserves the execution receipt supplied by the transport port", async () => {
    const extractor = createPiMonoExtractor({
      apiKey: "sk-test",
      model: "model",
      complete: async () => message('{"signals":[]}', {
        retryCount: 2,
        retryClassification: "success_after_retry"
      })
    });

    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "u" }))
      .resolves.toMatchObject({
        extractorMeta: { retryCount: 2, retryClassification: "success_after_retry" }
      });
  });

  it("preserves consumer validation failures rather than labeling them transport failures", async () => {
    const complete = vi.fn(async () => message('{"signals":[]}'));
    const extractor = createPiMonoExtractor({ apiKey: "sk-test", model: "model", complete });
    const failure = new Error("response schema rejected");

    await expect(extractor.extract({
      systemPrompt: "s", userPrompt: "u",
      validateRawJson: () => { throw failure; }
    })).rejects.toBe(failure);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("keeps JSON recovery failure consumer-owned and terminal", async () => {
    const complete = vi.fn(async () => message("not json"));
    const extractor = createPiMonoExtractor({ apiKey: "sk-test", model: "model", complete });

    await expect(extractor.extract({ systemPrompt: "s", userPrompt: "u" }))
      .rejects.toMatchObject({
        kind: "invalid_json",
        retryClassification: "failure_non_retryable_response"
      } satisfies Partial<SignalExtractorError>);
    expect(complete).toHaveBeenCalledOnce();
  });
});

function message(
  text: string,
  executionMeta?: PiMonoAssistantMessage["executionMeta"]
): PiMonoAssistantMessage {
  return {
    content: [{ type: "text", text }],
    ...(executionMeta === undefined ? {} : { executionMeta })
  };
}
