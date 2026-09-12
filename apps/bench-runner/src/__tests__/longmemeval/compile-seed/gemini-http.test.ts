import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createGardenHttpExtractor } from "../../../runs/compile-seed/compile-seed-http.js";
import { probeProviderProtocol } from "../../../runs/provider/protocol-probe.js";
import { parseAuthorizeExtractionArgs } from "../../../cli/extraction-authority/args.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";

const config: CompileSeedExtractionConfig = {
  model: "gemini-2.5-flash-lite", requestProfile: "gemini-2.5-nonthinking-v1",
  providerUrl: "https://synthetic.invalid", apiKey: "synthetic-fixture-key"
};
const input = {
  systemPrompt: "Return JSON only.", userPrompt: "A source assertion.",
  retryMode: "disabled" as const, maxOutputTokens: 1024, outputTokenField: "maxOutputTokens" as const
};
const usage = { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 3, totalTokenCount: 33 };

function response(options: { finish?: string; usage?: boolean; text?: string } = {}): Response {
  return Response.json({ candidates: [{ finishReason: options.finish ?? "STOP",
    content: { parts: [{ text: options.text ?? '{"signals":[]}' }] } }],
  ...(options.usage === false ? {} : { usageMetadata: usage }) });
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (origin: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("native Gemini interactive extraction", () => {
  it("accepts the exact native output field in the expense authorization CLI", () => {
    const authority = parseAuthorizeExtractionArgs([
      "--extraction-action", "probe", "--extraction-probe-key", "a".repeat(64),
      "--extraction-receipt-out", "/tmp/synthetic-native-receipt.json",
      "--extraction-output-token-cap", "1024", "--extraction-output-token-field", "maxOutputTokens",
      "--extraction-input-price-usd-per-million", "0.1",
      "--extraction-output-price-usd-per-million", "0.4",
      "--extraction-max-input-tokens", "1000", "--extraction-disk-floor-bytes", "0"
    ]);
    expect(authority.outputTokenField).toBe("maxOutputTokens");
    expect(authority.outputTokenCap).toBe(1024);
  });

  it("sends an authorized native nonthinking request through a real HTTP boundary", async () => {
    const observed: { url?: string; body?: unknown; key?: string } = {};
    const order: string[] = [];
    await withServer((req, res) => {
      observed.url = req.url;
      observed.key = req.headers["x-goog-api-key"] as string;
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part: string) => { body += part; });
      req.on("end", () => {
        observed.body = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: {
          parts: [{ thought: true, text: "not output" }, { text: '{"signals":[]}' }]
        } }], usageMetadata: usage }));
      });
    }, async (origin) => {
      const extractor = createGardenHttpExtractor({ ...config, providerUrl: `${origin}/v1beta` }, {
        fetch: async (url, init) => { order.push("fetch"); return fetch(url, init); }
      });
      const result = await extractor.extract({ ...input,
        onTransportAttempt: async () => { order.push("authorized"); } });
      expect(result.rawJson).toBe('{"signals":[]}');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 23, totalTokens: 33 });
      expect(result.extractorMeta).toMatchObject({ successfulRequestCount: 1, usageRequestCount: 1, retryCount: 0 });
    });
    expect(order).toEqual(["authorized", "fetch"]);
    expect(observed.url).toBe("/v1beta/models/gemini-2.5-flash-lite:generateContent");
    expect(observed.key).toBe("synthetic-fixture-key");
    expect(observed.body).toEqual({
      systemInstruction: { parts: [{ text: "Return JSON only." }] },
      contents: [{ role: "user", parts: [{ text: "A source assertion." }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 } }
    });
  });

  it("preserves missing usage as unknown", async () => {
    const result = await createGardenHttpExtractor(config, {
      fetch: vi.fn(async () => response({ usage: false }))
    }).extract(input);
    expect(result.usage).toBeUndefined();
    expect(result.extractorMeta?.usageRequestCount).toBe(0);
    expect(result.extractorMeta?.successfulRequestCount).toBe(1);
  });

  it("rejects an ambiguous retry policy or incompatible wire field before authority or dispatch", async () => {
    const fetchImpl = vi.fn(async () => response());
    const authorize = vi.fn();
    const extractor = createGardenHttpExtractor(config, { fetch: fetchImpl });
    await expect(extractor.extract({ ...input, retryMode: "default", onTransportAttempt: authorize }))
      .rejects.toThrow("disabled retries");
    await expect(extractor.extract({ ...input, outputTokenField: "max_tokens", onTransportAttempt: authorize }))
      .rejects.toThrow("maxOutputTokens");
    await expect(extractor.extract({ ...input, maxOutputTokens: undefined, onTransportAttempt: authorize }))
      .rejects.toThrow("explicit");
    expect(authorize).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not dispatch after authorization refuses or caller cancellation", async () => {
    const fetchImpl = vi.fn(async () => response());
    const extractor = createGardenHttpExtractor(config, { fetch: fetchImpl });
    await expect(extractor.extract({ ...input, onTransportAttempt: async () => {
      throw new Error("spend ceiling");
    } })).rejects.toThrow("spend ceiling");
    await expect(extractor.extract({ ...input, abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records charged truncated output without retries or a completed result", async () => {
    const fetchImpl = vi.fn(async () => response({ finish: "MAX_TOKENS" }));
    const attempt = createGardenHttpExtractor(config, { fetch: fetchImpl }).extract(input);
    await expect(attempt).rejects.toMatchObject({ benchRetry: {
      successfulRequestCount: 0, usageRequestCount: 1,
      usage: { inputTokens: 10, outputTokens: 23, totalTokens: 33 },
      transportFailures: [expect.objectContaining({ kind: "response_schema_error", attempt: 1 })]
    } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps request-aware admission rejection chargeable", async () => {
    const fetchImpl = vi.fn(async () => response());
    await expect(createGardenHttpExtractor(config, { fetch: fetchImpl }).extract({ ...input,
      validateRawJson: () => { throw new Error("foreign assertion"); }
    })).rejects.toMatchObject({ benchRetry: { usageRequestCount: 1, successfulRequestCount: 0 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects over-bound bodies and HTTP failures without another attempt", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", {
      headers: { "content-length": String(32 * 1024 * 1024 + 1) }
    }));
    await expect(createGardenHttpExtractor(config, { fetch: fetchImpl }).extract(input))
      .rejects.toThrow("byte cap");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const failed = vi.fn(async () => new Response("", { status: 429 }));
    await expect(createGardenHttpExtractor(config, { fetch: failed }).extract(input))
      .rejects.toMatchObject({ benchRetry: { transportFailures: [expect.objectContaining({ httpStatus: 429 })] } });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled real HTTP response body at the bounded deadline", async () => {
    await withServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); },
      async (origin) => {
        await expect(createGardenHttpExtractor({ ...config, providerUrl: origin }).extract({
          ...input, timeoutMs: 100
        })).rejects.toMatchObject({ benchRetry: { retryClassification: "failure_timeout", usageRequestCount: 0 } });
      });
  });

  it("keeps Gemini wire fields out of the chat-completions adapter", async () => {
    const fetchImpl = vi.fn(async () => response());
    await expect(createGardenHttpExtractor({ ...config, model: "gpt-5.4-mini",
      requestProfile: "provider-default-v1" }, { fetch: fetchImpl }).extract(input))
      .rejects.toThrow("cannot be sent to chat completions");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("probes native JSON with the same codec and rejects SSE without a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ text: '{"probe":true}' }));
    const probe = { providerUrl: config.providerUrl, apiKey: "synthetic-fixture-key",
      model: config.model, fetchImpl };
    await expect(probeProviderProtocol({ ...probe, framing: "sse" })).rejects.toThrow("JSON framing only");
    expect(fetchImpl).not.toHaveBeenCalled();
    const receipt = await probeProviderProtocol(probe);
    expect(receipt).toMatchObject({ framing: "json", physical_calls: 1, json_object: true,
      usage_present: true, finish_reason: "STOP", profile: "gemini-2.5-nonthinking-v1" });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json", maxOutputTokens: 256,
      thinkingConfig: { thinkingBudget: 0 } });
  });
});
