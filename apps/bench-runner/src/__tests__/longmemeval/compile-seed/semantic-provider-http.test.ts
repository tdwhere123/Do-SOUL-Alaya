import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { STEP_SEMANTIC_REQUEST_PROFILE, STEP_SEMANTIC_HIGH_REQUEST_PROFILE } from "@do-soul/alaya-protocol";
import {
  inspectProviderChatCompletionResponse,
  MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES
} from "@do-soul/alaya-engine-gateway";
import {
  createSemanticProviderHttpExtractor,
  prepareSemanticProviderRequest
} from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";

const SCHEMA = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false
} as const;
const CONTENT = '{"value":"tail-marker"}';
const config: CompileSeedExtractionConfig = {
  model: STEP_PLAN_QUOTE_BASIS.selected_model,
  requestProfile: STEP_SEMANTIC_REQUEST_PROFILE,
  providerUrl: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
  apiKey: "loopback-only"
};
const extractInput = {
  systemPrompt: "system", userPrompt: "user", retryMode: "disabled" as const,
  maxOutputTokens: 4096, outputTokenField: "max_tokens" as const, responseJsonSchema: SCHEMA
};

function oversizedStepSse(): string {
  const prefix = `data: ${JSON.stringify({
    choices: [{ delta: { reasoning_content: "r".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) } }]
  })}\n\n`;
  return `${prefix}data: ${JSON.stringify({
    choices: [{ delta: { content: CONTENT }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  })}\n\ndata: [DONE]\n\n`;
}

async function withLoopback(
  wire: string,
  run: (extract: typeof createSemanticProviderHttpExtractor) => Promise<void>
): Promise<{ bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(wire);
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nativeFetch = globalThis.fetch;
    const fetchImpl: typeof fetch = (url, init) => {
      const selected = new URL(String(url));
      expect(selected.href).toBe(`${STEP_PLAN_QUOTE_BASIS.selected_provider_url}/chat/completions`);
      return nativeFetch(new URL(selected.pathname, origin), init);
    };
    await run((extractionConfig, schemaName) =>
      createSemanticProviderHttpExtractor(extractionConfig, schemaName, fetchImpl));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  return { bodies };
}

it.each([STEP_SEMANTIC_REQUEST_PROFILE, STEP_SEMANTIC_HIGH_REQUEST_PROFILE])(
  "retains complete %s bytes past 64KiB only when full HTTP evidence is requested", async requestProfile => {
  const selectedConfig = { ...config, requestProfile };
  const wire = oversizedStepSse();
  const original = Buffer.from(wire);
  expect(original.length).toBeGreaterThan(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
  const withoutFlag = prepareSemanticProviderRequest(selectedConfig, extractInput, "semantic_payload");
  const withFlag = prepareSemanticProviderRequest(selectedConfig, {
    ...extractInput, retainHttpResponseEvidence: true
  }, "semantic_payload");
  expect(withoutFlag.body).toBe(withFlag.body);
  expect(withoutFlag.url.href).toBe(withFlag.url.href);

  const { bodies } = await withLoopback(wire, async (createExtractor) => {
    const extractor = createExtractor(selectedConfig, "semantic_payload");
    const retained = await extractor.extract({ ...extractInput, retainHttpResponseEvidence: true });
    const defaulted = await extractor.extract(extractInput);

    expect(retained.rawJson).toBe(CONTENT);
    expect(retained.responseMetadata).toMatchObject({ finishReason: "stop" });
    expect(retained.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    const retainedBytes = Buffer.from(retained.httpResponse!.bodyBase64, "base64");
    expect(retained.httpResponse).toMatchObject({
      bodyByteLength: original.length, bodyComplete: true, bodyTruncated: false,
      bodySha256: createHash("sha256").update(original).digest("hex")
    });
    expect(retainedBytes.equals(original)).toBe(true);
    const reparsed = inspectProviderChatCompletionResponse(
      retainedBytes, retained.httpResponse!.contentType, 200, { sseCompletionPolicy: "require_witness" }
    );
    expect(reparsed).toMatchObject({
      text: CONTENT, finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
    });
    expect(reparsed.text).toContain("tail-marker");

    expect(defaulted.rawJson).toBe(CONTENT);
    expect(defaulted.responseMetadata).toMatchObject({ finishReason: "stop" });
    expect(defaulted.usage).toEqual(retained.usage);
    const defaultBytes = Buffer.from(defaulted.httpResponse!.bodyBase64, "base64");
    expect(defaulted.httpResponse).toMatchObject({
      bodyByteLength: original.length, bodyComplete: true, bodyTruncated: true,
      bodySha256: createHash("sha256").update(original).digest("hex")
    });
    expect(defaultBytes.byteLength).toBe(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
    expect(defaultBytes.toString("utf8")).not.toContain("tail-marker");
    expect(defaultBytes.toString("utf8")).not.toContain('"finish_reason":"stop"');
  });

  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual(JSON.parse(withoutFlag.body));
  expect(bodies[0]).toMatchObject({
    model: STEP_PLAN_QUOTE_BASIS.selected_model, max_tokens: 4096, stream: true,
    reasoning_effort: requestProfile === STEP_SEMANTIC_REQUEST_PROFILE ? "low" : "high",
    response_format: { type: "json_schema", json_schema: { name: "semantic_payload", strict: true } }
  });
});
