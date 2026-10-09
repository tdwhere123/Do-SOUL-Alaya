import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { INTERN_SEMANTIC_REQUEST_MODEL, INTERN_SEMANTIC_REQUEST_PROFILE,
  INTERN_SEMANTIC_PROVIDER_URL } from "@do-soul/alaya-protocol";
import { executeProviderChatCompletion, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES,
  ProviderChatCompletionError, type ProviderChatCompletionRequest } from "../../provider/chat-completion/index.js";

it.each(["intern", "step"] as const)("cancels a continuing successful %s response and retains honest received-byte evidence", async family => {
  const prefix = Buffer.from(JSON.stringify({ choices: [{ message: { content: '{"probe":true}' }, finish_reason: "stop" }] }));
  const padding = Buffer.alloc(64 * 1024, 0x20);
  let calls = 0, sent = 0, disconnected = false;
  let closed!: () => void;
  const closedPromise = new Promise<void>(resolve => { closed = resolve; });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* complete request ownership before response */ }
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.write(prefix); sent += prefix.length;
    const interval = setInterval(() => {
      if (response.destroyed) return;
      sent += padding.length;
      response.write(padding);
    }, 1);
    response.on("close", () => { clearInterval(interval); disconnected = true; closed(); });
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
    await closedPromise;
    expect(disconnected).toBe(true);
    expect(sent).toBeLessThan(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES + 2 * 1024 * 1024);
    expect(calls).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
