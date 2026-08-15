import { createHash } from "node:crypto";
import {
  openExtractionAttemptLedger,
  readExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot
} from "../attempt-ledger.js";
import type { ExtractionAttemptLedgerCacheIdentity } from "../attempt-ledger-shards.js";

export interface InterruptedExtractionAttemptRecoveryInput {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
  readonly startingMissing: number;
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
}

export function recoverInterruptedExtractionAttemptLedger(
  input: InterruptedExtractionAttemptRecoveryInput
): ExtractionAttemptLedgerSnapshot {
  const existing = readExtractionAttemptLedger(input);
  if (existing === undefined) {
    throw new Error("interrupted extraction recovery requires an existing attempt ledger");
  }
  assertRecoverableInterruption(existing);
  const ledger = openExtractionAttemptLedger({
    ...input,
    publicationTemporaryDirectory: input.cacheRoot
  });
  for (const cacheKey of settledPendingKeys(ledger.snapshot())) {
    ledger.abandonPendingShard(cacheKey);
  }
  for (const cacheKey of unresolvedKeys(ledger.snapshot())) {
    const snapshot = ledger.snapshot();
    const reservations = snapshot.unresolvedAttempts.filter(
      (attempt) => attempt.cacheKey === cacheKey
    );
    if (reservations.length === 0) continue;
    const recoveredShard = snapshot.successfulKeys.includes(cacheKey);
    const failedReservations = recoveredShard ? reservations.slice(0, -1) : reservations;
    ledger.recordTransportOutcome(cacheKey, {
      retryCount: reservations.length - 1,
      rateLimitRetries: 0,
      ...(recoveredShard ? {} : { terminalRetryClassification: "failure_aborted" as const }),
      transportFailures: failedReservations.map((reservation, index) => ({
        attempt: index + 1,
        kind: "aborted" as const,
        phase: "request" as const,
        httpStatus: null,
        fingerprint: interruptionFingerprint(input.lineageDigest, reservation)
      }))
    });
    if (!recoveredShard) ledger.abandonPendingShard(cacheKey);
  }
  const recovered = ledger.snapshot();
  if (recovered.pendingKeys.length > 0 || recovered.unresolvedAttempts.length > 0) {
    throw new Error("interrupted extraction recovery did not durably settle the ledger");
  }
  return recovered;
}

function assertRecoverableInterruption(snapshot: ExtractionAttemptLedgerSnapshot): void {
  const pending = new Set(snapshot.pendingKeys);
  const successful = new Set(snapshot.successfulKeys);
  if (snapshot.unresolvedAttempts.some((attempt) =>
    !pending.has(attempt.cacheKey) && !successful.has(attempt.cacheKey))) {
    throw new Error("interrupted extraction ledger has an unrecoverable reservation shape");
  }
}

function settledPendingKeys(snapshot: ExtractionAttemptLedgerSnapshot): readonly string[] {
  const unresolved = new Set(snapshot.unresolvedAttempts.map((attempt) => attempt.cacheKey));
  return snapshot.pendingKeys.filter((cacheKey) => !unresolved.has(cacheKey)).sort();
}

function unresolvedKeys(snapshot: ExtractionAttemptLedgerSnapshot): readonly string[] {
  return [...new Set(snapshot.unresolvedAttempts.map((attempt) => attempt.cacheKey))].sort();
}

function interruptionFingerprint(
  lineageDigest: string,
  reservation: ExtractionAttemptLedgerSnapshot["unresolvedAttempts"][number]
): string {
  return createHash("sha256")
    .update("interrupted-extraction-attempt-v1\0", "utf8")
    .update(lineageDigest, "utf8")
    .update(`\0${reservation.attemptOrdinal}\0${reservation.cacheKey}`, "utf8")
    .digest("hex");
}
