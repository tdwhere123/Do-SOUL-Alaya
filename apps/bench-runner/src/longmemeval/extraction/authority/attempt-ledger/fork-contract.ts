import type { ExtractionAttemptLedgerSnapshot } from "../attempt-ledger.js";

export function assertMonotonicExtractionAttemptLedgerFork(input: {
  readonly predecessor: ExtractionAttemptLedgerSnapshot;
  readonly successor: ExtractionAttemptLedgerSnapshot;
  readonly successorLineageDigest: string;
}): void {
  const { predecessor, successor } = input;
  if (successor.lineageDigest !== input.successorLineageDigest ||
      successor.startingMissing !== predecessor.startingMissing ||
      successor.maximumAttempts !== predecessor.maximumAttempts ||
      successor.successfulShardCeiling !== predecessor.successfulShardCeiling ||
      successor.attempts < predecessor.attempts ||
      successor.pendingKeys.length !== 0 || successor.unresolvedAttempts.length !== 0 ||
      !containsSuccessfulEntries(successor, predecessor) ||
      !containsTransportFailures(successor, predecessor) ||
      !hasMonotonicTelemetry(successor, predecessor)) {
    throw new Error("successor extraction ledger is not a monotonic predecessor fork");
  }
}

function containsSuccessfulEntries(
  successor: ExtractionAttemptLedgerSnapshot,
  predecessor: ExtractionAttemptLedgerSnapshot
): boolean {
  const entries = new Map(successor.successfulEntries.map((entry) => [
    entry.cacheKey, entry.rawJsonSha256
  ]));
  return predecessor.successfulEntries.every((entry) =>
    entries.get(entry.cacheKey) === entry.rawJsonSha256
  );
}

function containsTransportFailures(
  successor: ExtractionAttemptLedgerSnapshot,
  predecessor: ExtractionAttemptLedgerSnapshot
): boolean {
  const failures = new Map(successor.transportFailures.map((failure) => [
    failure.attemptOrdinal, JSON.stringify(failure)
  ]));
  return predecessor.transportFailures.every((failure) =>
    failures.get(failure.attemptOrdinal) === JSON.stringify(failure)
  );
}

function hasMonotonicTelemetry(
  successor: ExtractionAttemptLedgerSnapshot,
  predecessor: ExtractionAttemptLedgerSnapshot
): boolean {
  const current = successor.telemetry;
  const inherited = predecessor.telemetry;
  return current.retrySuccesses >= inherited.retrySuccesses &&
    current.rateLimitRetries >= inherited.rateLimitRetries &&
    current.inputTokens >= inherited.inputTokens &&
    current.outputTokens >= inherited.outputTokens &&
    current.totalTokens >= inherited.totalTokens &&
    current.usageUnavailableRequests >= inherited.usageUnavailableRequests &&
    Object.keys(inherited.terminalRetryClassifications).every((key) =>
      current.terminalRetryClassifications[
        key as keyof typeof current.terminalRetryClassifications
      ] >= inherited.terminalRetryClassifications[
        key as keyof typeof inherited.terminalRetryClassifications
      ]
    );
}
