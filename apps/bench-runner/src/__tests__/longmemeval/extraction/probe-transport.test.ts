import { describe, expect, it, vi } from "vitest";
import {
  createGardenHttpExtractor
} from "../../../longmemeval/compile-seed/compile-seed-http.js";
import type {
  CompileSeedExtractionConfig
} from "../../../longmemeval/compile-seed/compile-seed-types.js";

const CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "gpt-5.4-mini",
  modelFamily: "gpt-5.4-mini",
  requestProfile: "provider-default-v1",
  apiKey: "test-key"
};

describe("extraction probe transport", () => {
  it("performs exactly one HTTP attempt when probe retry is disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("fixture transport unavailable")
    );
    const extractor = createGardenHttpExtractor(CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });

    let thrown: unknown;
    try {
      await extractor.extract({
        systemPrompt: "system",
        userPrompt: "user",
        retryMode: "disabled"
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((thrown as { benchRetry?: { retryCount?: number } }).benchRetry?.retryCount)
      .toBe(0);
  });

  it("does not schedule a timeout retry when the one probe attempt stalls", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new Error("request aborted")));
      })
    );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });

    let thrown: unknown;
    try {
      await extractor.extract({
        systemPrompt: "system",
        userPrompt: "user",
        retryMode: "disabled",
        timeoutMs: 10
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect((thrown as { benchRetry?: { retryCount?: number; retryClassification?: string } })
      .benchRetry).toMatchObject({ retryCount: 0, retryClassification: "failure_timeout" });
  });
});
