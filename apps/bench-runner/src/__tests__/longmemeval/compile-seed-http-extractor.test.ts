import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  computeNextTurnSeedRefs,
  createCachingSignalExtractor,
  createCompileSeedRunner,
  createGardenHttpExtractor,
  extractContentFromChatCompletionBody,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi,
  type BenchSignalExtractor,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig,
  type CompileSeedExtractionStats
} from "../../longmemeval/compile-seed.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG
} from "./compile-seed-fixture.js";

describe("createGardenHttpExtractor retry policy", () => {
  const HTTP_CONFIG: CompileSeedExtractionConfig = {
    providerUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "sk-test"
  };

  function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  it("retries 3 times on HTTP 5xx then succeeds with retryClassification=success_after_retry", async () => {
    // Models the dominant yunwu.ai outage shape: a brief 503 storm followed
    // by recovery. The 1-retry policy bench shipped with would have given up
    // after attempt 2 and demoted the turn to the fallback path; the 3-retry
    // budget gets it through.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("svc unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("svc unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("svc unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        makeJsonResponse({ choices: [{ message: { content: '{"signals":[]}' } }] })
      );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "system",
      userPrompt: "turn"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta).toEqual({
      recoveryKind: "none",
      retryCount: 3,
      retryClassification: "success_after_retry"
    });
    // 4 = first attempt + 3 retries.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on HTTP 401 (auth) and surfaces failure_non_retryable_4xx", async () => {
    // Auth / 4xx-non-429 is deterministic; retrying spends quota with no
    // chance of success. The thrown error carries the classification so
    // dumpSeedExtractionFailureDiagnostic can surface it in the archive
    // without re-deriving from the message.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as { benchRetry?: { retryCount: number; retryClassification: string } })
      .benchRetry;
    expect(benchRetry).toEqual({
      retryCount: 0,
      retryClassification: "failure_non_retryable_4xx"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries 429 (rate limit) and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        makeJsonResponse({ choices: [{ message: { content: '{"signals":[]}' } }] })
      );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0.5
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(result.extractorMeta?.retryClassification).toBe("success_after_retry");
    expect(result.extractorMeta?.retryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps the 5xx retry budget at MAX_RETRIES extra attempts (failure_max_retries)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("svc unavailable", { status: 502 }));
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    const benchRetry = (thrown as { benchRetry?: { retryCount: number; retryClassification: string } })
      .benchRetry;
    expect(benchRetry).toEqual({
      retryCount: 3,
      retryClassification: "failure_max_retries"
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // invariant: the wall-clock guard inside createGardenHttpExtractor must
  // abort a hanging fetch even if the monotonic setTimeout has not yet fired.
  // Models the bench-runner host-suspend hang: fetch never resolves and the
  // operator-supplied timeoutMs is large enough that without the wall-clock
  // tick the test would time out.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  it("aborts a hanging fetch via AbortController so timeout retry classification fires", async () => {
    // Fetch that resolves only when the abort signal fires. timeoutMs=20ms
    // ensures the per-attempt timer triggers fast; the goal is to prove the
    // abort path WIRES through to the fetch signal and exits the await.
    // First attempt times out, then second attempt times out — exhausts the
    // 1-timeout-retry budget and surfaces failure_timeout.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_, reject) => {
          const signal = (init as RequestInit | undefined)?.signal as
            | AbortSignal
            | undefined;
          signal?.addEventListener("abort", () => {
            reject(new Error("The user aborted a request."));
          });
        })
    );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({
        systemPrompt: "s",
        userPrompt: "t",
        timeoutMs: 20
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_timeout");
    // 2 = first attempt + 1 timeout retry (BENCH_HTTP_MAX_TIMEOUT_RETRIES).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // invariant: root-cause regression. The previous test's fetch rejects when
  // its abort signal fires — i.e. it is abort-AWARE. The real wedge was a
  // STALLED undici socket that ignores controller.abort() on Node 24: the
  // timer fires, abort() is called, but the fetch promise never settles, so
  // `await fetchImpl(...)` hangs forever and the worker pool wedges with
  // failures=0. The Promise.race backstop must reject the attempt on the
  // timer even though this fetch ignores its signal. WITHOUT the fix this
  // test hangs until the vitest timeout; WITH the fix it surfaces
  // failure_timeout within budget.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  it("settles a never-resolving fetch that ignores its abort signal via the timeout backstop", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // Never settles and never reads the signal — the stalled-socket shape.
      .mockImplementation(() => new Promise<Response>(() => {}));
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({
        systemPrompt: "s",
        userPrompt: "t",
        timeoutMs: 20
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_timeout");
    // 2 = first attempt + 1 timeout retry (BENCH_HTTP_MAX_TIMEOUT_RETRIES);
    // each attempt is forced to settle by the backstop rather than hanging.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // invariant: an operator abort (input.abortSignal) must settle the attempt
  // PROMPTLY and classify failure_aborted (never retried) even when the fetch
  // ignores its abort signal and never settles. abort() alone does not settle
  // for that stalled-socket shape, so without the settlement reject the attempt
  // would wait the full budget and then misclassify as failure_timeout.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts settleOperatorAbort.
  it("settles failure_aborted (no retry) on operator abort even when the fetch ignores its signal", async () => {
    const operator = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      // Never settles and never reads the signal — the abort-ignoring stalled
      // socket. Without the operator-abort settlement this hangs to the full
      // budget; with it the race settles as soon as the operator aborts.
      .mockImplementation(() => {
        // Abort mid-flight, after the attempt has wired its listener.
        queueMicrotask(() => operator.abort());
        return new Promise<Response>(() => {});
      });
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({
        systemPrompt: "s",
        userPrompt: "t",
        // Large budget so a failure_timeout would only appear after 60s; the
        // test settling promptly proves the operator-abort settlement fired.
        timeoutMs: 60_000,
        abortSignal: operator.signal
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_aborted");
    // Operator abort is never retried: exactly one attempt, no backoff sleep.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT abort a fetch that resolves within the timeout budget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeJsonResponse({ choices: [{ message: { content: '{"signals":[]}' } }] })
    );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t",
      timeoutMs: 60_000
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta?.retryClassification).toBe("success_first_try");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

});

describe("extractContentFromChatCompletionBody invalid payload rejection", () => {
  it("rejects malformed chat completion envelope", () => {
    expect(() =>
      extractContentFromChatCompletionBody(JSON.stringify(["not", "a", "chat", "completion"]), "application/json")
    ).toThrow(/schema validation/i);
  });

  it("rejects when choices is not an array", () => {
    expect(() =>
      extractContentFromChatCompletionBody(JSON.stringify({ choices: "bad" }), "application/json")
    ).toThrow(/schema validation/i);
  });
});
