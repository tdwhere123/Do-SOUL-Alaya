import { createHash } from "node:crypto";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { baseReportedUsage } from "../step-quote.js";
import {
  BENCH_TRANSPORT_FAILURE_KINDS, BENCH_TRANSPORT_FAILURE_PHASES,
  type BenchProviderUsage,
  type BenchTransportResponseWitness,
  type BenchTerminalRetryClassification,
  type BenchTransportFailureAttempt,
  type BenchTransportFailureKind,
  type BenchTransportFailurePhase
} from "../../../compile-seed/compile-seed-types.js";
import type {
  ExtractionAttemptLedgerRecord,
  ExtractionAttemptReservationRecord,
  ExtractionTransportFailureRecord
} from "./contract.js";
import { hasCompleteAttemptHistory } from "./contract.js";

export interface ExtractionTransportOutcome {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly successfulRequestCount?: number;
  readonly usageRequestCount?: number;
  readonly unknownRequestCount?: number;
  readonly postComposeFailure?: true;
  readonly terminalRetryClassification?: BenchTerminalRetryClassification;
  readonly transportFailures?: readonly BenchTransportFailureAttempt[];
  readonly usage?: BenchProviderUsage;
  /** Undefined is an unresolved historical outcome; null is an observed unavailable usage. */
  readonly attemptUsages?: readonly (BenchProviderUsage | null | undefined)[];
  readonly attemptResponses?: readonly (BenchTransportResponseWitness | null)[];
}

export class ExtractionAttemptLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionAttemptLimitError";
  }
}

export function reserveTransportAttempt(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string,
  maximumAttemptsPerKey?: number
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  if (!hasCompleteAttemptHistory(current)) {
    throw new ExtractionAttemptLimitError("extraction attempt history is incomplete; reservation is unavailable");
  }
  if (maximumAttemptsPerKey !== undefined) {
    if (!Number.isSafeInteger(maximumAttemptsPerKey) || maximumAttemptsPerKey < 1) {
      throw new ExtractionAttemptLimitError("invalid extraction per-key attempt ceiling");
    }
    const prior = new Set([
      ...current.unresolved_attempts, ...(current.settled_attempts ?? []), ...current.transport_failures
    ].filter(attempt => attempt.cache_key === cacheKey).map(attempt => attempt.attempt_ordinal));
    if (prior.size >= maximumAttemptsPerKey) {
      throw new ExtractionAttemptLimitError("extraction per-key attempt ceiling exhausted");
    }
  }
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
  cacheKey: string,
  attemptOrdinal?: number
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  if (attemptOrdinal !== undefined && current.unresolved_attempts.some((attempt) =>
    attempt.cache_key === cacheKey && attempt.attempt_ordinal !== attemptOrdinal)) return current;
  if (!current.pending_keys.includes(cacheKey)) return current;
  return { ...current, pending_keys: current.pending_keys.filter((key) => key !== cacheKey) };
}

export function settleTransportOutcome(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string,
  input: ExtractionTransportOutcome,
  attemptOrdinal?: number
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  assertOutcome(input);
  if (attemptOrdinal !== undefined) {
    if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1 || attemptOrdinal > current.attempts) {
      throw new ExtractionAttemptLimitError("transport outcome has an invalid attempt ordinal");
    }
    const reserved = current.unresolved_attempts.find((item) => item.attempt_ordinal === attemptOrdinal);
    if (reserved === undefined) return current;
    if (reserved.cache_key !== cacheKey) throw new ExtractionAttemptLimitError("transport attempt key mismatch");
  }
  const unresolved = current.unresolved_attempts.filter(
    (reservation) => reservation.cache_key === cacheKey &&
      (attemptOrdinal === undefined || reservation.attempt_ordinal === attemptOrdinal)
  );
  const failures = input.transportFailures ?? [];
  const terminal = input.terminalRetryClassification !== undefined;
  assertFailureCount(input, failures.length, terminal);
  const successfulRequestCount = input.successfulRequestCount ?? (terminal ? 0 : 1);
  const unknownRequestCount = input.unknownRequestCount ?? 0;
  const currentReservationCount = failures.length + successfulRequestCount + unknownRequestCount;
  if (currentReservationCount === 0 || unresolved.length < currentReservationCount) {
    throw new ExtractionAttemptLimitError(
      "extraction outcome failure count does not match its latest reservations"
    );
  }
  const currentReservations = unresolved.slice(-currentReservationCount);
  const mappedFailures = mapTransportFailures(currentReservations, failures);
  const settled = applySettledOutcome(current, input, currentReservations, mappedFailures,
    attemptOrdinal !== undefined);
  // A bound terminal attempt releases its shard slot in this same durable
  // transition. A newer outstanding attempt retains ownership of that slot.
  return attemptOrdinal !== undefined && terminal
    ? abandonPendingShard(settled, cacheKey, attemptOrdinal)
    : settled;
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
  let previousAttempt = 0;
  return failures.map((failure) => {
    assertFailureAttempt(failure, previousAttempt, reservations.length);
    previousAttempt = failure.attempt;
    const reservation = reservations[failure.attempt - 1];
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
  input: ExtractionTransportOutcome,
  unresolved: readonly ExtractionAttemptReservationRecord[],
  failures: readonly ExtractionTransportFailureRecord[],
  exactAttempt: boolean
): ExtractionAttemptLedgerRecord {
  const terminal = {
    ...current.telemetry.terminal,
    ...(input.terminalRetryClassification === undefined ? {} : {
      [input.terminalRetryClassification]:
        current.telemetry.terminal[input.terminalRetryClassification] + 1
    })
  };
  const knownUsageAttempts = input.usageRequestCount ??
    (input.usage === undefined ? 0 : 1);
  const usage = input.usage;
  return {
    ...current,
    settled_attempts: [...(current.settled_attempts ?? []), ...unresolved.map((reservation, index) => ({
      ...reservation,
      ...(input.attemptUsages !== undefined && input.attemptUsages[index] !== undefined ? {
        usage_sha256: settledAttemptUsageDigest(input.attemptUsages[index])
      } : exactAttempt && unresolved.length === 1 ? {
        usage_sha256: settledAttemptUsageDigest(input.usage)
      } : {}),
      ...(input.attemptResponses?.[index] === undefined || input.attemptResponses[index] === null ||
        input.attemptResponses[index].httpResponse?.bodyComplete !== true ? {} : {
        response_sha256: input.attemptResponses[index].httpResponse.bodySha256
      }),
      ...(input.attemptResponses?.some((response) => response !== null) &&
        index === unresolved.length - 1 ? {
          aggregate_usage_sha256: settledAttemptUsageDigest(input.usage)
        } : {})
    }))]
      .sort((left, right) => left.attempt_ordinal - right.attempt_ordinal),
    unresolved_attempts: current.unresolved_attempts.filter((reservation) =>
      !unresolved.some((settled) => settled.attempt_ordinal === reservation.attempt_ordinal)),
    transport_failures: [...current.transport_failures, ...failures]
      .sort((left, right) => left.attempt_ordinal - right.attempt_ordinal),
    telemetry: {
      retry_successes: current.telemetry.retry_successes +
        (!terminalOutcome(input) && input.postComposeFailure !== true && input.retryCount > 0
          ? 1
          : 0),
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

export function settledAttemptUsageDigest(usage: BenchProviderUsage | null | undefined): string {
  return createHash("sha256")
    .update(canonicalJson(baseReportedUsage(usage) ?? null), "utf8").digest("hex");
}

export function transportResponseDigest(witness: BenchTransportResponseWitness): string {
  if (witness.httpResponse === undefined ||
      !witness.httpResponse.bodyComplete || witness.httpResponse.bodyTruncated ||
      !isDigest(witness.httpResponse.bodySha256)) {
    throw new ExtractionAttemptLimitError("physical provider response is incomplete");
  }
  return witness.httpResponse.bodySha256;
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
  const terminal = input.terminalRetryClassification !== undefined;
  const successfulRequestCount = input.successfulRequestCount ?? (terminal ? 0 : 1);
  const usageRequestCount = input.usageRequestCount ?? (input.usage === undefined ? 0 : 1);
  const unknownRequestCount = input.unknownRequestCount ?? 0;
  const reportedUsages = input.attemptUsages?.filter((usage): usage is BenchProviderUsage =>
    usage !== null && usage !== undefined);
  const aggregateUsage = reportedUsages === undefined || reportedUsages.length === 0 ? undefined :
    reportedUsages.reduce((total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  if (!isNonNegativeSafeInteger(input.retryCount) ||
      !isNonNegativeSafeInteger(input.rateLimitRetries) ||
      !isNonNegativeSafeInteger(successfulRequestCount) ||
      !isNonNegativeSafeInteger(unknownRequestCount) ||
      (!terminal && input.postComposeFailure !== true &&
        successfulRequestCount + unknownRequestCount < 1) ||
      (terminal && input.postComposeFailure === true) ||
      !isNonNegativeSafeInteger(usageRequestCount) ||
      usageRequestCount > successfulRequestCount + input.retryCount + (terminal ? 1 : 0) ||
      (input.usage === undefined && usageRequestCount !== 0) ||
      (reportedUsages !== undefined && (usageRequestCount !== reportedUsages.length ||
        canonicalJson(baseReportedUsage(input.usage) ?? null) !==
          canonicalJson(baseReportedUsage(aggregateUsage) ?? null))) ||
      (input.transportFailures !== undefined && !Array.isArray(input.transportFailures)) ||
      (input.attemptUsages !== undefined && (!Array.isArray(input.attemptUsages) ||
        input.attemptUsages.length !== successfulRequestCount + input.retryCount +
          (terminal ? 1 : 0) + unknownRequestCount ||
        input.attemptUsages.some((usage) => usage !== null && usage !== undefined &&
          (!isNonNegativeSafeInteger(usage.inputTokens) ||
           !isNonNegativeSafeInteger(usage.outputTokens) ||
           !isNonNegativeSafeInteger(usage.totalTokens))))) ||
      (input.attemptResponses !== undefined && (!Array.isArray(input.attemptResponses) ||
        input.attemptResponses.length !== successfulRequestCount + input.retryCount +
          (terminal ? 1 : 0) + unknownRequestCount ||
        input.attemptResponses.some((witness) => witness !== null &&
          (typeof witness.userPrompt !== "string" ||
           createHash("sha256").update(witness.userPrompt, "utf8").digest("hex") !== witness.requestSha256 ||
           typeof witness.rawJson !== "string" ||
           witness.httpResponse !== undefined && !isDigest(witness.httpResponse.bodySha256))))) ||
      (input.usage !== undefined && (!isNonNegativeSafeInteger(input.usage.inputTokens) ||
        !isNonNegativeSafeInteger(input.usage.outputTokens) ||
        !isNonNegativeSafeInteger(input.usage.totalTokens)))) {
    throw new Error("extraction transport outcome telemetry is invalid");
  }
}

const FAILURE_KINDS = new Set<BenchTransportFailureKind>(BENCH_TRANSPORT_FAILURE_KINDS);
const FAILURE_PHASES = new Set<BenchTransportFailurePhase>(BENCH_TRANSPORT_FAILURE_PHASES);

function assertFailureAttempt(
  failure: BenchTransportFailureAttempt,
  previousAttempt: number,
  requestCount: number
): void {
  if (!Number.isSafeInteger(failure.attempt) || failure.attempt <= previousAttempt ||
      failure.attempt > requestCount || !FAILURE_KINDS.has(failure.kind) ||
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
