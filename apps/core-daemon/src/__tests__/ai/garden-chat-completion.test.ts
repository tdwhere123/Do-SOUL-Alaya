import { afterEach, describe, expect, it, vi } from "vitest";
import { requestGardenChatCompletionContent } from "../../ai/garden-chat-completion.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestGardenChatCompletionContent", () => {
  it("unrefs the request timeout so a pending provider call does not pin shutdown", async () => {
    const unref = vi.fn();
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((...args: Parameters<typeof setTimeout>) => {
        const handle = originalSetTimeout(...args);
        return Object.assign(handle, { unref }) as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{\"kind\":\"add\"}" } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await expect(requestGardenChatCompletionContent({
      config: {
        providerUrl: "https://garden.example.test/v1",
        model: "garden-model",
        apiKey: "sk-garden-secret"
      },
      systemPrompt: "system",
      userPrompt: "user",
      timeoutMs: 50,
      failureLabel: "garden test"
    })).resolves.toBe("{\"kind\":\"add\"}");

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(unref).toHaveBeenCalled();
  });

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
