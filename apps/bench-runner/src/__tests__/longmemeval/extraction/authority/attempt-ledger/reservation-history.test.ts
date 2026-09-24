import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertExtractionAttemptReservation, inspectExtractionAttemptLedger, openExtractionAttemptLedger }
  from "../../../../../runs/extraction/authority/attempt-ledger.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cacheRoot = mkdtempSync(join(tmpdir(), "attempt-reservations-")); roots.push(cacheRoot);
  const identity = { cacheRoot, lineageDigest: "a".repeat(64),
    cacheIdentity: { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" as const } };
  const ledger = openExtractionAttemptLedger({ ...identity, startingMissing: 2 });
  return { identity, ledger, path: join(cacheRoot, `extraction-attempt-ledger.${identity.lineageDigest}.json`) };
}

it("retains exact settled ownership across reopen while leaving the other reservation unknown", () => {
  const f = fixture(), first = "1".repeat(64), second = "2".repeat(64);
  f.ledger.reserveAttemptOrdinal(first); f.ledger.reserveAttemptOrdinal(second);
  f.ledger.recordTransportOutcome(first, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1 }, 1);
  const before = readFileSync(f.path, "utf8");
  const read = inspectExtractionAttemptLedger(f.identity)!;
  expect(read.settledAttempts).toMatchObject([{ cacheKey: first, attemptOrdinal: 1,
    usageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }]);
  expect(read.unresolvedAttempts).toEqual([{ cacheKey: second, attemptOrdinal: 2 }]);
  expect(() => assertExtractionAttemptReservation(read, first, 1)).not.toThrow();
  expect(() => assertExtractionAttemptReservation(read, first, 2)).toThrow(/exact reserved attempt/u);
  expect(() => assertExtractionAttemptReservation(read, first, 3)).toThrow(/exact reserved attempt/u);
  expect(readFileSync(f.path, "utf8")).toBe(before);
  expect(openExtractionAttemptLedger({ ...f.identity, startingMissing: 2 }).snapshot().settledAttempts).toEqual(read.settledAttempts);
});

it.each(["overlap", "duplicate", "beyond-ceiling", "foreign-failure", "null-entry"] as const)(
  "rejects %s in retained settled identities", damage => {
    const f = fixture(), key = "1".repeat(64);
    f.ledger.reserveAttemptOrdinal(key);
    f.ledger.recordTransportOutcome(key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 0,
      terminalRetryClassification: "failure_non_retryable_response", transportFailures: [{ attempt: 1,
        kind: "network_error", phase: "request", httpStatus: null, fingerprint: "e".repeat(64) }] }, 1);
    const record = JSON.parse(readFileSync(f.path, "utf8"));
    if (damage === "overlap") record.unresolved_attempts = [...record.settled_attempts];
    if (damage === "duplicate") record.settled_attempts.push(record.settled_attempts[0]);
    if (damage === "beyond-ceiling") record.settled_attempts[0].attempt_ordinal = 9;
    if (damage === "foreign-failure") record.settled_attempts[0].cache_key = "2".repeat(64);
    if (damage === "null-entry") record.settled_attempts = [null];
    writeFileSync(f.path, JSON.stringify(record));
    expect(() => inspectExtractionAttemptLedger(f.identity)).toThrow(/invalid|recorded authority/u);
  }
);
