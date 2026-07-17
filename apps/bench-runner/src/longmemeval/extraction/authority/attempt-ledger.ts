import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchProviderUsage, BenchTerminalRetryClassification } from "../../compile-seed/compile-seed-types.js";
import {
  assertExtractionAttemptLedgerCacheIdentity, assertLedgerSuccessfulShard, readValidLedgerShard,
  type ExtractionAttemptLedgerCacheIdentity,
  type ExtractionSuccessfulShard
} from "./attempt-ledger-shards.js";
const LEDGER_VERSION = 3;

interface ExtractionAttemptLedgerRecord {
  readonly schema_version: typeof LEDGER_VERSION;
  readonly lineage_digest: string;
  readonly cache_identity: ExtractionAttemptLedgerCacheIdentity;
  readonly starting_missing: number;
  readonly maximum_attempts: number;
  readonly successful_shard_ceiling: number;
  readonly attempts: number;
  readonly successful_shards: readonly ExtractionSuccessfulShard[];
  readonly pending_keys: readonly string[];
  readonly unresolved_attempts: readonly string[];
  readonly telemetry: ExtractionAttemptTelemetry;
}
interface ExtractionAttemptTelemetry {
  readonly retry_successes: number;
  readonly rate_limit_retries: number;
  readonly terminal: Readonly<Record<BenchTerminalRetryClassification, number>>;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly usage_unavailable_requests: number;
}
export interface ExtractionAttemptLedgerSnapshot {
  readonly lineageDigest: string;
  readonly startingMissing: number;
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
  readonly attempts: number;
  readonly successfulShards: number;
  readonly successfulKeys: readonly string[];
  readonly pendingKeys: readonly string[];
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
export class ExtractionAttemptLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionAttemptLimitError";
  }
}

export function computeExtractionAttemptCeiling(startingMissing: number): number {
  if (!isNonNegativeSafeInteger(startingMissing)) {
    throw new Error("starting missing shard count must be a non-negative safe integer");
  }
  return Math.ceil(startingMissing * 1.1);
}

export function readExtractionAttemptLedger(input: {
  readonly cacheRoot: string;
  readonly lineageDigest: string;
  readonly cacheIdentity: ExtractionAttemptLedgerCacheIdentity;
}): ExtractionAttemptLedgerSnapshot | undefined {
  assertExtractionAttemptLedgerCacheIdentity(input.cacheIdentity);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  if (!existsSync(path)) return undefined;
  let current = readExistingRecord(path);
  assertLedgerIdentity(current, input.lineageDigest, input.cacheIdentity);
  current = reconcilePending(input.cacheRoot, current, path, false);
  assertSuccessfulShards(input.cacheRoot, current);
  return toSnapshot(current);
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
  readonly recordTransportOutcome: (cacheKey: string, input: {
    readonly retryCount: number;
    readonly rateLimitRetries: number;
    readonly terminalRetryClassification?: BenchTerminalRetryClassification;
    readonly usage?: BenchProviderUsage;
  }) => void;
  readonly snapshot: () => ExtractionAttemptLedgerSnapshot;
} {
  const expected = createExpectedRecord(input);
  const path = ledgerPath(input.cacheRoot, input.lineageDigest);
  const existed = existsSync(path);
  let current = existed ? readExistingRecord(path) : expected;
  assertBoundRecord(current, expected);
  current = reconcilePending(input.cacheRoot, current, path);
  assertSuccessfulShards(input.cacheRoot, current);
  if (!existed) persistRecord(path, current);
  return {
    reserveAttempt: (cacheKey) => {
      current = reserveTransportAttempt(current, cacheKey);
      persistRecord(path, current);
    },
    abandonPendingShard: (cacheKey) => {
      current = abandonPendingShard(current, cacheKey);
      persistRecord(path, current);
    },
    commitSuccessfulShard: (cacheKey) => {
      const shard = requireValidShard(input.cacheRoot, cacheKey, current.cache_identity);
      current = commitSuccessfulShard(current, shard);
      persistRecord(path, current);
    },
    recordTransportOutcome: (cacheKey, outcome) => {
      current = settleTransportOutcome(current, cacheKey, outcome);
      persistRecord(path, current);
    },
    snapshot: () => toSnapshot(current)
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
    schema_version: LEDGER_VERSION,
    lineage_digest: input.lineageDigest,
    cache_identity: { ...input.cacheIdentity },
    starting_missing: input.startingMissing,
    maximum_attempts: maximumAttempts,
    successful_shard_ceiling: successfulShardCeiling,
    attempts: 0,
    successful_shards: [],
    pending_keys: [],
    unresolved_attempts: [],
    telemetry: emptyTelemetry()
  };
}

function reserveTransportAttempt(
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
  return {
    ...current,
    attempts: current.attempts + 1,
    pending_keys: pending ? current.pending_keys : sortedKeys([...current.pending_keys, cacheKey]),
    unresolved_attempts: sortedAttempts([...current.unresolved_attempts, cacheKey])
  };
}

function abandonPendingShard(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  if (!current.pending_keys.includes(cacheKey)) return current;
  return { ...current, pending_keys: current.pending_keys.filter((key) => key !== cacheKey) };
}

function commitSuccessfulShard(
  current: ExtractionAttemptLedgerRecord,
  shard: ExtractionSuccessfulShard
): ExtractionAttemptLedgerRecord {
  if (current.successful_shards.some((entry) => entry.cacheKey === shard.cacheKey)) return current;
  if (!current.pending_keys.includes(shard.cacheKey)) {
    throw new ExtractionAttemptLimitError("extraction success was not reserved before transport");
  }
  if (current.unresolved_attempts.includes(shard.cacheKey)) {
    throw new ExtractionAttemptLimitError("extraction success must settle its provider attempt first");
  }
  return {
    ...current,
    successful_shards: sortedShards([...current.successful_shards, shard]),
    pending_keys: current.pending_keys.filter((key) => key !== shard.cacheKey)
  };
}

function settleTransportOutcome(
  current: ExtractionAttemptLedgerRecord,
  cacheKey: string,
  input: {
    readonly retryCount: number;
    readonly rateLimitRetries: number;
    readonly terminalRetryClassification?: BenchTerminalRetryClassification;
    readonly usage?: BenchProviderUsage;
  }
): ExtractionAttemptLedgerRecord {
  assertCacheKey(cacheKey);
  assertOutcome(input);
  const unresolved = current.unresolved_attempts.filter((key) => key === cacheKey).length;
  if (unresolved === 0) {
    throw new ExtractionAttemptLimitError("extraction outcome has no durable pre-call attempt");
  }
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
    unresolved_attempts: current.unresolved_attempts.filter((key) => key !== cacheKey),
    telemetry: {
      retry_successes: current.telemetry.retry_successes + (input.retryCount > 0 ? 1 : 0),
      rate_limit_retries: current.telemetry.rate_limit_retries + input.rateLimitRetries,
      terminal,
      input_tokens: current.telemetry.input_tokens + (usage?.inputTokens ?? 0),
      output_tokens: current.telemetry.output_tokens + (usage?.outputTokens ?? 0),
      total_tokens: current.telemetry.total_tokens + (usage?.totalTokens ?? 0),
      usage_unavailable_requests: current.telemetry.usage_unavailable_requests +
        unresolved - knownUsageAttempts
    }
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
  if (persist) persistRecord(path, next);
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
  assertStoredRecord(record);
  if (record.lineage_digest !== lineageDigest || !sameCacheIdentity(record.cache_identity, cacheIdentity)) {
    throw new Error("extraction attempt ledger belongs to a different lineage or cache identity");
  }
}

function assertBoundRecord(
  record: ExtractionAttemptLedgerRecord,
  expected: ExtractionAttemptLedgerRecord
): void {
  assertStoredRecord(record);
  if (record.lineage_digest !== expected.lineage_digest ||
      !sameCacheIdentity(record.cache_identity, expected.cache_identity) ||
      record.starting_missing !== expected.starting_missing ||
      record.maximum_attempts !== expected.maximum_attempts ||
      record.successful_shard_ceiling !== expected.successful_shard_ceiling) {
    throw new Error("extraction attempt ledger is bound to a different lineage or ceiling; cannot reset it");
  }
}

function assertStoredRecord(record: ExtractionAttemptLedgerRecord): void {
  if (record.attempts > record.maximum_attempts ||
      record.successful_shards.length + record.pending_keys.length > record.successful_shard_ceiling ||
      record.unresolved_attempts.length > record.attempts ||
      record.successful_shards.some((shard) => record.pending_keys.includes(shard.cacheKey))) {
    throw new Error("extraction attempt ledger exceeds its recorded authority");
  }
}

function readExistingRecord(path: string): ExtractionAttemptLedgerRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`extraction attempt ledger is unreadable: ${path}`, { cause });
  }
  if (!isLedgerRecord(parsed)) throw new Error(`extraction attempt ledger is invalid: ${path}`);
  return parsed;
}

function isLedgerRecord(value: unknown): value is ExtractionAttemptLedgerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ExtractionAttemptLedgerRecord>;
  return record.schema_version === LEDGER_VERSION && isDigest(record.lineage_digest) &&
    isCacheIdentity(record.cache_identity) && isNonNegativeSafeInteger(record.starting_missing) &&
    isNonNegativeSafeInteger(record.maximum_attempts) &&
    isNonNegativeSafeInteger(record.successful_shard_ceiling) &&
    isNonNegativeSafeInteger(record.attempts) && isShards(record.successful_shards) &&
    isKeys(record.pending_keys) && isKeys(record.unresolved_attempts) && isTelemetry(record.telemetry);
}

function persistRecord(path: string, record: ExtractionAttemptLedgerRecord): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function ledgerPath(cacheRoot: string, lineageDigest: string): string {
  assertDigest(lineageDigest);
  return join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
}

function toSnapshot(record: ExtractionAttemptLedgerRecord): ExtractionAttemptLedgerSnapshot {
  const unresolved = record.unresolved_attempts.length;
  return Object.freeze({
    lineageDigest: record.lineage_digest,
    startingMissing: record.starting_missing,
    maximumAttempts: record.maximum_attempts,
    successfulShardCeiling: record.successful_shard_ceiling,
    attempts: record.attempts,
    successfulShards: record.successful_shards.length,
    successfulKeys: Object.freeze(record.successful_shards.map((shard) => shard.cacheKey)),
    pendingKeys: Object.freeze([...record.pending_keys]),
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

function emptyTelemetry(): ExtractionAttemptTelemetry {
  return {
    retry_successes: 0,
    rate_limit_retries: 0,
    terminal: {
      failure_max_retries: 0,
      failure_non_retryable_4xx: 0,
      failure_timeout: 0,
      failure_aborted: 0
    },
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    usage_unavailable_requests: 0
  };
}

function isTelemetry(value: unknown): value is ExtractionAttemptTelemetry {
  if (typeof value !== "object" || value === null) return false;
  const telemetry = value as Partial<ExtractionAttemptTelemetry>;
  const terminal = telemetry.terminal;
  return isNonNegativeSafeInteger(telemetry.retry_successes) &&
    isNonNegativeSafeInteger(telemetry.rate_limit_retries) &&
    isNonNegativeSafeInteger(telemetry.input_tokens) &&
    isNonNegativeSafeInteger(telemetry.output_tokens) &&
    isNonNegativeSafeInteger(telemetry.total_tokens) &&
    isNonNegativeSafeInteger(telemetry.usage_unavailable_requests) &&
    typeof terminal === "object" && terminal !== null &&
    isNonNegativeSafeInteger(terminal.failure_max_retries) &&
    isNonNegativeSafeInteger(terminal.failure_non_retryable_4xx) &&
    isNonNegativeSafeInteger(terminal.failure_timeout) &&
    isNonNegativeSafeInteger(terminal.failure_aborted);
}

function assertOutcome(input: {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly terminalRetryClassification?: BenchTerminalRetryClassification;
  readonly usage?: BenchProviderUsage;
}): void {
  if (!isNonNegativeSafeInteger(input.retryCount) || !isNonNegativeSafeInteger(input.rateLimitRetries) ||
      (input.usage !== undefined && (!isNonNegativeSafeInteger(input.usage.inputTokens) ||
        !isNonNegativeSafeInteger(input.usage.outputTokens) ||
        !isNonNegativeSafeInteger(input.usage.totalTokens)))) {
    throw new Error("extraction transport outcome telemetry is invalid");
  }
}

function sortedKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)].sort();
}

function sortedAttempts(keys: readonly string[]): readonly string[] {
  return [...keys].sort();
}

function sortedShards(shards: readonly ExtractionSuccessfulShard[]): readonly ExtractionSuccessfulShard[] {
  return [...new Map(shards.map((shard) => [shard.cacheKey, shard])).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
}

function isShards(value: unknown): value is readonly ExtractionSuccessfulShard[] {
  return Array.isArray(value) && value.every((shard) => typeof shard === "object" && shard !== null &&
    isDigest((shard as Partial<ExtractionSuccessfulShard>).cacheKey) &&
    isDigest((shard as Partial<ExtractionSuccessfulShard>).rawJsonSha256));
}

function isKeys(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isDigest);
}

function isCacheIdentity(value: unknown): value is ExtractionAttemptLedgerCacheIdentity {
  try {
    assertExtractionAttemptLedgerCacheIdentity(value);
    return true;
  } catch {
    return false;
  }
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

function assertCacheKey(value: string): void {
  if (!isDigest(value)) {
    throw new Error("extraction cache key must be a lowercase SHA-256 hex string");
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
