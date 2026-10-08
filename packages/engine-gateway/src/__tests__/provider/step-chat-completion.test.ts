import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  buildProviderChatRequestBody,
  executeProviderChatCompletion,
  inspectProviderChatCompletionResponse,
  MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES,
  MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES,
  ProviderChatCompletionError,
  providerChatCompletionsUrl,
  type ProviderChatCompletionRequest
} from "../../provider/chat-completion/index.js";

const SCHEMA = {
  name: "semantic_payload",
  schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false
  }
} as const;

function stepRequest(providerUrl: string, mode: "json" | "sse" = "json"):
    ProviderChatCompletionRequest {
  return {
    providerUrl,
    apiKey: "local-test-key",
    model: "step-3.5-flash-2603",
    profile: "step-3.5-2603-low-json-schema-v1",
    systemPrompt: "system",
    userPrompt: "user",
    jsonSchema: SCHEMA,
    maxOutputTokens: 4096,
    mode,
    env: { ALAYA_ALLOW_PRIVATE_PROVIDER_URL: "1" }
  };
}

async function withServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (providerUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}/step_plan/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Step Chat Completions over local HTTP", () => {
  it.each([
    { profile: "step-3.5-2603-low-json-schema-v1", effort: "low" },
    { profile: "step-3.5-2603-high-json-schema-v1", effort: "high" }
  ] as const)("sends the named schema, $effort effort, and finite cap to the selected path", async ({ profile, effort }) => {
    let path: string | undefined;
    let sentBody: unknown;
    await withServer((request, response) => {
      path = request.url;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        sentBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: {
            reasoning_content: "private reasoning",
            content: '{"value":"answer"}'
          }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 4 }
          }
        }));
      });
    }, async (providerUrl) => {
      const request = { ...stepRequest(providerUrl), profile };
      const result = await executeProviderChatCompletion(request, {
        maxRetries: 0, retryDelaysMs: []
      });
      expect(result.result.text).toBe('{"value":"answer"}');
      expect(result.result.reasoningText).toBe("private reasoning");
      expect(result.result.finishReason).toBe("stop");
      expect(result.result.usage).toEqual({
        inputTokens: 11, outputTokens: 7, totalTokens: 18,
        cachedInputTokens: 3, reasoningOutputTokens: 4
      });
      expect(result.result.httpResponse?.bodyComplete).toBe(true);
      expect(result.result.httpResponse?.bodyTruncated).toBe(false);
      expect(result.result.httpResponse?.contentType).toBe("application/json");
      expect(providerChatCompletionsUrl(providerUrl, request.env)).toBe(
        `${providerUrl}/chat/completions`
      );
      expect(buildProviderChatRequestBody(request)).toEqual(sentBody);
      expect(JSON.stringify(sentBody)).not.toContain("local-test-key");
    });
    expect(path).toBe("/step_plan/v1/chat/completions");
    expect(sentBody).toEqual({
      model: "step-3.5-flash-2603",
      response_format: { type: "json_schema", json_schema: {
        name: "semantic_payload", strict: true, schema: SCHEMA.schema
      } },
      max_tokens: 4096,
      reasoning_effort: effort,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" }
      ]
    });
  });

  it("keeps SSE reasoning separate and preserves length with no usage claim", async () => {
    let body: Record<string, unknown> | undefined;
    await withServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"{\\"value\\":\\"cut"},"finish_reason":"length"}]}\n\n' +
          "data: [DONE]\n\n"
        );
      });
    }, async (providerUrl) => {
      const result = await executeProviderChatCompletion(stepRequest(providerUrl, "sse"), {
        maxRetries: 0, retryDelaysMs: []
      });
      expect(result.result).toMatchObject({
        text: '{"value":"cut', reasoningText: "think", finishReason: "length",
        completion: { mode: "sse", witness: "done_sentinel" }
      });
      expect(result.result.usage).toBeUndefined();
    });
    expect(body?.stream).toBe(true);
    expect(body?.stream_options).toBeUndefined();
  });

  it("retains an incomplete SSE response and its missing terminal evidence", async () => {
    const raw = 'data: {"choices":[{"delta":{"content":"{\\"value\\":\\"x\\"}"}}]}\n\n';
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(raw);
    }, async (providerUrl) => {
      const error = await executeProviderChatCompletion(stepRequest(providerUrl, "sse"), {
        maxRetries: 0, retryDelaysMs: []
      }).then(() => { throw new Error("expected incomplete SSE"); }, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderChatCompletionError);
      const failure = error as ProviderChatCompletionError;
      expect(failure.inspectionReason).toBe("incomplete_stream");
      expect(failure.httpResponse?.bodyComplete).toBe(true);
      expect(Buffer.from(failure.httpResponse!.bodyBase64, "base64").toString("utf8")).toBe(raw);
      expect(failure.httpResponse?.bodySha256).toBe(createHash("sha256").update(raw).digest("hex"));
    });
  });

  it("marks bytes received before a broken SSE connection as incomplete", async () => {
    const prefix = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(prefix);
      setTimeout(() => response.destroy(), 30);
    }, async (providerUrl) => {
      const error = await executeProviderChatCompletion(stepRequest(providerUrl, "sse"), {
        maxRetries: 0, retryDelaysMs: []
      }).then(() => { throw new Error("expected broken stream"); }, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderChatCompletionError);
      const failure = error as ProviderChatCompletionError;
      expect(failure.kind).toBe("body_read_error");
      expect(failure.httpResponse).toMatchObject({
        bodyComplete: false, bodyTruncated: false, bodyByteLength: Buffer.byteLength(prefix)
      });
      expect(Buffer.from(failure.httpResponse!.bodyBase64, "base64").toString("utf8")).toBe(prefix);
    });
  });

  it("retains a bounded raw HTTP failure with a digest of all received bytes", async () => {
    const raw = "x".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES + 5);
    await withServer((_request, response) => {
      response.writeHead(429, { "content-type": "text/plain" });
      response.end(raw);
    }, async (providerUrl) => {
      const error = await executeProviderChatCompletion(stepRequest(providerUrl), {
        maxRetries: 0, retryDelaysMs: []
      }).then(() => { throw new Error("expected HTTP failure"); }, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderChatCompletionError);
      const failure = error as ProviderChatCompletionError;
      expect(failure.kind).toBe("http_error");
      expect(failure.httpStatus).toBe(429);
      expect(failure.httpResponse).toMatchObject({
        contentType: "text/plain", bodyByteLength: raw.length,
        bodyTruncated: true, bodyComplete: true
      });
      expect(Buffer.from(failure.httpResponse!.bodyBase64, "base64").byteLength).toBe(
        MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES
      );
      expect(failure.httpResponse?.bodySha256).toBe(createHash("sha256").update(raw).digest("hex"));
      expect(Object.hasOwn(failure, "httpResponse")).toBe(false);
      expect(JSON.stringify(failure)).not.toContain("bodyBase64");
    });
  });

  it("retains complete SSE bytes past 64KiB only when full HTTP evidence is requested", async () => {
    const content = '{"value":"tail-marker"}';
    const wire =
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) } }] })}\n\n` +
      `data: ${JSON.stringify({
        choices: [{ delta: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      })}\n\ndata: [DONE]\n\n`;
    const original = Buffer.from(wire);
    expect(original.length).toBeGreaterThan(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(wire);
    }, async (providerUrl) => {
      const retained = await executeProviderChatCompletion(
        { ...stepRequest(providerUrl, "sse"), retainHttpResponseEvidence: true },
        { maxRetries: 0, retryDelaysMs: [] }
      );
      const defaulted = await executeProviderChatCompletion(stepRequest(providerUrl, "sse"), {
        maxRetries: 0, retryDelaysMs: []
      });
      expect(retained.result).toMatchObject({
        text: content, finishReason: "stop",
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
      });
      expect(retained.result.httpResponse).toMatchObject({
        bodyByteLength: original.length, bodyComplete: true, bodyTruncated: false,
        bodySha256: createHash("sha256").update(original).digest("hex")
      });
      const retainedBytes = Buffer.from(retained.result.httpResponse!.bodyBase64, "base64");
      expect(retainedBytes.equals(original)).toBe(true);
      expect(inspectProviderChatCompletionResponse(
        retainedBytes, retained.result.httpResponse!.contentType, 200, { sseCompletionPolicy: "require_witness" }
      )).toMatchObject({ text: content, finishReason: "stop" });
      expect(defaulted.result.text).toBe(content);
      expect(defaulted.result.httpResponse).toMatchObject({
        bodyByteLength: original.length, bodyComplete: true, bodyTruncated: true
      });
      expect(Buffer.from(defaulted.result.httpResponse!.bodyBase64, "base64").byteLength).toBe(
        MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES
      );
    });
  });

  it("still truncates genuinely oversized Step evidence when full retention is requested", async () => {
    const raw = "x".repeat(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES + 5);
    await withServer((_request, response) => {
      response.writeHead(429, { "content-type": "text/plain" });
      response.end(raw);
    }, async (providerUrl) => {
      const error = await executeProviderChatCompletion(
        { ...stepRequest(providerUrl), retainHttpResponseEvidence: true },
        { maxRetries: 0, retryDelaysMs: [] }
      ).then(() => { throw new Error("expected HTTP failure"); }, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderChatCompletionError);
      const failure = error as ProviderChatCompletionError;
      expect(failure.httpResponse).toMatchObject({
        bodyByteLength: raw.length, bodyTruncated: true, bodyComplete: true
      });
      expect(Buffer.from(failure.httpResponse!.bodyBase64, "base64").byteLength).toBe(
        MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES
      );
    });
  });

  it("rejects missing schema, cap, alternate model, and clean EOF before transport", () => {
    const request = stepRequest("https://api.stepfun.com/step_plan/v1");
    for (const invalid of [
      { ...request, jsonSchema: undefined },
      { ...request, maxOutputTokens: undefined },
      { ...request, outputTokenField: "max_completion_tokens" as const },
      { ...request, model: "step-3.5-flash" },
      { ...request, sseCompletionPolicy: "allow_clean_eof_v1" as const }
    ]) {
      expect(() => buildProviderChatRequestBody(invalid)).toThrow(/Step 3.5 2603 profile/u);
    }
  });
});
