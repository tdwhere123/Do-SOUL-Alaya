import type {
  BenchProviderUsage,
  BenchTerminalRetryClassification,
  BenchTransportFailureAttempt,
  BenchTransportFailureKind,
  BenchTransportFailurePhase
} from "../../../compile-seed/compile-seed-types.js";
import type {
  ExtractionAttemptLedgerRecord,
  ExtractionAttemptReservationRecord,
  ExtractionTransportFailureRecord
} from "./contract.js";

export interface ExtractionTransportOutcome {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly terminalRetryClassification?: BenchTerminalRetryClassification;
  readonly transportFailures?: readonly BenchTransportFailureAttempt[];
  readonly usage?: BenchProviderUsage;
}

export class ExtractionAttemptLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionAttemptLimitError";
  }
}

export function reserveTransportAttempt(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  if (current.attempts >= current.maximum_attempts) {
    throw new ExtractionAttemptLimitError(
      `extraction attempt ceiling exhausted: ${current.attempts}/${current.maximum_attempts}`
    );
  }
  if (current.successful_shards.some((shard) => shard.cacheKey === cacheKey)) {
    throw new ExtractionAttemptLimitError("extraction authority refuses a duplicate successful shard");
  }
  const pending = current.pending_keys.includes(cacheKey);
  if (!pending && current.successful_shards.length + current.pending_keys.length >=
      current.successful_shard_ceiling) {
    throw new ExtractionAttemptLimitError(
      "extraction successful-shard ceiling is fully reserved: " +
      `${current.successful_shards.length}/${current.successful_shard_ceiling}`
    );
  }
  const attemptOrdinal = current.attempts + 1;
  return {
    ...current,
    attempts: attemptOrdinal,
    pending_keys: pending ? current.pending_keys : sortedKeys([...current.pending_keys, cacheKey]),
    unresolved_attempts: [...current.unresolved_attempts, {
      attempt_ordinal: attemptOrdinal,
      cache_key: cacheKey
    }]
  };
}

export function abandonPendingShard(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  if (!current.pending_keys.includes(cacheKey)) return current;
  return { ...current, pending_keys: current.pending_keys.filter((key) => key !== cacheKey) };
}

export function settleTransportOutcome(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string,
  input: ExtractionTransportOutcome
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  assertOutcome(input);
  const unresolved = current.unresolved_attempts.filter(
    (reservation) => reservation.cache_key === cacheKey
  );
  const failures = input.transportFailures ?? [];
  const terminal = input.terminalRetryClassification !== undefined;
  assertFailureCount(input, failures.length, terminal);
  const currentReservationCount = failures.length + (terminal ? 0 : 1);
  if (currentReservationCount === 0 || unresolved.length < currentReservationCount) {
    throw new ExtractionAttemptLimitError(
      "extraction outcome failure count does not match its latest reservations"
    );
  }
  const currentReservations = unresolved.slice(-currentReservationCount);
  const mappedFailures = mapTransportFailures(currentReservations, failures);
  return applySettledOutcome(current, cacheKey, input, unresolved, mappedFailures);
}

function mapTransportFailures(
  reservations: readonly ExtractionAttemptReservationRecord[],
  failures: readonly BenchTransportFailureAttempt[]
): readonly ExtractionTransportFailureRecord[] {
  if (failures.length > reservations.length) {
    throw new ExtractionAttemptLimitError(
      "extraction outcome failure count exceeds its latest reservations"
    );
  }
  return failures.map((failure, index) => {
    assertFailureAttempt(failure, index + 1);
    const reservation = reservations[index];
    if (reservation === undefined) {
      throw new ExtractionAttemptLimitError("extraction outcome has no matching reservation");
    }
    return {
      attempt_ordinal: reservation.attempt_ordinal,
      cache_key: reservation.cache_key,
      kind: failure.kind,
      phase: failure.phase,
      http_status: failure.httpStatus,
      fingerprint: failure.fingerprint
    };
  });
}

function applySettledOutcome(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string,
  input: ExtractionTransportOutcome,
  unresolved: readonly ExtractionAttemptReservationRecord[],
  failures: readonly ExtractionTransportFailureRecord[]
): ExtractionAttemptLedgerRecord {
  const terminal = {
    ...current.telemetry.terminal,
    ...(input.terminalRetryClassification === undefined ? {} : {
      [input.terminalRetryClassification]:
        current.telemetry.terminal[input.terminalRetryClassification] + 1
    })
  };
  const knownUsageAttempts = input.usage === undefined ? 0 : 1;
  const usage = input.usage;
  return {
    ...current,
    unresolved_attempts: current.unresolved_attempts.filter(
      (reservation) => reservation.cache_key !== cacheKey
    ),
    transport_failures: [...current.transport_failures, ...failures]
      .sort((left, right) => left.attempt_ordinal - right.attempt_ordinal),
    telemetry: {
      retry_successes: current.telemetry.retry_successes +
        (!terminalOutcome(input) && input.retryCount > 0 ? 1 : 0),
      rate_limit_retries: current.telemetry.rate_limit_retries + input.rateLimitRetries,
      terminal,
      input_tokens: current.telemetry.input_tokens + (usage?.inputTokens ?? 0),
      output_tokens: current.telemetry.output_tokens + (usage?.outputTokens ?? 0),
      total_tokens: current.telemetry.total_tokens + (usage?.totalTokens ?? 0),
      usage_unavailable_requests: current.telemetry.usage_unavailable_requests +
        unresolved.length - knownUsageAttempts
    }
  };
}

function assertFailureCount(
  input: ExtractionTransportOutcome,
  failureCount: number,
  terminal: boolean
): void {
  const expected = input.retryCount + (terminal ? 1 : 0);
  if (failureCount !== expected) {
    throw new ExtractionAttemptLimitError(
      "extraction outcome failure count does not match its retry reservations"
    );
  }
}

function terminalOutcome(input: ExtractionTransportOutcome): boolean {
  return input.terminalRetryClassification !== undefined;
}

function assertOutcome(input: ExtractionTransportOutcome): void {
  if (!isNonNegativeSafeInteger(input.retryCount) ||
      !isNonNegativeSafeInteger(input.rateLimitRetries) ||
      (input.transportFailures !== undefined && !Array.isArray(input.transportFailures)) ||
      (input.usage !== undefined && (!isNonNegativeSafeInteger(input.usage.inputTokens) ||
        !isNonNegativeSafeInteger(input.usage.outputTokens) ||
        !isNonNegativeSafeInteger(input.usage.totalTokens)))) {
    throw new Error("extraction transport outcome telemetry is invalid");
  }
}

const FAILURE_KINDS = new Set<BenchTransportFailureKind>([
  "network_error", "http_error", "body_read_error", "response_parse_error",
  "response_schema_error", "empty_response", "timeout", "aborted"
]);
const FAILURE_PHASES = new Set<BenchTransportFailurePhase>([
  "request", "response_status", "response_body", "response_parse", "response_schema"
]);

function assertFailureAttempt(
  failure: BenchTransportFailureAttempt,
  expectedAttempt: number
): void {
  if (failure.attempt !== expectedAttempt || !FAILURE_KINDS.has(failure.kind) ||
      !FAILURE_PHASES.has(failure.phase) || !isHttpStatus(failure.httpStatus) ||
      !isDigest(failure.fingerprint)) {
    throw new ExtractionAttemptLimitError(
      "extraction transport failures must be ordered, redacted, and one-based"
    );
  }
}

function isHttpStatus(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 100 && value <= 599);
}

function sortedKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)].sort();
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertCacheKey(value: string): void {
  if (!isDigest(value)) {
    throw new Error("extraction cache key must be a lowercase SHA-256 hex string");
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
