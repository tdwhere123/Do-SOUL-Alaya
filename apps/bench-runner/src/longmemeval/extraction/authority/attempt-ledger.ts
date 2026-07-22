import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BenchTerminalRetryClassification } from "../../compile-seed/compile-seed-types.js";
import {
  assertExtractionAttemptLedgerCacheIdentity, assertLedgerSuccessfulShard, readValidLedgerShard,
  type ExtractionAttemptLedgerCacheIdentity,
  type ExtractionSuccessfulShard
} from "./attempt-ledger-shards.js";
import { computeExtractionFillAttemptCeiling } from "./receipt-limits.js";
import {
  EXTRACTION_ATTEMPT_LEDGER_VERSION,
  assertStoredAttemptLedgerRecord,
  emptyAttemptTelemetry,
  persistAttemptLedgerRecordExclusive,
  persistAttemptLedgerRecord,
  readAttemptLedgerRecord,
  readAttemptLedgerRecordEnvelope,
  type ExtractionAttemptLedgerRecord
} from "./attempt-ledger/contract.js";
import {
  ExtractionAttemptLimitError,
  abandonPendingShard,
  reserveTransportAttempt,
  settleTransportOutcome,
  type ExtractionTransportOutcome
} from "./attempt-ledger/outcome.js";

export { ExtractionAttemptLimitError } from "./attempt-ledger/outcome.js";
export const computeExtractionAttemptCeiling = computeExtractionFillAttemptCeiling;
export interface ExtractionAttemptLedgerSnapshot {
  readonly rawLedgerSha256: string;
  readonly ledgerSha256: string;
  readonly lineageDigest: string;
  readonly startingMissing: number;
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
  readonly attempts: number;
  readonly successfulShards: number;
  readonly successfulEntries: readonly Readonly<ExtractionSuccessfulShard>[];
  readonly successfulKeys: readonly string[];
  readonly pendingKeys: readonly string[];
  readonly unresolvedAttempts: readonly Readonly<{
    readonly attemptOrdinal: number;
    readonly cacheKey: string;
  }>[];
  readonly transportFailures: readonly Readonly<{
    readonly attemptOrdinal: number;
    readonly cacheKey: string;
    readonly kind: import("../../compile-seed/compile-seed-types.js").BenchTransportFailureKind;
    readonly phase: import("../../compile-seed/compile-seed-types.js").BenchTransportFailurePhase;
    readonly httpStatus: number | null;
    readonly fingerprint: string;
  }>[];
  readonly telemetry: Readonly<{
    readonly retrySuccesses: number;
    readonly rateLimitRetries: number;
    readonly terminalRetryClassifications: Readonly<Record<BenchTerminalRetryClassification, number>>;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly usageUnavailableRequests: number;
    readonly unresolvedTransportAttempts: number;
    readonly usageUnknownAttempts: number;
  }>;
}

export function readExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
}): ExtractionAttemptLedgerSnapshot | undefined {
  assertExtractionAttemptLedgerCacheIdentity(input.cacheIdentity);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  if (!existsSync(path)) return undefined;
  const envelope = readAttemptLedgerRecordEnvelope(path);
  let current = envelope.record;
  assertLedgerIdentity(current, input.lineageDigest, input.cacheIdentity);
  current = reconcilePending(input.cacheRoot, current, path, false);
  assertSuccessfulShards(input.cacheRoot, current);
  return toSnapshot(current, path, envelope.rawSha256);
}

export function readSettledExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
}): ExtractionAttemptLedgerSnapshot {
  assertExtractionAttemptLedgerCacheIdentity(input.cacheIdentity);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  if (!existsSync(path)) throw new Error("predecessor extraction attempt ledger is missing");
  const envelope = readAttemptLedgerRecordEnvelope(path);
  const current = envelope.record;
  assertLedgerIdentity(current, input.lineageDigest, input.cacheIdentity);
  if (current.pending_keys.length > 0 || current.unresolved_attempts.length > 0) {
    throw new Error("predecessor extraction attempt ledger is not durably settled");
  }
  assertSuccessfulShards(input.cacheRoot, current);
  return toSnapshot(current, path, envelope.rawSha256);
}

export function forkSettledExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly predecessorLineageDigest: string;
  readonly predecessorLedgerSha256: string;
  readonly successorLineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
}): ExtractionAttemptLedgerSnapshot {
  assertDigest(input.successorLineageDigest);
  if (input.predecessorLineageDigest === input.successorLineageDigest) {
    throw new Error("extraction continuation requires a new ledger lineage");
  }
  const predecessorPath = ledgerPath(input.cacheRoot, input.predecessorLineageDigest);
  const predecessor = readAttemptLedgerRecordEnvelope(predecessorPath).record;
  assertLedgerIdentity(predecessor, input.predecessorLineageDigest, input.cacheIdentity);
  if (predecessor.pending_keys.length > 0 || predecessor.unresolved_attempts.length > 0 ||
      ledgerDigest(predecessor) !== input.predecessorLedgerSha256) {
    throw new Error("predecessor extraction attempt ledger changed before continuation fork");
  }
  assertSuccessfulShards(input.cacheRoot, predecessor);
  const successor = { ...predecessor, lineage_digest: input.successorLineageDigest };
  persistAttemptLedgerRecordExclusive(
    ledgerPath(input.cacheRoot, input.successorLineageDigest), successor
  );
  return toSnapshot(successor, ledgerPath(input.cacheRoot, input.successorLineageDigest));
}

export function ensureForkedExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly predecessorLineageDigest: string;
  readonly predecessorLedgerSha256: string;
  readonly predecessorRawLedgerSha256: string;
  readonly successorLineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
}): ExtractionAttemptLedgerSnapshot {
  assertDigest(input.successorLineageDigest);
  if (input.predecessorLineageDigest === input.successorLineageDigest) {
    throw new Error("extraction continuation requires a new ledger lineage");
  }
  const predecessorPath = ledgerPath(input.cacheRoot, input.predecessorLineageDigest);
  const predecessorEnvelope = readAttemptLedgerRecordEnvelope(predecessorPath);
  const predecessor = predecessorEnvelope.record;
  assertLedgerIdentity(predecessor, input.predecessorLineageDigest, input.cacheIdentity);
  if (predecessor.pending_keys.length > 0 || predecessor.unresolved_attempts.length > 0 ||
      ledgerDigest(predecessor) !== input.predecessorLedgerSha256 ||
      predecessorEnvelope.rawSha256 !== input.predecessorRawLedgerSha256) {
    throw new Error("predecessor extraction attempt ledger changed before continuation fork");
  }
  assertSuccessfulShards(input.cacheRoot, predecessor);
  const successor = { ...predecessor, lineage_digest: input.successorLineageDigest };
  const successorPath = ledgerPath(input.cacheRoot, input.successorLineageDigest);
  try {
    persistAttemptLedgerRecordExclusive(successorPath, successor);
  } catch (cause) {
    if (!isAlreadyExistsError(cause)) throw cause;
    const existing = readAttemptLedgerRecordEnvelope(successorPath).record;
    if (ledgerDigest(existing) !== ledgerDigest(successor)) {
      throw new Error("existing successor ledger is not a pristine continuation fork");
    }
  }
  assertSuccessfulShards(input.cacheRoot, successor);
  return toSnapshot(successor, successorPath);
}

export function discardPristineForkedExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly ledgerSha256: string;
}): void {
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  if (!existsSync(path)) return;
  const record = readAttemptLedgerRecord(path);
  if (record.lineage_digest !== input.lineageDigest ||
      ledgerDigest(record) !== input.ledgerSha256) return;
  unlinkSync(path);
}

export function openExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
  readonly startingMissing: number;
  readonly maximumAttempts?: number;
  readonly successfulShardCeiling?: number;
}): {
  readonly reserveAttempt: (cacheKey: string) => void;
  readonly abandonPendingShard: (cacheKey: string) => void;
  readonly commitSuccessfulShard: (cacheKey: string) => void;
  readonly recordTransportOutcome: (
    cacheKey: string,
    input: ExtractionTransportOutcome
  ) => void;
  readonly snapshot: () => ExtractionAttemptLedgerSnapshot;
} {
  const expected = createExpectedRecord(input);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  const existed = existsSync(path);
  let current = existed ? readAttemptLedgerRecord(path) : expected;
  assertBoundRecord(current, expected);
  current = reconcilePending(input.cacheRoot, current, path);
  assertSuccessfulShards(input.cacheRoot, current);
  if (!existed) persistAttemptLedgerRecord(path, current);
  return {
    reserveAttempt: (cacheKey) => {
      current = reserveTransportAttempt(current, cacheKey);
      persistAttemptLedgerRecord(path, current);
    },
    abandonPendingShard: (cacheKey) => {
      current = abandonPendingShard(current, cacheKey);
      persistAttemptLedgerRecord(path, current);
    },
    commitSuccessfulShard: (cacheKey) => {
      const shard = requireValidShard(input.cacheRoot, cacheKey, current.cache_identity);
      current = commitSuccessfulShard(current, shard);
      persistAttemptLedgerRecord(path, current);
    },
    recordTransportOutcome: (cacheKey, outcome) => {
      current = settleTransportOutcome(current, cacheKey, outcome);
      persistAttemptLedgerRecord(path, current);
    },
    snapshot: () => toSnapshot(current, path)
  };
}

function createExpectedRecord(input: {
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
  readonly startingMissing: number;
  readonly maximumAttempts?: number;
  readonly successfulShardCeiling?: number;
}): ExtractionAttemptLedgerRecord {
  assertDigest(input.lineageDigest);
  assertExtractionAttemptLedgerCacheIdentity(input.cacheIdentity);
  const derivedAttempts = computeExtractionAttemptCeiling(input.startingMissing);
  const maximumAttempts = input.maximumAttempts ?? derivedAttempts;
  const successfulShardCeiling = input.successfulShardCeiling ?? input.startingMissing;
  if (!isNonNegativeSafeInteger(maximumAttempts) || maximumAttempts < 1 ||
      !isNonNegativeSafeInteger(successfulShardCeiling) ||
      maximumAttempts > derivedAttempts || successfulShardCeiling > input.startingMissing) {
    throw new Error("extraction attempt ledger authority limits cannot widen or reset");
  }
  return {
    schema_version: EXTRACTION_ATTEMPT_LEDGER_VERSION,
    lineage_digest: input.lineageDigest,
    cache_identity: { ...input.cacheIdentity },
    starting_missing: input.startingMissing,
    maximum_attempts: maximumAttempts,
    successful_shard_ceiling: successfulShardCeiling,
    attempts: 0,
    successful_shards: [],
    pending_keys: [],
    unresolved_attempts: [],
    transport_failures: [],
    telemetry: emptyAttemptTelemetry()
  };
}

function commitSuccessfulShard(
  current: ExtractionAttemptLedgerRecord,
  shard: ExtractionSuccessfulShard
): ExtractionAttemptLedgerRecord {
  if (current.successful_shards.some((entry) => entry.cacheKey === shard.cacheKey)) return current;
  if (!current.pending_keys.includes(shard.cacheKey)) {
    throw new ExtractionAttemptLimitError("extraction success was not reserved before transport");
  }
  if (current.unresolved_attempts.some((attempt) => attempt.cache_key === shard.cacheKey)) {
    throw new ExtractionAttemptLimitError("extraction success must settle its provider attempt first");
  }
  return {
    ...current,
    successful_shards: sortedShards([...current.successful_shards, shard]),
    pending_keys: current.pending_keys.filter((key) => key !== shard.cacheKey)
  };
}

function reconcilePending(
  cacheRoot: string,
  current: ExtractionAttemptLedgerRecord,
  path: string,
  persist = true
): ExtractionAttemptLedgerRecord {
  const recovered = current.pending_keys.flatMap((cacheKey) => {
    const shard = readValidLedgerShard(cacheRoot, cacheKey, current.cache_identity);
    return shard === undefined ? [] : [shard];
  });
  if (recovered.length === 0) return current;
  const recoveredKeys = new Set(recovered.map((shard) => shard.cacheKey));
  const next = {
    ...current,
    successful_shards: sortedShards([...current.successful_shards, ...recovered]),
    pending_keys: current.pending_keys.filter((key) => !recoveredKeys.has(key))
  };
  if (persist) persistAttemptLedgerRecord(path, next);
  return next;
}

function requireValidShard(
  cacheRoot: string,
  cacheKey: string,
  identity: ExtractionAttemptLedgerCacheIdentity
): ExtractionSuccessfulShard {
  const shard = readValidLedgerShard(cacheRoot, cacheKey, identity);
  if (shard === undefined) {
    throw new ExtractionAttemptLimitError("extraction success shard failed cache identity validation");
  }
  return shard;
}

function assertSuccessfulShards(cacheRoot: string, record: ExtractionAttemptLedgerRecord): void {
  for (const shard of record.successful_shards) {
    assertLedgerSuccessfulShard(cacheRoot, shard, record.cache_identity);
  }
}

function assertLedgerIdentity(
  record: ExtractionAttemptLedgerRecord,
  lineageDigest: string,
  cacheIdentity: ExtractionAttemptLedgerCacheIdentity
): void {
  assertStoredAttemptLedgerRecord(record);
  if (record.lineage_digest !== lineageDigest || !sameCacheIdentity(record.cache_identity, cacheIdentity)) {
    throw new Error("extraction attempt ledger belongs to a different lineage or cache identity");
  }
}

function assertBoundRecord(
  record: ExtractionAttemptLedgerRecord,
  expected: ExtractionAttemptLedgerRecord
): void {
  assertStoredAttemptLedgerRecord(record);
  if (record.lineage_digest !== expected.lineage_digest ||
      !sameCacheIdentity(record.cache_identity, expected.cache_identity) ||
      record.starting_missing !== expected.starting_missing ||
      record.maximum_attempts !== expected.maximum_attempts ||
      record.successful_shard_ceiling !== expected.successful_shard_ceiling) {
    throw new Error("extraction attempt ledger is bound to a different lineage or ceiling; cannot reset it");
  }
}

function ledgerPath(cacheRoot: string, lineageDigest: string): string {
  assertDigest(lineageDigest);
  return join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
}

function toSnapshot(
  record: ExtractionAttemptLedgerRecord,
  path: string,
  rawSha256: string = rawLedgerDigest(path)
): ExtractionAttemptLedgerSnapshot {
  const unresolved = record.unresolved_attempts.length;
  return Object.freeze({
    rawLedgerSha256: rawSha256,
    ledgerSha256: ledgerDigest(record),
    lineageDigest: record.lineage_digest,
    startingMissing: record.starting_missing,
    maximumAttempts: record.maximum_attempts,
    successfulShardCeiling: record.successful_shard_ceiling,
    attempts: record.attempts,
    successfulShards: record.successful_shards.length,
    successfulEntries: Object.freeze(record.successful_shards.map((shard) =>
      Object.freeze({ ...shard })
    )),
    successfulKeys: Object.freeze(record.successful_shards.map((shard) => shard.cacheKey)),
    pendingKeys: Object.freeze([...record.pending_keys]),
    unresolvedAttempts: Object.freeze(record.unresolved_attempts.map((attempt) => Object.freeze({
      attemptOrdinal: attempt.attempt_ordinal,
      cacheKey: attempt.cache_key
    }))),
    transportFailures: Object.freeze(record.transport_failures.map((failure) => Object.freeze({
      attemptOrdinal: failure.attempt_ordinal,
      cacheKey: failure.cache_key,
      kind: failure.kind,
      phase: failure.phase,
      httpStatus: failure.http_status,
      fingerprint: failure.fingerprint
    }))),
    telemetry: Object.freeze({
      retrySuccesses: record.telemetry.retry_successes,
      rateLimitRetries: record.telemetry.rate_limit_retries,
      terminalRetryClassifications: Object.freeze({ ...record.telemetry.terminal }),
      inputTokens: record.telemetry.input_tokens,
      outputTokens: record.telemetry.output_tokens,
      totalTokens: record.telemetry.total_tokens,
      usageUnavailableRequests: record.telemetry.usage_unavailable_requests,
      unresolvedTransportAttempts: unresolved,
      usageUnknownAttempts: record.telemetry.usage_unavailable_requests + unresolved
    })
  });
}

function ledgerDigest(record: ExtractionAttemptLedgerRecord): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalLedgerRecord(record)), "utf8")
    .digest("hex");
}

function canonicalLedgerRecord(record: ExtractionAttemptLedgerRecord) {
  return {
    schema_version: record.schema_version,
    lineage_digest: record.lineage_digest,
    cache_identity: {
      model: record.cache_identity.model,
      requestProfile: record.cache_identity.requestProfile
    },
    starting_missing: record.starting_missing,
    maximum_attempts: record.maximum_attempts,
    successful_shard_ceiling: record.successful_shard_ceiling,
    attempts: record.attempts,
    successful_shards: record.successful_shards.map((shard) => ({
      cacheKey: shard.cacheKey,
      rawJsonSha256: shard.rawJsonSha256
    })),
    pending_keys: [...record.pending_keys],
    unresolved_attempts: record.unresolved_attempts.map((attempt) => ({
      attempt_ordinal: attempt.attempt_ordinal,
      cache_key: attempt.cache_key
    })),
    transport_failures: record.transport_failures.map((failure) => ({
      attempt_ordinal: failure.attempt_ordinal,
      cache_key: failure.cache_key,
      kind: failure.kind,
      phase: failure.phase,
      http_status: failure.http_status,
      fingerprint: failure.fingerprint
    })),
    telemetry: {
      retry_successes: record.telemetry.retry_successes,
      rate_limit_retries: record.telemetry.rate_limit_retries,
      terminal: {
        failure_max_retries: record.telemetry.terminal.failure_max_retries,
        failure_non_retryable_4xx:
          record.telemetry.terminal.failure_non_retryable_4xx,
        failure_timeout: record.telemetry.terminal.failure_timeout,
        failure_aborted: record.telemetry.terminal.failure_aborted
      },
      input_tokens: record.telemetry.input_tokens,
      output_tokens: record.telemetry.output_tokens,
      total_tokens: record.telemetry.total_tokens,
      usage_unavailable_requests: record.telemetry.usage_unavailable_requests
    }
  };
}

function rawLedgerDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isAlreadyExistsError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}

function sortedShards(shards: readonly ExtractionSuccessfulShard[]): readonly ExtractionSuccessfulShard[] {
  return [...new Map(shards.map((shard) => [shard.cacheKey, shard])).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
}

function sameCacheIdentity(
  left: ExtractionAttemptLedgerCacheIdentity,
  right: ExtractionAttemptLedgerCacheIdentity
): boolean {
  return left.model === right.model && left.requestProfile === right.requestProfile;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertDigest(value: string | undefined): asserts value is string {
  if (!isDigest(value)) {
    throw new Error("extraction authority lineage digest must be a lowercase SHA-256 hex string");
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
