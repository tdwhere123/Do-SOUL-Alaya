import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { INTERN_SEMANTIC_REQUEST_MODEL as MODEL, INTERN_SEMANTIC_REQUEST_PROFILE as PROFILE } from "@do-soul/alaya-protocol";
import { openExtractionAttemptLedger, ensureForkedExtractionAttemptLedger } from "../../../../../runs/extraction/authority/attempt-ledger.js";
import { createExtractionContinuationChildClaim } from "../../../../../runs/extraction/authority/continuation/child-claim.js";
import type { ExtractionAuthorityReceipt } from "../../../../../runs/extraction/authority/receipt.js";
import { settledAttemptUsageDigest } from "../../../../../runs/extraction/authority/attempt-ledger/outcome.js";
import { writeProviderRawAttempt, providerRawInvalidUsageOutcome, verifyProviderRawReservation,
  providerRawArtifactUsageMatches } from "../../../../../runs/extraction/fill/provider-raw-attempt.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const KEY = "12".repeat(32), LINEAGE = "ab".repeat(32), CHILD = "cd".repeat(32);
const identity = { model: MODEL, requestProfile: PROFILE };

function fixture(totalTokens: number) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "native-usage-settlement-")); roots.push(cacheRoot);
  const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest: LINEAGE, cacheIdentity: identity,
    startingMissing: 1, maximumAttempts: 1, maximumAttemptsPerKey: 1, successfulShardCeiling: 1 });
  const ordinal = ledger.reserveAttemptOrdinal(KEY);
  const usage = { inputTokens: 10, outputTokens: 2, totalTokens };
  const text = '{"contract":"source-semantic-query-response-v8","outcome":{"status":"abstained"}}';
  const bytes = Buffer.from(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: totalTokens } }));
  const raw = writeProviderRawAttempt({ root: cacheRoot, cacheKey: KEY, attemptOrdinal: ordinal,
    kind: "query", model: MODEL, requestProfile: PROFILE, requestDigest: "ef".repeat(32),
    attemptLineageDigest: LINEAGE, decodedText: text, finishReason: "stop", usage,
    httpResponse: { contentType: "application/json", bodyBase64: bytes.toString("base64"),
      bodyByteLength: bytes.length, bodySha256: createHash("sha256").update(bytes).digest("hex"),
      bodyComplete: true, bodyTruncated: false } });
  return { cacheRoot, ledger, raw, ordinal };
}

it("preserves rejected reported witnesses and unavailable metering through a settled monotonic fork and child claim", () => {
  const { cacheRoot, ledger, raw, ordinal } = fixture(13);
  ledger.recordTransportOutcome(KEY, providerRawInvalidUsageOutcome(raw, 8192)!, ordinal);
  const parent = ledger.snapshot();
  expect(parent).toMatchObject({ pendingKeys: [], unresolvedAttempts: [],
    settledAttempts: [{ usageAccounting: "invalid", usageSha256: settledAttemptUsageDigest(raw.usage) }],
    telemetry: { totalTokens: 0, usageUnavailableRequests: 1, usageUnknownAttempts: 1, usageInvalidAttempts: 1 } });
  expect(verifyProviderRawReservation(raw, parent, "accounting", 8192)).toBe("accounting_invalid");
  const fork = ensureForkedExtractionAttemptLedger({ cacheRoot, predecessorLineageDigest: LINEAGE,
    predecessorLedgerSha256: parent.ledgerSha256, predecessorRawLedgerSha256: parent.rawLedgerSha256,
    successorLineageDigest: CHILD, cacheIdentity: identity });
  expect(fork.settledAttempts).toEqual(parent.settledAttempts);
  expect(fork.telemetry).toEqual(parent.telemetry);
  const claim = createExtractionContinuationChildClaim({ predecessorReceiptDigest: "aa".repeat(32),
    predecessorLedger: parent, successor: { target_selection_digest: "bb".repeat(32), lineage_digest: CHILD,
      receipt_digest: "cc".repeat(32), continuation: { mode: "output_token_cap_renewal" } } as ExtractionAuthorityReceipt });
  expect(claim.predecessor).toMatchObject({ usage_unavailable_requests: 1, usage_invalid_attempts: 1 });
  expect(() => ledger.reserveAttemptOrdinal(KEY)).toThrow(/per-key attempt ceiling/u);
});

it("rejects a forged invalid settlement marker on arithmetically valid raw values", () => {
  const { ledger, raw, ordinal } = fixture(12);
  ledger.recordTransportOutcome(KEY, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
    usageRequestCount: 1, usage: raw.usage! }, ordinal);
  const snapshot = ledger.snapshot();
  const forged = { ...snapshot, settledAttempts: snapshot.settledAttempts.map(row => ({ ...row, usageAccounting: "invalid" as const })) };
  expect(() => verifyProviderRawReservation(raw, forged, "executable", 8192)).toThrow(/invalid-accounting settlement/u);
  expect(providerRawArtifactUsageMatches(raw, { outcome: { status: "invalid", reason: "invalid_usage" },
    admitted: false, max_output_tokens: 8192 })).toBe(false);
  expect(snapshot.telemetry).toMatchObject({ totalTokens: 12, usageUnknownAttempts: 0, usageInvalidAttempts: 0 });
});
