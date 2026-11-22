import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  executeProviderChatCompletion,
  MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES,
  ProviderChatCompletionError
} from "../../provider/chat-completion/index.js";
import { readProviderResponseWithEvidence } from "../../provider/chat-completion/response-evidence.js";

function buildExactJsonPayload(targetByteLength: number): Buffer {
  const prefix = Buffer.from('{"choices":[{"message":{"content":"{\\"probe\\":true}"},"finish_reason":"stop"}],"pad":"', "utf8");
  const suffix = Buffer.from('"}', "utf8");
  const padLength = targetByteLength - prefix.byteLength - suffix.byteLength;
  if (padLength < 0) {
    throw new Error("Target byte length smaller than JSON envelope.");
  }
  return Buffer.concat([prefix, Buffer.alloc(padLength, 0x61), suffix]);
}

function createChunkedStream(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
        return;
      }
      controller.close();
    },
    cancel() {
      onCancel?.();
    }
  });
}

describe("provider response 8 MiB byte boundary", () => {
  it("admits maxReadBytes - 1 and exact maxReadBytes (single-chunk + empty-chunk EOF and multi-chunk)", async () => {
    const cap = MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES;
    const oneBelow = buildExactJsonPayload(cap - 1);
    const exact = buildExactJsonPayload(cap);
    const half = Math.floor(cap / 2);

    const cases: ReadonlyArray<{
      readonly label: string;
      readonly expected: Buffer;
      readonly chunks: readonly Uint8Array[];
    }> = [
      { label: "max-1", expected: oneBelow, chunks: [oneBelow] },
      { label: "exact-with-empty-eof-chunk", expected: exact, chunks: [exact, new Uint8Array(0)] },
      { label: "exact-multi-chunk", expected: exact, chunks: [exact.subarray(0, half), exact.subarray(half)] }
    ];

    for (const testCase of cases) {
      const cancel = vi.fn();
      const response = new Response(createChunkedStream(testCase.chunks, cancel), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
      const result = await readProviderResponseWithEvidence(response, undefined, cap, cap);
      expect(cancel, testCase.label).not.toHaveBeenCalled();
      expect(result.evidence, testCase.label).toEqual({
        contentType: "application/json",
        bodyBase64: testCase.expected.toString("base64"),
        bodyByteLength: testCase.expected.byteLength,
        bodySha256: createHash("sha256").update(testCase.expected).digest("hex"),
        bodyTruncated: false,
        bodyComplete: true
      });

      const executed = await executeProviderChatCompletion({
        providerUrl: "https://api.stepfun.com/step_plan/v1",
        apiKey: "test-key",
        model: "step-3.5-flash-2603",
        profile: "step-3.5-2603-low-json-schema-v1",
        systemPrompt: "JSON only",
        userPrompt: "probe",
        mode: "json",
        jsonSchema: { name: "probe", schema: { type: "object" } },
        maxOutputTokens: 8192,
        timeoutMs: 5000,
        retainHttpResponseEvidence: true,
        fetchImpl: async () => new Response(createChunkedStream(testCase.chunks), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }, { maxRetries: 0, retryDelaysMs: [] });
      expect(executed.result.text, testCase.label).toBe('{"probe":true}');
      expect(executed.result.httpResponse?.bodyComplete, testCase.label).toBe(true);
      expect(executed.result.httpResponse?.bodyByteLength, testCase.label).toBe(testCase.expected.byteLength);
    }
  });

  it("cancels and rejects when stream exceeds maxReadBytes by 1 byte", async () => {
    const cap = MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES;
    const overByOne = buildExactJsonPayload(cap + 1);

    for (const chunks of [
      [overByOne],
      [overByOne.subarray(0, cap), overByOne.subarray(cap)]
    ]) {
      const cancel = vi.fn();
      const response = new Response(createChunkedStream(chunks, cancel), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
      const readResult = await readProviderResponseWithEvidence(response, undefined, cap, cap);
      expect(cancel).toHaveBeenCalledOnce();
      expect(readResult.evidence).toEqual({
        contentType: "application/json",
        bodyBase64: overByOne.subarray(0, cap).toString("base64"),
        bodyByteLength: cap + 1,
        bodySha256: createHash("sha256").update(overByOne).digest("hex"),
        bodyTruncated: true,
        bodyComplete: false
      });

      const error = await executeProviderChatCompletion({
        providerUrl: "https://api.stepfun.com/step_plan/v1",
        apiKey: "test-key",
        model: "step-3.5-flash-2603",
        profile: "step-3.5-2603-low-json-schema-v1",
        systemPrompt: "JSON only",
        userPrompt: "probe",
        mode: "json",
        jsonSchema: { name: "probe", schema: { type: "object" } },
        maxOutputTokens: 8192,
        timeoutMs: 5000,
        retainHttpResponseEvidence: true,
        fetchImpl: async () => new Response(createChunkedStream(chunks), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }, { maxRetries: 0, retryDelaysMs: [] }).then(
        () => { throw new Error("oversized response should fail"); },
        (cause: unknown) => cause
      );
      expect(error).toBeInstanceOf(ProviderChatCompletionError);
      expect(error).toMatchObject({
        kind: "response_parse_error",
        inspectionReason: "schema",
        httpStatus: 200,
        httpResponse: {
          bodyComplete: false,
          bodyTruncated: true,
          bodyByteLength: cap + 1
        }
      });
    }
  });
});
