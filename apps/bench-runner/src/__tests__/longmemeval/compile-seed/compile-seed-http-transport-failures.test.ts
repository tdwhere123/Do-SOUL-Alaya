import { describe, expect, it, vi } from "vitest";
import { createGardenHttpExtractor } from "../../../longmemeval/compile-seed.js";
import type {
  BenchTransportFailureAttempt,
  CompileSeedExtractionConfig
} from "../../../longmemeval/compile-seed/compile-seed-types.js";
import {
  readBoundedGardenHttpErrorBody
} from "../../../longmemeval/compile-seed/http/garden-http-error-body.js";

const HTTP_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://provider.invalid/v1",
  model: "deepseek-test",
  requestProfile: "provider-default-v1",
  apiKey: "secret-key"
};

const SUCCESS = { choices: [{ message: { content: '{"signals":[]}' } }] };

describe("garden HTTP typed transport failures", () => {
  it.each([
    {
      kind: "network_error",
      phase: "request",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(Object.assign(
        new Error("secret network message https://internal.invalid"),
        { code: "ECONNRESET" }
      ))
    },
    {
      kind: "http_error",
      phase: "response_status",
      status: 503,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("secret provider body", { status: 503 })
      )
    },
    {
      kind: "body_read_error",
      phase: "response_body",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(rejectingBodyResponse())
    },
    {
      kind: "response_parse_error",
      phase: "response_parse",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonTextResponse("{secret-invalid-json"))
    },
    {
      kind: "response_schema_error",
      phase: "response_schema",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonTextResponse('["secret-schema"]'))
    },
    {
      kind: "empty_response",
      phase: "response_schema",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        choices: [{ message: { content: "" } }]
      }))
    }
  ] as const)("distinguishes $kind without exporting raw failure data", async (scenario) => {
    const error = await captureTerminalFailure(scenario.fetch);
    const [failure] = readTransportFailures(error);

    expect(failure).toMatchObject({
      kind: scenario.kind,
      phase: scenario.phase,
      httpStatus: "status" in scenario ? scenario.status : null,
      attempt: 1
    });
    expect(failure?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(failure ?? {}).sort()).toEqual([
      "attempt", "fingerprint", "httpStatus", "kind", "phase"
    ]);
    expect(JSON.stringify(readBenchRetry(error))).not.toMatch(
      /secret|internal\.invalid|network message|provider body/iu
    );
  });

  it("distinguishes timeout and active-request abort", async () => {
    const timeout = await captureTerminalFailure(
      vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {})),
      { timeoutMs: 10 }
    );
    const operator = new AbortController();
    const abort = await captureTerminalFailure(
      vi.fn<typeof fetch>().mockImplementation(() => {
        queueMicrotask(() => operator.abort(new Error("secret abort reason")));
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

  it("fingerprints provider code/type while ignoring raw error message changes", async () => {
    const first = await httpFailureFingerprint({
      code: 600003,
      type: "provider_error",
      message: "secret upstream message one"
    });
    const messageChanged = await httpFailureFingerprint({
      code: 600003,
      type: "provider_error",
      message: "secret upstream message two"
    });
    const codeChanged = await httpFailureFingerprint({
      code: 600004,
      type: "provider_error",
      message: "secret upstream message one"
    });

    expect(first.fingerprint).toBe(messageChanged.fingerprint);
    expect(first.fingerprint).not.toBe(codeChanged.fingerprint);
    expect(first).toMatchObject({
      kind: "http_error",
      phase: "response_status",
      httpStatus: 400,
      attempt: 1
    });
    expect(JSON.stringify(first)).not.toMatch(/600003|provider_error|secret|message/iu);
  });

  it("caps error-body streaming at 16 KiB and cancels the unread tail", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(32 * 1024)));
      },
      cancel() {
        cancelled = true;
      }
    }), { status: 400 });

    const body = await readBoundedGardenHttpErrorBody(
      response, new Promise<never>(() => undefined)
    );

    expect(new TextEncoder().encode(body).byteLength).toBe(16 * 1024);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("keeps the HTTP status failure when its diagnostic body cannot be read", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("secret body stream failure"));
      }
    }), { status: 400 });

    const error = await captureTerminalFailure(
      vi.fn<typeof fetch>().mockResolvedValue(response)
    );

    expect(readTransportFailures(error)).toMatchObject([
      { kind: "http_error", phase: "response_status", httpStatus: 400, attempt: 1 }
    ]);
    expect(JSON.stringify(readBenchRetry(error))).not.toContain("secret body stream failure");
  });

  it("keeps a known HTTP 400 terminal when its diagnostic body stalls", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 400 })
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0
    });

    const error = await captureExtractorFailure(extractor, { timeoutMs: 10 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readBenchRetry(error)).toMatchObject({
      retryCount: 0,
      retryClassification: "failure_non_retryable_4xx"
    });
    expect(readTransportFailures(error)).toMatchObject([{
      kind: "http_error",
      phase: "response_status",
      httpStatus: 400,
      attempt: 1
    }]);
  });

  it("retains ordered failed attempts after a later success", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket secret"), { code: "EPIPE" }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(SUCCESS));
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0
    });

    const result = await extractor.extract({ systemPrompt: "s", userPrompt: "u" });

    expect(result.extractorMeta?.transportFailures).toMatchObject([
      { kind: "network_error", phase: "request", attempt: 1 },
      { kind: "http_error", phase: "response_status", httpStatus: 503, attempt: 2 }
    ]);
  });

  it("carries every terminal failed attempt in order", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("unavailable", { status: 502 })
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0
    });

    const error = await captureExtractorFailure(extractor);

    expect(readTransportFailures(error).map((failure) => failure.attempt)).toEqual([1, 2, 3, 4]);
    expect(readTransportFailures(error).every((failure) => failure.httpStatus === 502)).toBe(true);
  });

  it("propagates pre-transport authority rejection unchanged", async () => {
    const authorityFailure = new Error("authority attempt cap reached");
    const fetchMock = vi.fn<typeof fetch>();
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, { fetch: fetchMock });

    const pending = extractor.extract({
      systemPrompt: "s",
      userPrompt: "u",
      onTransportAttempt: () => { throw authorityFailure; }
    });

    await expect(pending).rejects.toBe(authorityFailure);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((authorityFailure as { readonly benchRetry?: unknown }).benchRetry).toBeUndefined();
  });
});

function jsonResponse(body: unknown): Response {
  return jsonTextResponse(JSON.stringify(body));
}

function jsonTextResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json" } });
}

function rejectingBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: vi.fn().mockRejectedValue(new Error("secret body-read failure"))
  } as unknown as Response;
}

async function captureTerminalFailure(
  fetchImpl: typeof fetch,
  input: { readonly timeoutMs?: number; readonly abortSignal?: AbortSignal } = {}
): Promise<unknown> {
  const extractor = createGardenHttpExtractor(HTTP_CONFIG, { fetch: fetchImpl });
  return captureExtractorFailure(extractor, { ...input, retryMode: "disabled" });
}

async function captureExtractorFailure(
  extractor: ReturnType<typeof createGardenHttpExtractor>,
  input: {
    readonly timeoutMs?: number;
    readonly abortSignal?: AbortSignal;
    readonly retryMode?: "default" | "disabled";
  } = {}
): Promise<unknown> {
  try {
    await extractor.extract({ systemPrompt: "s", userPrompt: "u", ...input });
  } catch (error) {
    return error;
  }
  throw new Error("expected extractor failure");
}

function readBenchRetry(error: unknown): unknown {
  return (error as { readonly benchRetry?: unknown }).benchRetry;
}

function readTransportFailures(error: unknown): readonly BenchTransportFailureAttempt[] {
  const benchRetry = readBenchRetry(error) as {
    readonly transportFailures?: readonly BenchTransportFailureAttempt[];
  } | undefined;
  return benchRetry?.transportFailures ?? [];
}

async function httpFailureFingerprint(errorBody: unknown): Promise<BenchTransportFailureAttempt> {
  const failure = await captureTerminalFailure(
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: errorBody }), {
      status: 400,
      headers: { "content-type": "application/json" }
    }))
  );
  const [attempt] = readTransportFailures(failure);
  if (attempt === undefined) throw new Error("expected typed transport failure");
  return attempt;
}
