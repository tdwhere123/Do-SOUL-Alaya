import { describe, expect, it, vi } from "vitest";
import { createGardenHttpExtractor } from "../../../runs/compile-seed.js";
import type { BenchTransportFailureAttempt } from "../../../runs/compile-seed/compile-seed-types.js";
import {
  captureExtractorFailure,
  captureTerminalFailure,
  HTTP_CONFIG,
  readBenchRetry,
  readTransportFailures
} from "./compile-seed-http-transport-failures-fixture.js";

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

  it("maps mixed stream shape to a schema failure without raw payload", async () => {
    const error = await captureTerminalFailure(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(
        'data: {"choices":[{"delta":{"content":"secret-delta"}}]}\n\n' +
        'data: {"choices":[{"message":{"content":"secret-message"}}]}\n\n' +
        "data: [DONE]\n",
        { headers: { "content-type": "text/event-stream" } }
      ))
    );
    const [failure] = readTransportFailures(error);

    expect(failure).toMatchObject({
      kind: "response_schema_error",
      phase: "response_schema",
      httpStatus: null,
      attempt: 1
    });
    expect(JSON.stringify(readBenchRetry(error))).not.toMatch(/secret-delta|secret-message/iu);
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

  it("changes the safe fingerprint when the provider body digest changes", async () => {
    const first = await httpFailureFingerprint("secret provider body one");
    const digestChanged = await httpFailureFingerprint("secret provider body two");

    expect(first.fingerprint).not.toBe(digestChanged.fingerprint);
    expect(JSON.stringify([first, digestChanged])).not.toMatch(/secret|provider body/iu);
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

  it.each([
    {
      kind: "response_parse_error" as const,
      phase: "response_parse" as const,
      fetch: () => jsonTextResponse("{secret-invalid-json")
    },
    {
      kind: "empty_response" as const,
      phase: "response_schema" as const,
      fetch: () => jsonResponse({ choices: [{ message: { content: "" } }] })
    }
  ])("keeps default-mode $kind terminal after one fetch", async (scenario) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(scenario.fetch());
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
      retryClassification: "failure_non_retryable_response"
    });
    expect(readTransportFailures(error)).toMatchObject([{
      kind: scenario.kind,
      phase: scenario.phase,
      attempt: 1
    }]);
  });

  it("does not retry an immediate HTTP 400", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("secret provider body", { status: 400 })
    );
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
      httpStatus: 400,
      attempt: 1
    }]);
  });

  it("retries an immediate HTTP 503", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(SUCCESS));
    const result = await createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: async () => undefined,
      random: () => 0
    }).extract({ systemPrompt: "s", userPrompt: "u" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.extractorMeta).toMatchObject({
      retryClassification: "success_after_retry"
    });
    expect(result.extractorMeta?.transportFailures).toMatchObject([{
      kind: "http_error",
      phase: "response_status",
      httpStatus: 503,
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

  it("preserves prior transport failures when a later reservation is rejected", async () => {
    const authorityFailure = new Error("authority attempt cap reached");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("limited", { status: 429 })
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    let reservations = 0;

    const error = await captureExtractorFailure(extractor, {
      onTransportAttempt: () => {
        reservations += 1;
        if (reservations > 1) throw authorityFailure;
      }
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ cause: authorityFailure });
    expect(readBenchRetry(error)).toMatchObject({ retryCount: 0, rateLimitRetries: 1 });
    expect(readTransportFailures(error)).toMatchObject([{
      kind: "http_error", httpStatus: 429, attempt: 1
    }]);
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

async function httpFailureFingerprint(errorBody: unknown): Promise<BenchTransportFailureAttempt> {
  const body = typeof errorBody === "string" ? errorBody : JSON.stringify({ error: errorBody });
  const failure = await captureTerminalFailure(
    vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 400,
      headers: { "content-type": "application/json" }
    }))
  );
  const [attempt] = readTransportFailures(failure);
  if (attempt === undefined) throw new Error("expected typed transport failure");
  return attempt;
}
