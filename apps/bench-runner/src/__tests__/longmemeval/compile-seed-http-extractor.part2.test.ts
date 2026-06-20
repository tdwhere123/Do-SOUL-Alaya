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
    // so a dump reader can attribute the failure without re-running.
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

    let seedCalls = 0;
    const daemon = buildCompileSeedDaemon((_input) => ({
      memoryId: `memory-${(seedCalls += 1)}`,
      signalId: "signal-x",
      proposalId: "proposal-x",
      evidenceId: "evidence-x",
      truncated: false,
      charsClipped: 0
    }));

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "the user prefers tea over coffee",
        evidenceRefBase: "evidence-1",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })
    ).rejects.toThrow("Official garden provider returned an invalid response.");

    // (a) liveExtractionFailures bumped — the blocker depends on this.
    expect(runner.stats.liveExtractionFailures).toBe(1);
    expect(runner.stats.offlineFallbacks).toBe(0);
    expect(seedCalls).toBe(0);

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
