import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import {
  computeNextTurnSeedRefs,
  createCachingSignalExtractor,
  createCompileSeedRunner,
  createGardenHttpExtractor,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi,
  type BenchSignalExtractor,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig,
  type CompileSeedExtractionStats
} from "../../../longmemeval/compile-seed.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG
} from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

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
    requestProfile: "provider-default-v1",
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

  it("retains exact provider usage emitted in the terminal SSE frame", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeSseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":5,"total_tokens":18}}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, { fetch: fetchMock });

    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });

    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 5, totalTokens: 18 });
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

  it("throws when SSE content parses as JSON but fails Zod signal validation", async () => {
    const invalidBody =
      'data: {"choices":[{"delta":{"content":"{\\"signals\\":\\"not-an-array\\"}"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => makeSseResponse(invalidBody));
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    await expect(
      extractor.extract({ systemPrompt: "s", userPrompt: "t" })
    ).rejects.toThrow(/garden extraction returned unparseable content/i);
  });

  it("rejects a malformed data frame after a schema-valid prefix", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
      "data: {not valid json\n\n" +
      "data: [DONE]\n\n";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => makeSseResponse(body));
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    await expect(
      extractor.extract({ systemPrompt: "s", userPrompt: "t" })
    ).rejects.toThrow(/chunk is not valid JSON/i);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws on a truncated SSE stream (non-empty but unparseable) so it is never cached", async () => {
    // B1 regression: a provider/proxy delivers a PARTIAL SSE body then cleanly
    // closes the socket -> `response.text()` RESOLVES with partial bytes (no
    // stall, so the wall-clock backstop does NOT fire). The malformed data
    // frame must fail before any valid prefix can be mistaken for a complete
    // response and written to the cache.
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
      "garden extraction chat completion chunk is not valid JSON"
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

  it("retries when a non-empty signals array has no valid entries", async () => {
    const response = (content: string) => makeJsonResponse({
      choices: [{ message: { content } }]
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('{"signals":[42]}'))
      .mockResolvedValueOnce(response('{"signals":[]}'));
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });

    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });

    expect(result.rawJson).toBe('{"signals":[]}');
    expect(result.extractorMeta?.retryClassification).toBe("success_after_retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
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
