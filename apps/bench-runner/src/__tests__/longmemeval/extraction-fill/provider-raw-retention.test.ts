import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { providerRawAttemptPath, readProviderRawAttempt, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";

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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ model }));
  expect(() => readProviderRawAttempt(input.root, input.cacheKey, 1)).toThrow(/size limit/u);
});
