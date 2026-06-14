import { afterEach, describe, expect, it, vi } from "vitest";
import { requestGardenChatCompletionContent } from "../../ai/garden-chat-completion.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestGardenChatCompletionContent", () => {
  it("redacts the API key from transport error causes", async () => {
    const apiKey = "sk-garden-secret";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error(`transport failed while sending Bearer ${apiKey}`)
    );

    let thrown: unknown;
    try {
      await requestGardenChatCompletionContent({
        config: {
          providerUrl: "https://garden.example.test/v1",
          model: "garden-model",
          apiKey
        },
        systemPrompt: "system",
        userPrompt: "user",
        timeoutMs: 50,
        failureLabel: "garden test"
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as { readonly cause?: unknown }).cause)).not.toContain(apiKey);
    expect(String((thrown as { readonly cause?: unknown }).cause)).toContain("[REDACTED_SECRET]");
  });
});
