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
    ledger.recordTransportOutcome(cacheKey, {
      retryCount: 0,
      rateLimitRetries: 0,
      successfulRequestCount: 0,
      usageRequestCount: 0,
      unknownRequestCount: reservations.length,
      transportFailures: []
    });
    if (!snapshot.successfulKeys.includes(cacheKey)) ledger.abandonPendingShard(cacheKey);
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
