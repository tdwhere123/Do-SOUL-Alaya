import { afterEach, describe, expect, it, vi } from "vitest";
import { requestGardenChatCompletionContent } from "../../ai/garden-chat-completion.js";

afterEach(() => {
  vi.useRealTimers();
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

  it("retries a 503 once after 100ms then succeeds", async () => {
    const sleep = vi.spyOn(globalThis, "setTimeout");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
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

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.some((call) => call[1] === 100)).toBe(true);
  });

  it("does not retry HTTP 600 because canonical retry is 429 and 5xx only", async () => {
    // Fetch Response rejects status 600; providers can still emit it.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 600,
      statusText: "Unknown",
      headers: new Headers(),
      body: null
    } as unknown as Response);

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
    })).rejects.toMatchObject({ message: "garden test HTTP 600" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a deterministic empty-content 200", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "   " } }]
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
    })).rejects.toThrow("garden test returned no content");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid JSON", "{not-json"],
    ["a JSON array schema miss", "[]"],
    ["a non-object schema miss", "null"]
  ] as const)("does not retry %s", async (_name, body) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
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
    })).rejects.toMatchObject({ name: "GardenChatCompletionTransportError" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503] as const)(
    "does not retry a hanging HTTP %s diagnostic body after internal timeout",
    async (status) => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        hangingBodyResponse(status)
      );
      const pending = requestGardenChatCompletionContent(gardenRequest(20));
      const captured = pending.then(
        () => {
          throw new Error("expected garden timeout");
        },
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(400);
      const error = await captured;

      expect(error).toMatchObject({
        name: "GardenChatCompletionTransportError",
        kind: "timeout"
      });
      expect(Object.hasOwn(error as object, "status")).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  );

  it("does not retry a hanging 200 success body after internal timeout", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      hangingBodyResponse(200)
    );
    const pending = requestGardenChatCompletionContent(gardenRequest(20));
    const captured = pending.then(
      () => {
        throw new Error("expected garden timeout");
      },
      (error: unknown) => error
    );

    await vi.advanceTimersByTimeAsync(400);
    const error = await captured;

    expect(error).toMatchObject({
      name: "GardenChatCompletionTransportError",
      kind: "timeout"
    });
    expect(Object.hasOwn(error as object, "status")).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

function gardenRequest(timeoutMs: number) {
  return {
    config: {
      providerUrl: "https://garden.example.test/v1",
      model: "garden-model",
      apiKey: "sk-garden-secret"
    },
    systemPrompt: "system",
    userPrompt: "user",
    timeoutMs,
    failureLabel: "garden test"
  } as const;
}

function hangingBodyResponse(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status });
}
