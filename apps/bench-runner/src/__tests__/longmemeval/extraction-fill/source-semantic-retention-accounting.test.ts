import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listExtractionAttemptLedgerRecords, openExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { listProviderRawAttempts, providerRawAttemptPath, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";

const MODEL = "gemini-2.5-flash-lite", PROFILE = "gemini-2.5-nonthinking-v1";
const ABSTAINED = JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "abstained" } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

it.each([
  { shape: "decoded truncation", usageKnown: true, padding: 1024 * 1024 },
  { shape: "decoded truncation", usageKnown: false, padding: 1024 * 1024 },
  { shape: "physical truncation", usageKnown: true, padding: 1024 * 1024 - Buffer.byteLength(ABSTAINED) },
  { shape: "complete retained response", usageKnown: true, padding: 8 * 1024 },
  { shape: "complete retained response", usageKnown: false, padding: 8 * 1024 }
])("preserves historical $shape and usageKnown=$usageKnown without renewed execution or admission", async fixture => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "retained-source-response-")); roots.push(cacheRoot);
  const key = "1".repeat(64), lineageDigest = "2".repeat(64);
  const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest,
    cacheIdentity: { model: MODEL, requestProfile: PROFILE }, startingMissing: 1, maximumAttempts: 1, successfulShardCeiling: 1 });
  const ordinal = await ledger.reserveAttemptOrdinal(key);
  const response = ABSTAINED + "\n".repeat(fixture.padding);
  const usage = fixture.usageKnown ? { inputTokens: 10, outputTokens: 20, totalTokens: 30 } : undefined;
  // Install an archived physical response and its settled accounting, not a new extraction.
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: key, attemptOrdinal: ordinal, kind: "source_semantic",
    model: MODEL, requestProfile: PROFILE, requestDigest: "3".repeat(64), decodedText: response, finishReason: "STOP",
    ...(usage === undefined ? {} : { usage }), responseBody: JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }],
      ...(usage === undefined ? {} : { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } }) }) });
  ledger.recordTransportOutcome(key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
    transportFailures: [], usageRequestCount: fixture.usageKnown ? 1 : 0,
    ...(usage === undefined ? {} : { usage }) }, ordinal);
  ledger.abandonPendingShard(key, ordinal);
  const path = providerRawAttemptPath(cacheRoot, key, ordinal), bytes = readFileSync(path);
  const settled = listExtractionAttemptLedgerRecords(cacheRoot);
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({ attempts: 1, unresolved_attempts: [], pending_keys: [], successful_shards: [],
    settled_attempts: [{ cache_key: key, attempt_ordinal: ordinal }], telemetry: {
      input_tokens: fixture.usageKnown ? 10 : 0, output_tokens: fixture.usageKnown ? 20 : 0,
      total_tokens: fixture.usageKnown ? 30 : 0, usage_unavailable_requests: fixture.usageKnown ? 0 : 1 } });
  const factory = vi.fn(() => { throw new Error("retired transport must not be constructed"); });
  for (let inspection = 0; inspection < 2; inspection += 1) {
    const [raw] = listProviderRawAttempts(cacheRoot, key);
    expect(raw).toMatchObject({ cache_key: key, attempt_ordinal: ordinal, usage_known: fixture.usageKnown,
      usage: usage ?? null, decoded_text_digest: createHash("sha256").update(response).digest("hex"),
      original_byte_length: Buffer.byteLength(response), full_replay_possible: fixture.shape !== "decoded truncation",
      decoded_text_truncated: fixture.shape === "decoded truncation",
      response_body: { truncated: fixture.shape !== "complete retained response" } });
    expect(JSON.parse(raw!.decoded_text)).toEqual(JSON.parse(ABSTAINED));
    await expect(runExtractionFill({ variant: "longmemeval_s", cacheRoot, dataDir: join(cacheRoot, "absent-dataset"),
      sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
      extractorFactory: factory })).rejects.toThrow("retired passive generation");
    expect(factory).not.toHaveBeenCalled(); expect(existsSync(cacheFilePath(cacheRoot, key))).toBe(false);
    expect(readFileSync(path)).toEqual(bytes); expect(listExtractionAttemptLedgerRecords(cacheRoot)).toEqual(settled);
  }
});
