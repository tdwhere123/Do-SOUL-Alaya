import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  inspectProviderChatCompletionResponse,
  MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES,
  MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES
} from "@do-soul/alaya-engine-gateway";
import { providerRawAttemptPath, providerRawSuccessEvidenceState, readProviderRawAttempt,
  writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const RAW_CAP = 1024 * 1024;
const BODY_CAP = 64 * 1024;
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "provider-raw-retention-")); roots.push(root);
  return { root, cacheKey: "a".repeat(64), attemptOrdinal: 1, kind: "query" as const,
    attemptLineageDigest: "b".repeat(64), requestDigest: "c".repeat(64),
    model: "fixture-model", requestProfile: "fixture-profile", finishReason: "STOP" };
}

const cases: readonly { name: string; text: string; retained: string; truncated: boolean;
  body?: string; retainedBody?: string; bodyTruncated?: boolean }[] = [
  { name: "small complete", text: "{}", retained: "{}", truncated: false },
  { name: "complete newline boundary", text: "\n".repeat(RAW_CAP - 2) + "{}",
    retained: "\n".repeat(RAW_CAP - 2) + "{}", truncated: false },
  { name: "truncated newline boundary", text: "\n".repeat(RAW_CAP + 4),
    retained: "\n".repeat(RAW_CAP), truncated: true },
  { name: "simultaneous maximum JSON escaping", text: "\0".repeat(RAW_CAP), retained: "\0".repeat(RAW_CAP),
    body: "\0".repeat(BODY_CAP), retainedBody: "\0".repeat(BODY_CAP), truncated: false, bodyTruncated: false },
  { name: "simultaneous truncated maximum JSON escaping", text: "\0".repeat(RAW_CAP + 1), retained: "\0".repeat(RAW_CAP),
    body: "\0".repeat(BODY_CAP + 1), retainedBody: "\0".repeat(BODY_CAP), truncated: true, bodyTruncated: true },
  { name: "simultaneous split UTF-8 boundaries", text: "\0".repeat(RAW_CAP - 1) + "😀",
    retained: "\0".repeat(RAW_CAP - 1) + "\uFFFD", body: "\0".repeat(BODY_CAP - 1) + "😀",
    retainedBody: "\0".repeat(BODY_CAP - 1) + "\uFFFD", truncated: true, bodyTruncated: true }
];

it.each(cases.flatMap(row => [true, false].map(usageKnown => ({ ...row, usageKnown }))))(
  "reopens $name with usageKnown=$usageKnown without changing retained evidence", ({ text, retained, truncated, body,
    retainedBody, bodyTruncated, usageKnown }) => {
    const input = fixture();
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
    const written = writeProviderRawAttempt({ ...input, decodedText: text,
      ...(usageKnown ? { usage } : {}), ...(body === undefined ? {} : { responseBody: body }) });
    const bytes = readFileSync(providerRawAttemptPath(input.root, input.cacheKey, 1));
    if (text.length >= RAW_CAP) expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
    for (let reopen = 0; reopen < 2; reopen += 1) {
      const raw = readProviderRawAttempt(input.root, input.cacheKey, 1)!;
      expect(raw).toEqual(written);
      expect(raw).toMatchObject({ decoded_text: retained, decoded_text_truncated: truncated,
        original_byte_length: Buffer.byteLength(text), decoded_text_digest: digest(text), full_replay_possible: !truncated,
        attempt_ordinal: 1, attempt_lineage_digest: input.attemptLineageDigest, finish_reason: "STOP",
        completion_witness: "finish_reason", usage_known: usageKnown, usage: usageKnown ? usage : null });
      if (body !== undefined) expect(raw.response_body).toEqual({ text: retainedBody,
        truncated: bodyTruncated, original_byte_length: Buffer.byteLength(body), digest: digest(body) });
      else expect(raw.response_body).toBeUndefined();
      expect(readFileSync(providerRawAttemptPath(input.root, input.cacheKey, 1)).equals(bytes)).toBe(true);
    }
  }
);

it.each([null, "MAX_TOKENS"])("preserves actual incomplete finish %s through escaped retention", finishReason => {
  const input = fixture();
  writeProviderRawAttempt({ ...input, finishReason, decodedText: "\0".repeat(RAW_CAP) });
  expect(readProviderRawAttempt(input.root, input.cacheKey, 1)).toMatchObject({ finish_reason: finishReason,
    completion_witness: finishReason === null ? null : "finish_reason", full_replay_possible: true, usage_known: false });
});

it("binds a complete Gemini body to decoded text, finish and usage on write and reopen", () => {
  const input = { ...fixture(), requestProfile: "gemini-2.5-nonthinking-v1" };
  const body = JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } });
  const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
  writeProviderRawAttempt({ ...input, decodedText: "{}", finishReason: "STOP", usage, responseBody: body });
  expect(readProviderRawAttempt(input.root, input.cacheKey, 1)).toMatchObject({
    decoded_text: "{}", finish_reason: "STOP", usage
  });
  const path = providerRawAttemptPath(input.root, input.cacheKey, 1);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  const changedBody = body.replace('"finishReason":"STOP"', '"finishReason":"MAX_TOKENS"');
  stored.response_body = { text: changedBody, truncated: false,
    original_byte_length: Buffer.byteLength(changedBody), digest: digest(changedBody) };
  writeFileSync(path, `${JSON.stringify(stored)}\n`);
  expect(() => readProviderRawAttempt(input.root, input.cacheKey, 1))
    .toThrow(/physical response differs/u);
});

it("retains missing and truncated Gemini body witnesses without inventing decoded evidence", () => {
  const missing = { ...fixture(), requestProfile: "gemini-2.5-nonthinking-v1" };
  writeProviderRawAttempt({ ...missing, decodedText: "{}", finishReason: null });
  const missingRaw = readProviderRawAttempt(missing.root, missing.cacheKey, 1);
  expect(missingRaw?.response_body).toBeUndefined();
  expect(missingRaw).toMatchObject({ finish_reason: null, usage: null, usage_known: false });
  const truncated = { ...fixture(), requestProfile: "gemini-2.5-nonthinking-v1" };
  writeProviderRawAttempt({ ...truncated, decodedText: "{}", finishReason: "MAX_TOKENS",
    responseBody: "x".repeat(BODY_CAP + 1) });
  expect(readProviderRawAttempt(truncated.root, truncated.cacheKey, 1)).toMatchObject({
    response_body: { truncated: true }, finish_reason: "MAX_TOKENS", usage: null
  });
});

it("requires a Step HTTP witness for completed output but keeps a witness-free failure readable", () => {
  const input = { ...fixture(), requestProfile: "step-3.5-2603-low-json-schema-v1" };
  expect(() => writeProviderRawAttempt({ ...input, decodedText: "{}" })).toThrow(/integrity mismatch/u);
  expect(existsSync(providerRawAttemptPath(input.root, input.cacheKey, 1))).toBe(false);
  const failure = { kind: "network_error" as const, phase: "request" as const,
    httpStatus: null, fingerprint: "d".repeat(64), attempt: 1 };
  writeProviderRawAttempt({ ...input, decodedText: "", finishReason: null, transportFailure: failure });
  const raw = readProviderRawAttempt(input.root, input.cacheKey, 1)!;
  expect(raw.http_response).toBeUndefined();
  expect(raw.transport_failure).toEqual(failure);
  expect(providerRawSuccessEvidenceState(raw)).toBe("failed");
});

it("reopens complete Step HTTP evidence larger than the default 64KiB prefix", () => {
  const input = { ...fixture(), requestProfile: "step-3.5-2603-low-json-schema-v1", finishReason: "stop" };
  const content = "{\"value\":\"tail-marker\"}";
  const wire =
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) } }] })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
    })}\n\ndata: [DONE]\n\n`;
  const bytes = Buffer.from(wire);
  expect(bytes.length).toBeGreaterThan(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
  expect(bytes.length).toBeLessThanOrEqual(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
  const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
  const httpResponse = {
    contentType: "text/event-stream", bodyBase64: bytes.toString("base64"),
    bodyByteLength: bytes.length, bodySha256: digest(wire), bodyTruncated: false, bodyComplete: true
  };
  writeProviderRawAttempt({ ...input, decodedText: content, usage, httpResponse });
  const raw = readProviderRawAttempt(input.root, input.cacheKey, 1)!;
  expect(providerRawSuccessEvidenceState(raw)).toBe("bound");
  expect(raw.http_response).toMatchObject({
    bodyByteLength: bytes.length, bodyTruncated: false, bodyComplete: true
  });
  expect(Buffer.from(raw.http_response!.bodyBase64, "base64").equals(bytes)).toBe(true);
  expect(inspectProviderChatCompletionResponse(
    Buffer.from(raw.http_response!.bodyBase64, "base64"), raw.http_response!.contentType, 200,
    { sseCompletionPolicy: "require_witness" }
  )).toMatchObject({ text: content, finishReason: "stop", usage });
});

it("reopens a complete near-8MiB Step HTTP body whose serialized record exceeds the previous 6_750_232-byte cap", () => {
  const input = { ...fixture(), requestProfile: "step-3.5-2603-low-json-schema-v1", finishReason: "stop" };
  const content = "{\"value\":\"tail-marker\"}";
  const tail = `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  })}\n\ndata: [DONE]\n\n`;
  const headOpen = `data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"`;
  const headClose = `\"}}]}\n\n`;
  const reasoningBytes = MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES
    - Buffer.byteLength(headOpen) - Buffer.byteLength(headClose) - Buffer.byteLength(tail);
  const wire = `${headOpen}${"r".repeat(reasoningBytes)}${headClose}${tail}`;
  const bytes = Buffer.from(wire);
  expect(bytes.length).toBe(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
  const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
  writeProviderRawAttempt({
    ...input, decodedText: content, usage,
    httpResponse: {
      contentType: "text/event-stream", bodyBase64: bytes.toString("base64"),
      bodyByteLength: bytes.length, bodySha256: createHash("sha256").update(bytes).digest("hex"),
      bodyTruncated: false, bodyComplete: true
    }
  });
  const path = providerRawAttemptPath(input.root, input.cacheKey, 1);
  const serialized = readFileSync(path);
  expect(serialized.byteLength).toBeGreaterThan(6_750_232);
  const raw = readProviderRawAttempt(input.root, input.cacheKey, 1)!;
  expect(providerRawSuccessEvidenceState(raw)).toBe("bound");
  expect(raw).toMatchObject({
    decoded_text: content, finish_reason: "stop", usage,
    original_byte_length: Buffer.byteLength(content),
    http_response: { bodyByteLength: bytes.length, bodyTruncated: false, bodyComplete: true }
  });
  expect(Buffer.from(raw.http_response!.bodyBase64, "base64").equals(bytes)).toBe(true);
  expect(inspectProviderChatCompletionResponse(
    Buffer.from(raw.http_response!.bodyBase64, "base64"), raw.http_response!.contentType, 200,
    { sseCompletionPolicy: "require_witness" }
  )).toMatchObject({ text: content, finishReason: "stop", usage });
  expect(readProviderRawAttempt(input.root, input.cacheKey, 1)).toEqual(raw);
  expect(readFileSync(path).equals(serialized)).toBe(true);
});

it("still treats default 64KiB Step HTTP prefixes as truncated and rejects forged complete oversized evidence", () => {
  const input = { ...fixture(), requestProfile: "step-3.5-2603-low-json-schema-v1", finishReason: "stop" };
  const content = "{}";
  const full = "y".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES + 8);
  const prefix = full.slice(0, MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES);
  writeProviderRawAttempt({
    ...input, decodedText: content,
    httpResponse: {
      contentType: "text/plain", bodyBase64: Buffer.from(prefix).toString("base64"),
      bodyByteLength: full.length, bodySha256: digest(full), bodyTruncated: true, bodyComplete: true
    }
  });
  expect(providerRawSuccessEvidenceState(readProviderRawAttempt(input.root, input.cacheKey, 1)!)).toBe("truncated");
  const oversized = { ...fixture(), requestProfile: "step-3.5-2603-low-json-schema-v1", finishReason: "stop" };
  const tooLarge = Buffer.alloc(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES + 1, 0x61);
  expect(() => writeProviderRawAttempt({
    ...oversized, decodedText: content,
    httpResponse: {
      contentType: "text/plain", bodyBase64: tooLarge.toString("base64"),
      bodyByteLength: tooLarge.length, bodySha256: createHash("sha256").update(tooLarge).digest("hex"),
      bodyTruncated: false, bodyComplete: true
    }
  })).toThrow(/integrity mismatch/u);
});

it("rejects a digest-consistent complete response body above its retention limit", () => {
  const input = fixture();
  const raw = writeProviderRawAttempt({ ...input, decodedText: "{}", responseBody: "body" });
  const text = "b".repeat(BODY_CAP + 1);
  writeFileSync(providerRawAttemptPath(input.root, input.cacheKey, 1), JSON.stringify({ ...raw,
    response_body: { text, truncated: false, original_byte_length: Buffer.byteLength(text), digest: digest(text) } }));
  expect(() => readProviderRawAttempt(input.root, input.cacheKey, 1)).toThrow(/integrity mismatch/u);
});

it("rejects an over-budget metadata envelope before creating raw directories or publishing an unreadable record", () => {
  const input = fixture();
  const model = "m".repeat(8 * 1024 * 1024);
  expect(() => writeProviderRawAttempt({ ...input, model, decodedText: "{}" })).toThrow(/size limit/u);
  const path = providerRawAttemptPath(input.root, input.cacheKey, 1);
  expect(existsSync(dirname(path))).toBe(false);
  expect(existsSync(path)).toBe(false);
  const raw = writeProviderRawAttempt({ ...input, decodedText: "{}" });
  writeFileSync(path, JSON.stringify({ ...raw, model }));
  expect(() => readProviderRawAttempt(input.root, input.cacheKey, 1)).toThrow(/size limit/u);
});
