import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
const { executeProviderChatCompletion, ProviderChatCompletionError } = await import("../../provider/chat-completion/index.js");
const { PROVIDER_FAILURE_BODY_DIGEST_BYTES } = await import("../../provider/chat-completion/failure-identity.js");
const { AlayaError } = await import("@do-soul/alaya-protocol");
const request = {
  providerUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic", model: "step-3.5-flash-2603",
  profile: "step-3.5-2603-low-json-schema-v1", systemPrompt: "system", userPrompt: "user",
  jsonSchema: { name: "payload", schema: { type: "object", properties: {}, additionalProperties: false } },
  maxOutputTokens: 128, env: { ALAYA_ALLOW_PRIVATE_PROVIDER_URL: "1" }
} as const;

it("keeps local Step schema rejection non-transport and never dispatches or retries", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(executeProviderChatCompletion({ ...request, jsonSchema: undefined, jsonObject: true, fetchImpl }, {
    maxRetries: 1, retryDelaysMs: [0], retryNetworkErrors: true
  })).rejects.toBeInstanceOf(AlayaError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("cancels a continuing non-OK Step body after a bounded prefix and retains incomplete received-byte evidence", async () => {
  const bytes = new Uint8Array(PROVIDER_FAILURE_BODY_DIGEST_BYTES).fill(120);
  const cancel = vi.fn();
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(bytes); }, cancel });
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).hostname).toBe("127.0.0.1");
    expect(init?.redirect).toBe("error");
    return new Response(body, { status: 500 });
  });
  const error = await executeProviderChatCompletion({ ...request, fetchImpl, retainHttpResponseEvidence: true }, {
    maxRetries: 0, retryDelaysMs: []
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ProviderChatCompletionError);
  const failure = error as InstanceType<typeof ProviderChatCompletionError>;
  expect(failure.kind).toBe("http_error");
  expect(cancel).toHaveBeenCalledOnce();
  expect(reads).toBeLessThanOrEqual(2);
  expect(failure.httpResponse).toMatchObject({ bodyComplete: false, bodyTruncated: false,
    bodyByteLength: bytes.length, bodySha256: createHash("sha256").update(bytes).digest("hex") });
  expect(Buffer.from(failure.httpResponse!.bodyBase64, "base64")).toEqual(Buffer.from(bytes));
});

it("digests every received Step error byte and retains only the bounded prefix", async () => {
  const first = new Uint8Array(10 * 1024).fill(120);
  const overflow = new Uint8Array(10 * 1024).fill(121);
  const received = Buffer.concat([first, overflow]);
  const cancel = vi.fn();
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(reads === 0 ? first : overflow);
      reads += 1;
    },
    cancel
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 500 }));
  const error = await executeProviderChatCompletion({ ...request, fetchImpl, retainHttpResponseEvidence: true }, {
    maxRetries: 0, retryDelaysMs: []
  }).catch((cause: unknown) => cause);
  const failure = error as InstanceType<typeof ProviderChatCompletionError>;
  const retained = Buffer.from(failure.httpResponse!.bodyBase64, "base64");
  expect(failure).toMatchObject({ kind: "http_error", httpStatus: 500, httpResponse: {
    bodyComplete: false, bodyTruncated: true, bodyByteLength: received.length,
    bodySha256: createHash("sha256").update(received).digest("hex")
  } });
  expect(retained).toEqual(received.subarray(0, PROVIDER_FAILURE_BODY_DIGEST_BYTES));
  expect(retained.length).toBeLessThan(failure.httpResponse!.bodyByteLength);
  expect(reads).toBeLessThanOrEqual(3);
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("keeps a finished short Step error body complete instead of treating every error as capped", async () => {
  const raw = Buffer.from("short-error");
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(raw, { status: 400, headers: { "content-type": "text/plain" } }));
  const error = await executeProviderChatCompletion({ ...request, fetchImpl }, {
    maxRetries: 0, retryDelaysMs: []
  }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ kind: "http_error", httpStatus: 400, httpResponse: {
    bodyComplete: true, bodyTruncated: false, bodyByteLength: raw.byteLength,
    bodySha256: createHash("sha256").update(raw).digest("hex")
  } });
});

it.each([200, 500])("keeps a dropped body after HTTP %s as body-read failure, not status retry", async status => {
  const prefix = Buffer.from("partial");
  let read = false;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe("error");
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!read) { read = true; controller.enqueue(prefix); }
      else controller.error(new Error("read failed"));
    } }), { status });
  });
  const error = await executeProviderChatCompletion({ ...request, fetchImpl }, {
    maxRetries: 1, retryDelaysMs: [0], retryHttpStatuses: [500], retryBodyReadErrors: false
  }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ kind: "body_read_error", httpStatus: status, httpResponse: {
    bodyComplete: false, bodyTruncated: false, bodyByteLength: prefix.length,
    bodySha256: createHash("sha256").update(prefix).digest("hex")
  } });
  expect(fetchImpl).toHaveBeenCalledOnce();
});
