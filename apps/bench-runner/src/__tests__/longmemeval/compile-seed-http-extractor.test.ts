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

// invariant: yunwu.ai + gpt-5.4-mini answers chat/completions content ONLY as
// an SSE delta stream (`stream:true`); a non-stream request returns an empty
// `data: [DONE]\n\n` body. The extractor sends `stream:true` and parses the
// SSE body; a compliant provider's plain JSON body must still work
// (back-compat). The body read stays under the same wall-clock backstop as the
// fetch so a mid-stream stalled socket settles as a timeout, not a hang.
describe("createGardenHttpExtractor — SSE streaming body parse", () => {
  const HTTP_CONFIG: CompileSeedExtractionConfig = {
    providerUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "sk-test"
  };

  function makeSseResponse(body: string): Response {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }

  function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  it("sends stream:true in the request body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeSseResponse(
          'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\ndata: [DONE]\n\n'
        )
      );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const sentBody = JSON.parse(String(init?.body)) as { stream?: unknown };
    expect(sentBody.stream).toBe(true);
  });

  it("concatenates two SSE delta chunks before [DONE] into rawJson", async () => {
    // The dominant yunwu shape: the JSON object the extractor must recover is
    // delivered split across delta frames; only the concatenation parses.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeSseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"sig"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"nals\\":[]}"}}]}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(result.rawJson).toBe('{"signals":[]}');
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta?.retryClassification).toBe("success_first_try");
  });

  it("classifies a [DONE]-only empty SSE stream as no-content (NOT a hang)", async () => {
    // yunwu's non-stream / empty answer shape. The empty-content guard must
    // throw so the run blocks on a real content failure instead of silently
    // recording an empty extraction. A non-retryable content error surfaces.
    // A fresh Response per call: an empty-content error has no HTTP status so
    // the retry loop treats it as an unknown-transport failure and retries;
    // each attempt must read a fresh (unconsumed) body. The terminal wrapped
    // error preserves the "no content" cause message.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => makeSseResponse("data: [DONE]\n\n"));
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "garden extraction returned no content"
    );
  });

  it("skips a malformed mid-stream chunk but keeps surrounding content", async () => {
    // Partial keep-alive noise must not throw; a defensively-skipped bad frame
    // still yields the real content from the good frames.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeSseResponse(
        ": keep-alive ping\n\n" +
          'data: {"choices":[{"delta":{"content":"{\\"signals"}}]}\n\n' +
          "data: {not valid json\n\n" +
          'data: {"choices":[{"delta":{"content":"\\":[]}"}}]}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
  });

  it("throws on a truncated SSE stream (non-empty but unparseable) so it is never cached", async () => {
    // B1 regression: a provider/proxy delivers a PARTIAL SSE body then cleanly
    // closes the socket -> `response.text()` RESOLVES with partial bytes (no
    // stall, so the wall-clock backstop does NOT fire). The SSE parser keeps
    // the valid early delta and silently skips the truncated final frame,
    // accumulating `{"signals":[{"a"` — non-empty (passes the empty-content
    // guard) but unparseable. Pre-fix this returned success and the poison
    // shard was written to cache as a permanent 0-seed "success". The validity
    // gate (parseOfficialApiSignals, the same downstream consumer) must THROW
    // so the attempt routes to retry then a content/invalid terminal failure —
    // the extractor throws, so createCachingSignalExtractor never writes it.
    // A fresh Response per call: a content error has no HTTP status so the
    // retry loop treats it as unknown-transport and retries; each attempt
    // reads a fresh (unconsumed) body.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      makeSseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"signals\\":[{\\"a"}}]}\n\n' +
          "data: {\"choices\":[{\"delta\":{\"content\":\"\\\":\\\"trunc"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    let thrown: unknown = null;
    let result: unknown = null;
    try {
      result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    // The extractor threw — it did NOT return a success_* result, so the
    // caching extractor never receives a rawJson to write.
    expect(result).toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "garden extraction returned unparseable content"
    );
    // Terminal classification is a retryable content failure that exhausts
    // retries (mirrors the no-content style), NOT a hang or silent success.
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_max_retries");
    // 4 = first attempt + BENCH_HTTP_MAX_RETRIES (3); each settles on the
    // resolved poison bytes, never hangs.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("extracts a full message.content carried in a single SSE frame", async () => {
    // Some OpenAI-compatible providers emit the whole assistant message in one
    // frame as choices[0].message.content rather than streamed deltas.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeSseResponse(
        'data: {"choices":[{"message":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
  });

  it("still extracts a compliant plain-JSON body (application/json back-compat)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: '{"signals":[]}' } }]
        })
      );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta?.retryClassification).toBe("success_first_try");
  });

  // invariant: body-read backstop regression. A response whose body read
  // (`.text()`) NEVER settles and ignores abort is the post-fetch analogue of
  // the stalled-socket wedge. Racing the body read against the wall-clock
  // backstop must settle the attempt as failure_timeout within budget rather
  // than hanging until the vitest timeout. Mirrors the never-settling-fetch
  // regression but for the body read. WITHOUT the body-read race this hangs.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  it("settles a never-resolving body read via the timeout backstop (not a hang)", async () => {
    // A real 200 OK response whose `.text()` never resolves and ignores abort.
    const stalledBodyResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/event-stream" }),
      // Never settles — the mid-stream stalled-socket shape on the body read.
      text: () => new Promise<string>(() => {})
    } as unknown as Response;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(stalledBodyResponse);
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
    // 2 = first attempt + 1 timeout retry; each settles via the backstop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// invariant: the SSE-or-JSON content extraction is a pure helper so it is unit
// testable without a live fetch. Same parse the transport uses; covers the
// shapes the integration tests above exercise plus edge framing.
describe("extractContentFromChatCompletionBody", () => {
  it("concatenates delta content across data: frames up to [DONE]", () => {
    const body =
      'data: {"choices":[{"delta":{"content":"ab"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"cd"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "abcd"
    );
  });

  it("detects SSE by leading data: even without an event-stream content-type", () => {
    const body = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
    expect(extractContentFromChatCompletionBody(body, null)).toBe("x");
  });

  it("returns empty string for a [DONE]-only stream", () => {
    expect(
      extractContentFromChatCompletionBody("data: [DONE]\n\n", "text/event-stream")
    ).toBe("");
  });

  it("ignores blank lines and comment lines", () => {
    const body =
      ": ping\n\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "ok"
    );
  });

  it("reads message.content from a compliant plain-JSON body", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "json-content" } }]
    });
    expect(extractContentFromChatCompletionBody(body, "application/json")).toBe(
      "json-content"
    );
  });

  it("skips a malformed chunk without throwing", () => {
    const body =
      "data: {bad\n\n" +
      'data: {"choices":[{"delta":{"content":"good"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "good"
    );
  });

  it("N1: takes content ONCE when a frame carries both delta.content and message.content", () => {
    // A provider that echoes the running message.content alongside each delta
    // would double-count if both branches appended. The message.content branch
    // is an `else if` of the delta branch, so delta wins and content is taken
    // once — not "xx".
    const body =
      'data: {"choices":[{"delta":{"content":"x"},"message":{"content":"x"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "x"
    );
  });
});

// invariant: a full-bench seed-extraction failure must (a) bump
// liveExtractionFailures, (b) drop a diagnostic dump whose
// retry_classification field surfaces the terminal outcome, (c) end up
// blocked via seedExtractionReleaseBlocker because
// live_extraction_failures > 0.
// see also: packages/eval/src/gates/seed-extraction-blocker.ts —
// evaluateSeedExtractionReleaseBlocker checks live_extraction_failures.
describe("dumpSeedExtractionFailureDiagnostic surfaces retry_classification", () => {
  let cacheRoot: string;
  let diagnosticDir: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cache-"));
    diagnosticDir = await mkdtemp(join(tmpdir(), "compile-seed-diag-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(diagnosticDir, { recursive: true, force: true });
  });

  it("dumps retry_classification=failure_non_retryable_4xx when a live extraction hits HTTP 401", async () => {
    // The extractor delegate models a chronic 401 — the retry loop must
    // bail on the first attempt and propagate the classification. The dump
    // file captured under diagnosticDir then carries retry_classification
    // so a Phase-F dump reader can attribute the fallback without re-running.
    const failingDelegate: BenchSignalExtractor = {
      async extract() {
        const err = new Error("garden extraction HTTP 401 unauthorized");
        (err as { status?: number }).status = 401;
        (err as { benchRetry?: unknown }).benchRetry = {
          retryCount: 0,
          retryClassification: "failure_non_retryable_4xx"
        };
        throw err;
      }
    };

    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => failingDelegate,
      diagnosticDir
    });

    const daemon = buildCompileSeedDaemon((input) => ({
      memoryId: `memory-${input.distilledFact.slice(0, 4)}`,
      signalId: "signal-x",
      proposalId: "proposal-x",
      evidenceId: "evidence-x",
      truncated: false,
      charsClipped: 0
    }));

    await runner.seedTurn({
      daemon,
      turnContent: "the user prefers tea over coffee",
      evidenceRefBase: "evidence-1",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    // (a) liveExtractionFailures bumped — the blocker depends on this.
    expect(runner.stats.liveExtractionFailures).toBe(1);
    expect(runner.stats.offlineFallbacks).toBe(1);

    // (b) dump file written and carries retry_classification.
    const dumpFiles = readdirSync(diagnosticDir).filter(
      (f) => f.startsWith("compile-seed-") && f.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(1);
    const envelope = JSON.parse(
      readFileSync(join(diagnosticDir, dumpFiles[0]!), "utf8")
    ) as {
      retry_classification: string;
      retry_count: number | null;
      live_extraction_failures: number;
      last_extraction_source: string;
    };
    expect(envelope.retry_classification).toBe("failure_non_retryable_4xx");
    expect(envelope.retry_count).toBe(0);
    expect(envelope.live_extraction_failures).toBe(1);
    expect(envelope.last_extraction_source).toBe("live");
  });
});
