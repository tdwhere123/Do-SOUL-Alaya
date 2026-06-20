import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingClient } from "../../embedding-recall/embedding-recall-service.js";

describe("OpenAIEmbeddingClient", () => {
  it("reports provider host and transport cause without including the secret", async () => {
    const transportError = new TypeError("fetch failed") as TypeError & {
      cause: { code: string };
    };
    transportError.cause = { code: "EHOSTUNREACH" };
    const fetchImpl = vi.fn(async () => {
      throw transportError;
    }) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 1
    });

    await expect(
      client.embedTexts(["smoke"], {
        timeoutMs: 1000
      })
    ).rejects.toThrow(
      "Embedding request transport failed for host embedding.example.test. cause=EHOSTUNREACH"
    );
    await expect(
      client.embedTexts(["smoke"], {
        timeoutMs: 1000
      })
    ).rejects.not.toThrow("sk-test-secret");
  });

  it("uses the official OpenAI URL by default but still allows an override", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.9] }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    const defaultClient = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      fetchImpl
    });
    await defaultClient.embedTexts(["default"], { timeoutMs: 1000 });

    const overrideClient = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl
    });
    await overrideClient.embedTexts(["override"], { timeoutMs: 1000 });

    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/embeddings");
    expect(vi.mocked(fetchImpl).mock.calls[1]?.[0]).toBe("https://embedding.example.test/v1/embeddings");
  });

  it("retries transient transport failures before returning embeddings", async () => {
    const transportError = new TypeError("fetch failed") as TypeError & {
      cause: { code: string };
    };
    transportError.cause = { code: "EHOSTUNREACH" };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.2, 0.8] }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      ) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0
    });

    const embeddings = await client.embedTexts(["smoke"], {
      timeoutMs: 1000
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...embeddings[0]!]).toEqual([
      expect.closeTo(0.2),
      expect.closeTo(0.8)
    ]);
  });

  it("retries transient 5xx responses before returning embeddings", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.4, 0.6] }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      ) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0
    });

    const embeddings = await client.embedTexts(["smoke"], {
      timeoutMs: 1000
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...embeddings[0]!]).toEqual([
      expect.closeTo(0.4),
      expect.closeTo(0.6)
    ]);
  });

  // invariant: embedTexts MUST settle (reject) when the transport never
  // resolves AND the abort signal is ignored (the undici half-open stall). Only
  // the wall-clock backstop guarantees this; without it the guard race below
  // observes "HANG".
  // see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.raceFetchAgainstBackstop
  // see also: packages/core/src/embedding-recall/constants.ts:EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS
  it("rejects via the wall-clock backstop when the transport never settles and the abort is ignored", async () => {
    // seam: never-resolving fetch that ignores the abort signal == half-open
    // undici socket the AbortController cannot terminate.
    let fetchCalls = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCalls += 1;
      return await new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 1,
      // invariant: 50ms abort + 20ms margin -> settles ~70ms, never the 10s budget.
      transportBackstopMarginMs: 20
    });

    const embed = client.embedTexts(["smoke"], { timeoutMs: 50 });

    const guard = new Promise<"HANG">((resolve) => {
      const handle = setTimeout(() => resolve("HANG"), 1_000);
      handle.unref?.();
    });
    const outcome = await Promise.race([
      embed.then(
        () => "RESOLVED" as const,
        (error: unknown) => ({ rejected: error instanceof Error ? error.message : String(error) })
      ),
      guard
    ]);

    expect(outcome).not.toBe("HANG");
    expect(outcome).not.toBe("RESOLVED");
    expect(outcome).toMatchObject({
      rejected: expect.stringContaining(
        "Embedding request transport failed for host embedding.example.test."
      )
    });
    expect(fetchCalls).toBe(1);
  });

  // invariant: a transient provider blip (N-1 transport failures then success)
  // is ridden through, with an EXPONENTIAL + JITTERED backoff gap actually
  // awaited between attempts. fake timers prove the gap is consumed without
  // sleeping real seconds; onRetry proves the gaps are exponential. proof under
  // revert: a zero-backoff loop reports delayMs 0; a no-retry loop rejects on
  // the first transport error.
  // see also: packages/core/src/embedding-recall/openai-client.ts:computeEmbeddingBackoffMs
  // see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.fetchEmbeddingWithRetry
  it("rides through transient transport blips with exponential jittered backoff", async () => {
    vi.useFakeTimers();
    try {
      const transportError = new TypeError("fetch failed");
      const fetchImpl = vi.fn()
        .mockRejectedValueOnce(transportError)
        .mockRejectedValueOnce(transportError)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: [{ index: 0, embedding: [0.3, 0.7] }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        ) as unknown as typeof fetch;
      const retryEvents: Array<{ attempt: number; delayMs: number; reason: string }> = [];
      const client = new OpenAIEmbeddingClient({
        apiKey: "sk-test-secret",
        baseUrl: "https://embedding.example.test/v1",
        fetchImpl,
        maxAttempts: 5,
        retryDelayMs: 100,
        // invariant: random==0.5 -> jitter = floor(0.5 * base) = 50ms; gaps are
        // 100+50=150 then 200+50=250 (exponential base*2^attemptIndex + jitter).
        random: () => 0.5,
        onRetry: (event) => {
          retryEvents.push({
            attempt: event.attempt,
            delayMs: event.delayMs,
            reason: event.reason
          });
        }
      });

      const embedPromise = client.embedTexts(["smoke"], { timeoutMs: 1000 });
      // Drain the two transport rejections + their awaited backoff gaps.
      await vi.runAllTimersAsync();
      const embeddings = await embedPromise;

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect([...embeddings[0]!]).toEqual([
        expect.closeTo(0.3),
        expect.closeTo(0.7)
      ]);
      expect(retryEvents).toEqual([
        { attempt: 1, delayMs: 150, reason: "transport_error" },
        { attempt: 2, delayMs: 250, reason: "transport_error" }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // invariant: a persistently-down provider is NOT masked; after maxAttempts the
  // clean transport surface throws (bounded, no infinite loop). proof under
  // revert: an unbounded loop never settles; a swallowed error breaks the
  // asserted transport message.
  it("throws the clean transport error after exhausting maxAttempts", async () => {
    vi.useFakeTimers();
    try {
      const transportError = new TypeError("fetch failed") as TypeError & {
        cause: { code: string };
      };
      transportError.cause = { code: "ECONNRESET" };
      const fetchImpl = vi.fn(async () => {
        throw transportError;
      }) as unknown as typeof fetch;
      const client = new OpenAIEmbeddingClient({
        apiKey: "sk-test-secret",
        baseUrl: "https://embedding.example.test/v1",
        fetchImpl,
        maxAttempts: 4,
        retryDelayMs: 100,
        random: () => 0
      });

      const embedPromise = client.embedTexts(["smoke"], { timeoutMs: 1000 });
      const settled = embedPromise.then(
        () => "RESOLVED" as const,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      await vi.runAllTimersAsync();
      const outcome = await settled;

      expect(outcome).toBe(
        "Embedding request transport failed for host embedding.example.test. cause=ECONNRESET"
      );
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // invariant: non-retryable 4xx (e.g. 401) FAILS FAST -- no retry, single fetch.
  // proof under revert: if isRetryableEmbeddingStatus admits 4xx, fetch count
  // and onRetry both rise above the asserted single call.
  it("does not retry non-retryable 4xx responses", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("unauthorized", { status: 401 })
    ) as unknown as typeof fetch;
    const onRetry = vi.fn();
    const client = new OpenAIEmbeddingClient({
      apiKey: "sk-test-secret",
      baseUrl: "https://embedding.example.test/v1",
      fetchImpl,
      maxAttempts: 5,
      retryDelayMs: 100,
      onRetry
    });

    await expect(
      client.embedTexts(["smoke"], { timeoutMs: 1000 })
    ).rejects.toThrow(
      "Embedding request failed with status 401 for host embedding.example.test."
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // invariant: the total wall-clock ceiling stops a NEW attempt from starting
  // once the budget is spent, so a stalling provider cannot compound per-attempt
  // timeouts into minutes. injected clock makes the deadline deterministic.
  // proof under revert: without the deadline guard, fetch is called the full
  // maxAttempts times instead of stopping at 2.
  it("stops starting new attempts past the total wall-clock budget", async () => {
    vi.useFakeTimers();
    try {
      const transportError = new TypeError("fetch failed");
      const fetchImpl = vi.fn(async () => {
        throw transportError;
      }) as unknown as typeof fetch;
      let clock = 0;
      const client = new OpenAIEmbeddingClient({
        apiKey: "sk-test-secret",
        baseUrl: "https://embedding.example.test/v1",
        fetchImpl,
        maxAttempts: 5,
        retryDelayMs: 100,
        random: () => 0,
        totalWallclockBudgetMs: 500,
        // invariant: each clock read advances 300ms; attempt 1 reads start (0),
        // catch reads 300 (< 500, retry), attempt 2 catch reads 900 (>= 500,
        // throw) -> only 2 fetches despite maxAttempts 5.
        now: () => {
          const value = clock;
          clock += 300;
          return value;
        }
      });

      const embedPromise = client.embedTexts(["smoke"], { timeoutMs: 1000 });
      const settled = embedPromise.then(
        () => "RESOLVED" as const,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      await vi.runAllTimersAsync();
      const outcome = await settled;

      expect(outcome).toBe(
        "Embedding request transport failed for host embedding.example.test."
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
