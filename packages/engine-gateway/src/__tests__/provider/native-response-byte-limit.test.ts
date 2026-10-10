import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)) delete process.env[key];
  }
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "127.0.0.1" || init?.redirect !== "error") {
      throw new Error("only no-redirect loopback transport is allowed");
    }
    return original(input, init);
  });
});
import { INTERN_SEMANTIC_REQUEST_MODEL, INTERN_SEMANTIC_REQUEST_PROFILE,
  INTERN_SEMANTIC_PROVIDER_URL } from "@do-soul/alaya-protocol";
import { executeProviderChatCompletion, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES,
  ProviderChatCompletionError, type ProviderChatCompletionRequest } from "../../provider/chat-completion/index.js";

function serveContinuingJson(
  response: ServerResponse,
  prefix: Buffer,
  padding: Buffer
): Promise<void> {
  return new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      resolve();
    };
    response.once("close", stop);
    response.writeHead(200, { "content-type": "application/json" });
    const pump = (): void => {
      if (stopped || response.destroyed || !response.writable) return;
      try {
        if (!response.write(padding)) {
          response.once("drain", pump);
          return;
        }
      } catch {
        stop();
        return;
      }
      setImmediate(pump);
    };
    try {
      if (!response.write(prefix)) response.once("drain", pump);
      else setImmediate(pump);
    } catch {
      stop();
    }
  });
}

it.each(["intern", "step"] as const)("cancels a continuing successful %s response and retains honest received-byte evidence", async family => {
  const prefix = Buffer.from(JSON.stringify({ choices: [{ message: { content: '{"probe":true}' }, finish_reason: "stop" }] }));
  const padding = Buffer.alloc(64 * 1024, 0x20);
  let calls = 0, disconnected = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* complete request ownership before response */ }
    calls += 1;
    await serveContinuingJson(response, prefix, padding);
    disconnected = true;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  const request: ProviderChatCompletionRequest = {
    providerUrl: family === "intern" ? INTERN_SEMANTIC_PROVIDER_URL : origin,
    model: family === "intern" ? INTERN_SEMANTIC_REQUEST_MODEL : "step-3.5-flash-2603",
    profile: family === "intern" ? INTERN_SEMANTIC_REQUEST_PROFILE : "step-3.5-2603-low-json-schema-v1",
    apiKey: "loopback-only", systemPrompt: "JSON only", userPrompt: "probe", mode: "json",
    jsonSchema: { name: "probe", schema: { type: "object" } }, maxOutputTokens: 8192,
    timeoutMs: 5000, retainHttpResponseEvidence: true, env: { ALAYA_ALLOW_PRIVATE_PROVIDER_URL: "1" },
    fetchImpl: (url, init) => nativeFetch(new URL(new URL(String(url)).pathname, origin), init)
  };
  try {
    const error = await executeProviderChatCompletion(request, { maxRetries: 0, retryDelaysMs: [] })
      .then(() => { throw new Error("oversized response was admitted"); }, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderChatCompletionError);
    const failure = error as ProviderChatCompletionError;
    expect(failure).toMatchObject({ kind: "response_parse_error", inspectionReason: "schema", httpStatus: 200 });
    const evidence = failure.httpResponse!;
    expect(evidence.bodyComplete).toBe(false);
    expect(evidence.bodyByteLength).toBeGreaterThanOrEqual(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
    expect(evidence.bodyByteLength).toBeLessThanOrEqual(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES + padding.length);
    const retained = Buffer.from(evidence.bodyBase64, "base64");
    expect(retained).toHaveLength(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
    expect(retained.subarray(0, prefix.length)).toEqual(prefix);
    expect(evidence.bodyTruncated).toBe(evidence.bodyByteLength > retained.length);
    expect(evidence.bodySha256).toBe(createHash("sha256").update(prefix)
      .update(Buffer.alloc(evidence.bodyByteLength - prefix.length, 0x20)).digest("hex"));
    await vi.waitFor(() => expect(disconnected).toBe(true));
    expect(calls).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const COMPLETE_JSON_BODY = JSON.stringify({
  choices: [{ message: { content: '{"probe":true}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
});

function omittedRetainRequest(
  origin: string,
  family: "mimo" | "step"
): ProviderChatCompletionRequest {
  return {
    providerUrl: origin,
    apiKey: "loopback-only",
    model: family === "mimo" ? "mimo-v2.5" : "step-3.5-flash-2603",
    profile: family === "mimo" ? "mimo-v2.5-nonthinking-v1" : "step-3.5-2603-low-json-schema-v1",
    systemPrompt: "JSON only",
    userPrompt: "probe",
    mode: "json",
    timeoutMs: 5000,
    env: { ALAYA_ALLOW_PRIVATE_PROVIDER_URL: "1" },
    ...(family === "step" ? {
      jsonSchema: { name: "probe", schema: { type: "object" } },
      maxOutputTokens: 8192
    } : {})
  };
}

async function withLoopbackOrigin<T>(
  write: (response: import("node:http").ServerResponse) => void | Promise<void>,
  run: (origin: string) => Promise<T>
): Promise<T> {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* complete request ownership before response */ }
    await write(response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it.each(["mimo", "step"] as const)(
  "cancels a continuing omitted-retain %s response at the complete HTTP byte limit",
  async family => {
    const prefix = Buffer.from(COMPLETE_JSON_BODY);
    const padding = Buffer.alloc(64 * 1024, 0x20);
    let calls = 0, disconnected = false;
    await withLoopbackOrigin(async response => {
      calls += 1;
      await serveContinuingJson(response, prefix, padding);
      disconnected = true;
    }, async origin => {
      const error = await executeProviderChatCompletion(omittedRetainRequest(origin, family), {
        maxRetries: 0, retryDelaysMs: []
      }).then(() => { throw new Error("oversized response was admitted"); }, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderChatCompletionError);
      const failure = error as ProviderChatCompletionError;
      expect(failure).toMatchObject({ kind: "response_parse_error", inspectionReason: "schema", httpStatus: 200 });
      const evidence = failure.httpResponse!;
      expect(evidence.bodyComplete).toBe(false);
      expect(evidence.bodyByteLength).toBeGreaterThanOrEqual(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
      expect(evidence.bodyByteLength).toBeLessThanOrEqual(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES + padding.length);
      await vi.waitFor(() => expect(disconnected).toBe(true));
      expect(calls).toBe(1);
    });
  }
);

it.each(["mimo", "step"] as const)(
  "admits a complete omitted-retain %s response below the complete HTTP byte limit",
  async family => {
    await withLoopbackOrigin(response => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(COMPLETE_JSON_BODY);
    }, async origin => {
      const executed = await executeProviderChatCompletion(omittedRetainRequest(origin, family), {
        maxRetries: 0, retryDelaysMs: []
      });
      expect(executed.result).toMatchObject({
        text: '{"probe":true}',
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        httpStatus: 200
      });
      if (family === "mimo") {
        expect(executed.result.httpResponse).toBeUndefined();
      } else {
        expect(executed.result.httpResponse).toMatchObject({
          bodyComplete: true,
          bodyTruncated: false,
          bodyByteLength: Buffer.byteLength(COMPLETE_JSON_BODY)
        });
      }
    });
  }
);
