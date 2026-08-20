import { afterEach, describe, expect, it, vi } from "vitest";
import { createGardenHttpExtractor } from "../../../bench/compile-seed.js";
import {
  captureExtractorFailure,
  captureTerminalFailure,
  HTTP_CONFIG,
  readBenchRetry,
  readTransportFailures
} from "./compile-seed-http-transport-failures-fixture.js";

afterEach(() => vi.useRealTimers());

describe("garden HTTP hanging timeout and out-of-range failures", () => {
  it("distinguishes timeout and active-request abort", async () => {
    const timeout = await captureTerminalFailure(
      vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {})),
      { timeoutMs: 10 }
    );
    const operator = new AbortController();
    const abort = await captureTerminalFailure(
      vi.fn<typeof fetch>().mockImplementation(() => {
        queueMicrotask(() => operator.abort(new Error("secret operator cancel")));
        return new Promise<Response>(() => {});
      }),
      { abortSignal: operator.signal, timeoutMs: 60_000 }
    );

    expect(readTransportFailures(timeout)).toMatchObject([
      { kind: "timeout", phase: "request", attempt: 1 }
    ]);
    expect(readTransportFailures(abort)).toMatchObject([
      { kind: "aborted", phase: "request", attempt: 1 }
    ]);
  });

  it.each([400, 503] as const)(
    "times out after HTTP %s headers when the diagnostic body hangs",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(
        async () => hangingStatusResponse(status)
      );
      const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
        fetch: fetchMock,
        sleep: async () => undefined,
        random: () => 0
      });
      const pending = extractor.extract({
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 20
      });
      const captured = pending.then(
        () => {
          throw new Error("expected extractor failure");
        },
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(80);
      const error = await captured;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(readBenchRetry(error)).toMatchObject({
        retryCount: 1,
        retryClassification: "failure_timeout"
      });
      expect(readTransportFailures(error)).toMatchObject([
        { kind: "timeout", phase: "request", httpStatus: status, attempt: 1 },
        { kind: "timeout", phase: "request", httpStatus: status, attempt: 2 }
      ]);
      expect(JSON.stringify(readBenchRetry(error))).not.toMatch(/secret|rawBody/iu);
    }
  );

  it("lets operator abort win over a known HTTP status", async () => {
    const operator = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      queueMicrotask(() => operator.abort(new Error("secret operator cancel")));
      return hangingStatusResponse(400);
    });
    const error = await captureExtractorFailure(
      createGardenHttpExtractor(HTTP_CONFIG, {
        fetch: fetchMock,
        sleep: async () => undefined,
        random: () => 0
      }),
      { abortSignal: operator.signal, timeoutMs: 60_000 }
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readBenchRetry(error)).toMatchObject({
      retryCount: 0,
      retryClassification: "failure_aborted"
    });
    expect(readTransportFailures(error)).toMatchObject([{
      kind: "aborted",
      httpStatus: 400,
      attempt: 1
    }]);
    expect(JSON.stringify(readBenchRetry(error))).not.toContain("secret operator cancel");
  });

  it("does not retry an immediate HTTP 600", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(outOfRangeStatusResponse(600));
    const error = await captureExtractorFailure(
      createGardenHttpExtractor(HTTP_CONFIG, {
        fetch: fetchMock,
        sleep: async () => undefined,
        random: () => 0
      })
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readBenchRetry(error)).toMatchObject({
      retryCount: 0,
      retryClassification: "failure_non_retryable_4xx"
    });
    expect(readTransportFailures(error)).toMatchObject([{
      kind: "http_error",
      phase: "response_status",
      httpStatus: 600,
      attempt: 1
    }]);
  });
});

function hangingStatusResponse(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status });
}

function outOfRangeStatusResponse(status: number): Response {
  return {
    ok: false,
    status,
    statusText: "Unknown",
    headers: new Headers(),
    body: null
  } as unknown as Response;
}
