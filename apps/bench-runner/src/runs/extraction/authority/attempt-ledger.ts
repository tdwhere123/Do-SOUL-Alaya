import { AlayaError } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  completeBenchTerminalRetryClassifications,
  type BenchTerminalRetryClassification
} from "../../compile-seed/compile-seed-types.js";
import {
  assertExtractionAttemptLedgerCacheIdentity, assertLedgerSuccessfulShard,
  readValidDeterministicLedgerShard, readValidLedgerShard,
  type ExtractionAttemptLedgerCacheIdentity,
  type ExtractionSuccessfulShard
} from "./attempt-ledger-shards.js";
import { computeExtractionFillAttemptCeiling } from "./receipt-limits.js";
import {
  EXTRACTION_ATTEMPT_LEDGER_VERSION,
  assertStoredAttemptLedgerRecord,
  emptyAttemptTelemetry,
  hasCompleteAttemptHistory,
  persistAttemptLedgerRecordExclusive,
  persistAttemptLedgerRecord,
  projectAttemptLedgerV5Terminal,
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
import {
  commitDeterministicShard,
  commitProviderBackedShard,
  sortedSuccessfulShards
} from "./attempt-ledger/success.js";
import { boundedArtifactEntryExists } from "../cache-audit/bounded-artifact-reader.js";

export { ExtractionAttemptLimitError } from "./attempt-ledger/outcome.js";
export const computeExtractionAttemptCeiling = computeExtractionFillAttemptCeiling;
/** Read-only inventory; a new execution must not hide older reservation history. */
export function listExtractionAttemptLedgerRecords(cacheRoot: string): readonly ExtractionAttemptLedgerRecord[] {
  if (!boundedArtifactEntryExists(cacheRoot)) return [];
  return readdirSync(cacheRoot).filter(name => /^extraction-attempt-ledger\.[0-9a-f]{64}\.json$/u.test(name))
    .map(name => readAttemptLedgerRecord(join(cacheRoot, name)));
}
export interface ExtractionAttemptLedgerSnapshot {
  readonly rawLedgerSha256: string;
  readonly ledgerSha256: string;
  readonly lineageDigest: string;
  readonly startingMissing: number;
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
  readonly attempts: number;
  readonly historyComplete: boolean;
  readonly successfulShards: number;
  readonly successfulEntries: readonly Readonly<ExtractionSuccessfulShard>[];
  readonly successfulKeys: readonly string[];
  readonly pendingKeys: readonly string[];
  readonly unresolvedAttempts: readonly Readonly<{
    readonly attemptOrdinal: number;
    readonly cacheKey: string;
  }>[];
  readonly settledAttempts: readonly Readonly<{
    attemptOrdinal: number; cacheKey: string; usageSha256?: string; responseSha256?: string;
    aggregateUsageSha256?: string
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
  if (!boundedArtifactEntryExists(path)) return undefined;
  const envelope = readAttemptLedgerRecordEnvelope(path);
  let current = envelope.record;
  assertLedgerIdentity(current, input.lineageDigest, input.cacheIdentity);
  current = reconcilePending(input.cacheRoot, current, path, false);
  assertSuccessfulShards(input.cacheRoot, current);
  return toSnapshot(current, path, envelope.rawSha256);
}

/** Durable state only: unlike recovery reads, this never infers settlement from a shard. */
export function inspectExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
}): ExtractionAttemptLedgerSnapshot | undefined {
  assertExtractionAttemptLedgerCacheIdentity(input.cacheIdentity);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  if (!boundedArtifactEntryExists(path)) return undefined;
  const envelope = readAttemptLedgerRecordEnvelope(path);
  assertLedgerIdentity(envelope.record, input.lineageDigest, input.cacheIdentity);
  return toSnapshot(envelope.record, path, envelope.rawSha256);
}

export function assertExtractionAttemptReservation(
  snapshot: ExtractionAttemptLedgerSnapshot | undefined, cacheKey: string, attemptOrdinal: number
): void {
  const reserved = snapshot === undefined ? undefined : [
    ...snapshot.unresolvedAttempts, ...snapshot.settledAttempts, ...snapshot.transportFailures
  ].find(attempt => attempt.attemptOrdinal === attemptOrdinal);
  if (reserved === undefined || reserved.cacheKey !== cacheKey) {
    throw new ExtractionAttemptLimitError("provider raw lacks its exact reserved attempt");
  }
}

export function readSettledExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
}): ExtractionAttemptLedgerSnapshot {
  assertExtractionAttemptLedgerCacheIdentity(input.cacheIdentity);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  if (!boundedArtifactEntryExists(path)) {
    throw new Error("predecessor extraction attempt ledger is missing");
  }
  const envelope = readAttemptLedgerRecordEnvelope(path);
  const current = envelope.record;
  assertLedgerIdentity(current, input.lineageDigest, input.cacheIdentity);
  if (current.pending_keys.length > 0 || current.unresolved_attempts.length > 0) {
    throw new Error("predecessor extraction attempt ledger is not durably settled");
  }
  if (!hasCompleteAttemptHistory(current)) {
    throw new Error("predecessor extraction attempt history is incomplete");
  }
  assertSuccessfulShards(input.cacheRoot, current);
  return toSnapshot(current, path, envelope.rawSha256);
}

export function forkSettledExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly predecessorLineageDigest: string;
  readonly predecessorLedgerSha256: string;
  readonly successorLineageDigest: string;
  readonly successorMaximumAttempts?: number;
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
      !hasCompleteAttemptHistory(predecessor) ||
      ledgerDigest(predecessor) !== input.predecessorLedgerSha256) {
    throw new Error("predecessor extraction attempt ledger changed before continuation fork");
  }
  assertSuccessfulShards(input.cacheRoot, predecessor);
  const successor = successorForkRecord(
    predecessor, input.successorLineageDigest, input.successorMaximumAttempts
  );
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
  readonly successorMaximumAttempts?: number;
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
      !hasCompleteAttemptHistory(predecessor) ||
      ledgerDigest(predecessor) !== input.predecessorLedgerSha256 ||
      predecessorEnvelope.rawSha256 !== input.predecessorRawLedgerSha256) {
    throw new Error("predecessor extraction attempt ledger changed before continuation fork");
  }
  assertSuccessfulShards(input.cacheRoot, predecessor);
  const successor = successorForkRecord(
    predecessor, input.successorLineageDigest, input.successorMaximumAttempts
  );
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

function successorForkRecord(
  predecessor: ExtractionAttemptLedgerRecord,
  successorLineageDigest: string,
  successorMaximumAttempts: number | undefined
): ExtractionAttemptLedgerRecord {
  const maximumAttempts = successorMaximumAttempts ?? predecessor.maximum_attempts;
  const derivedMaximum = computeExtractionAttemptCeiling(predecessor.starting_missing);
  if (!Number.isSafeInteger(maximumAttempts) ||
      maximumAttempts < predecessor.maximum_attempts ||
      maximumAttempts > derivedMaximum) {
    throw new Error("successor extraction attempt ceiling is not a monotonic bounded expansion");
  }
  return {
    ...predecessor,
    lineage_digest: successorLineageDigest,
    maximum_attempts: maximumAttempts
  };
}

export function discardPristineForkedExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly ledgerSha256: string;
}): void {
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  if (!boundedArtifactEntryExists(path)) return;
  const record = readAttemptLedgerRecord(path);
  if (record.lineage_digest !== input.lineageDigest ||
      ledgerDigest(record) !== input.ledgerSha256) return;
  unlinkSync(path);
}

export type ExtractionAttemptShardInspector = (
  cacheRoot: string,
  cacheKey: string,
  identity: ExtractionAttemptLedgerCacheIdentity
) => ExtractionSuccessfulShard | undefined;

export function openExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly publicationTemporaryDirectory?: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
  readonly startingMissing: number;
  readonly maximumAttempts?: number; readonly successfulShardCeiling?: number;
  readonly maximumAttemptsPerKey?: number;
  readonly inspectProviderShard?: ExtractionAttemptShardInspector;
}): {
  readonly reserveAttempt: (cacheKey: string) => void;
  readonly reserveAttemptOrdinal: (cacheKey: string) => number;
  readonly abandonPendingShard: (cacheKey: string, attemptOrdinal?: number) => void;
  readonly commitSuccessfulShard: (cacheKey: string) => void;
  readonly commitDeterministicShard: (cacheKey: string) => void;
  readonly recordTransportOutcome: (cacheKey: string, input: ExtractionTransportOutcome, attemptOrdinal?: number) => boolean;
  readonly snapshot: () => ExtractionAttemptLedgerSnapshot;
} {
  const expected = createExpectedRecord(input);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  const existed = boundedArtifactEntryExists(path);
  let current = existed ? readAttemptLedgerRecord(path) : expected;
  assertBoundRecord(current, expected);
  const inspectShard = input.inspectProviderShard ?? readValidLedgerShard;
  const inspectCommitShard = input.inspectProviderShard ?? ((cacheRoot: string, cacheKey: string,
    identity: ExtractionAttemptLedgerCacheIdentity) => readValidLedgerShard(cacheRoot, cacheKey, identity, true));
  current = reconcilePending(
    input.cacheRoot, current, path, true, input.publicationTemporaryDirectory, inspectShard
  );
  assertSuccessfulShards(input.cacheRoot, current, inspectShard);
  if (!existed) {
    persistAttemptLedgerRecord(path, current, input.publicationTemporaryDirectory);
  }
  const update = (next: ExtractionAttemptLedgerRecord): void => {
    current = next;
    persistAttemptLedgerRecord(path, current, input.publicationTemporaryDirectory);
  };
  const reserveAttemptOrdinal = (cacheKey: string): number => {
    update(reserveTransportAttempt(current, cacheKey, input.maximumAttemptsPerKey));
    return current.attempts;
  };
  return {
    reserveAttempt: (cacheKey) => {
      reserveAttemptOrdinal(cacheKey);
    },
    reserveAttemptOrdinal,
    abandonPendingShard: (cacheKey, attemptOrdinal) => update(abandonPendingShard(current, cacheKey, attemptOrdinal)),
    commitSuccessfulShard: (cacheKey) => {
      const shard = requireValidShard(input.cacheRoot, cacheKey, current.cache_identity, inspectCommitShard);
      if (!shardAttemptBelongsToLedger(shard, current)) {
        throw new ExtractionAttemptLimitError("extraction success differs from its settled provider attempt");
      }
      update(commitProviderBackedShard(current, shard));
    },
    commitDeterministicShard: (cacheKey) => {
      const shard = readValidDeterministicLedgerShard(
        input.cacheRoot, cacheKey, current.cache_identity
      );
      if (shard === undefined) {
        throw new ExtractionAttemptLimitError(
          "deterministic extraction shard is not the canonical empty envelope"
        );
      }
      update(commitDeterministicShard(current, shard));
    },
    recordTransportOutcome: (cacheKey, outcome, attemptOrdinal) => {
      const next = settleTransportOutcome(current, cacheKey, outcome, attemptOrdinal);
      if (next === current) return false;
      update(next);
      return true;
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

function reconcilePending(
  cacheRoot: string,
  current: ExtractionAttemptLedgerRecord,
  path: string,
  persist = true,
  publicationTemporaryDirectory?: string,
  inspectShard: ExtractionAttemptShardInspector = readValidLedgerShard
): ExtractionAttemptLedgerRecord {
  if (!hasCompleteAttemptHistory(current)) return current;
  const recovered = current.pending_keys.flatMap((cacheKey) => {
    const shard = inspectShard(cacheRoot, cacheKey, current.cache_identity);
    return shard === undefined || !shardAttemptBelongsToLedger(shard, current) ? [] : [shard];
  });
  if (recovered.length === 0) return current;
  const recoveredKeys = new Set(recovered.map((shard) => shard.cacheKey));
  const next = {
    ...current,
    successful_shards: sortedSuccessfulShards([...current.successful_shards, ...recovered]),
    pending_keys: current.pending_keys.filter((key) => !recoveredKeys.has(key))
  };
  if (persist) persistAttemptLedgerRecord(path, next, publicationTemporaryDirectory);
  return next;
}

function requireValidShard(
  cacheRoot: string,
  cacheKey: string,
  identity: ExtractionAttemptLedgerCacheIdentity,
  inspectShard: ExtractionAttemptShardInspector
): ExtractionSuccessfulShard {
  const shard = inspectShard(cacheRoot, cacheKey, identity);
  if (shard === undefined) {
    throw new ExtractionAttemptLimitError("extraction success shard failed cache identity validation");
  }
  return shard;
}

function shardAttemptBelongsToLedger(
  shard: ExtractionSuccessfulShard, record: ExtractionAttemptLedgerRecord
): boolean {
  if (shard.successKind !== "provider") return true;
  // A settled continuation carries predecessor successes with their original
  // lineage; only an already recorded, unchanged success may use that lineage.
  const inherited = record.successful_shards.some((saved) => isDeepStrictEqual(saved, shard));
  return shard.attemptOrdinal !== undefined &&
    (shard.authorityLineageDigest === record.lineage_digest || inherited) &&
    !record.unresolved_attempts.some((attempt) => attempt.cache_key === shard.cacheKey) &&
    !record.transport_failures.some((attempt) => attempt.cache_key === shard.cacheKey &&
      attempt.attempt_ordinal === shard.attemptOrdinal) &&
    (record.settled_attempts ?? []).some((attempt) =>
      attempt.cache_key === shard.cacheKey && attempt.attempt_ordinal === shard.attemptOrdinal &&
      attempt.usage_sha256 !== undefined && attempt.usage_sha256 === shard.usageSha256 &&
      (shard.responseSha256 === undefined ? attempt.response_sha256 === undefined :
        attempt.response_sha256 === shard.responseSha256) &&
      (shard.aggregateUsageSha256 === undefined ? attempt.aggregate_usage_sha256 === undefined :
        attempt.aggregate_usage_sha256 === shard.aggregateUsageSha256));
}

function assertSuccessfulShards(
  cacheRoot: string,
  record: ExtractionAttemptLedgerRecord,
  inspectShard: ExtractionAttemptShardInspector = readValidLedgerShard
): void {
  for (const shard of record.successful_shards) {
    if (!shardAttemptBelongsToLedger(shard, record)) {
      throw new AlayaError("CONFLICT", `extraction authority successful shard closure drifted: ${shard.cacheKey}`);
    }
    assertLedgerSuccessfulShard(cacheRoot, shard, record.cache_identity, inspectShard);
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

export function ledgerPath(cacheRoot: string, lineageDigest: string): string {
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
    historyComplete: hasCompleteAttemptHistory(record),
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
    settledAttempts: Object.freeze((record.settled_attempts ?? []).map(attempt => Object.freeze({
      attemptOrdinal: attempt.attempt_ordinal, cacheKey: attempt.cache_key,
      ...(attempt.usage_sha256 === undefined ? {} : { usageSha256: attempt.usage_sha256 }),
      ...(attempt.response_sha256 === undefined ? {} : { responseSha256: attempt.response_sha256 }),
      ...(attempt.aggregate_usage_sha256 === undefined ? {} : {
        aggregateUsageSha256: attempt.aggregate_usage_sha256
      })
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
      terminalRetryClassifications: Object.freeze(
        completeBenchTerminalRetryClassifications(record.telemetry.terminal)
      ),
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
    ...(record.settled_attempts === undefined ? {} : { settled_attempts: record.settled_attempts.map(attempt => ({
      attempt_ordinal: attempt.attempt_ordinal, cache_key: attempt.cache_key,
      ...(attempt.usage_sha256 === undefined ? {} : { usage_sha256: attempt.usage_sha256 }),
      ...(attempt.response_sha256 === undefined ? {} : { response_sha256: attempt.response_sha256 }),
      ...(attempt.aggregate_usage_sha256 === undefined ? {} : {
        aggregate_usage_sha256: attempt.aggregate_usage_sha256
      })
    })) }),
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
      terminal: projectAttemptLedgerV5Terminal(record.telemetry.terminal),
      input_tokens: record.telemetry.input_tokens,
      output_tokens: record.telemetry.output_tokens,
      total_tokens: record.telemetry.total_tokens,
      usage_unavailable_requests: record.telemetry.usage_unavailable_requests
    }
  };
}

function rawLedgerDigest(path: string): string {
  return readAttemptLedgerRecordEnvelope(path).rawSha256;
}

function isAlreadyExistsError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
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
