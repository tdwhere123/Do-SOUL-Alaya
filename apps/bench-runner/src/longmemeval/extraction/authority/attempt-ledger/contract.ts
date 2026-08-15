import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BenchTerminalRetryClassification,
  BenchTransportFailureKind,
  BenchTransportFailurePhase
} from "../../../compile-seed/compile-seed-types.js";
import type {
  ExtractionAttemptLedgerCacheIdentity,
  ExtractionSuccessfulShard
} from "../attempt-ledger-shards.js";
import { readBoundedCanonicalUtf8Artifact } from "../../cache-audit/bounded-artifact-reader.js";
import {
  publishBytesExclusiveDurable,
  replaceBytesDurable
} from "../../fill/manifest/durable-exclusive-publication.js";

export const EXTRACTION_ATTEMPT_LEDGER_VERSION = 5;
const PREVIOUS_LEDGER_VERSION = 4;
const LEGACY_LEDGER_VERSION = 3;
const MAX_ATTEMPT_LEDGER_BYTES = 32 * 1024 * 1024;

export interface ExtractionAttemptReservationRecord {
  readonly attempt_ordinal: number;
  readonly cache_key: string;
}

export interface ExtractionTransportFailureRecord {
  readonly attempt_ordinal: number;
  readonly cache_key: string;
  readonly kind: BenchTransportFailureKind;
  readonly phase: BenchTransportFailurePhase;
  readonly http_status: number | null;
  readonly fingerprint: string;
}

export interface ExtractionAttemptTelemetryRecord {
  readonly retry_successes: number;
  readonly rate_limit_retries: number;
  readonly terminal: Readonly<Record<BenchTerminalRetryClassification, number>>;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly usage_unavailable_requests: number;
}

export interface ExtractionAttemptLedgerRecord {
  readonly schema_version: typeof EXTRACTION_ATTEMPT_LEDGER_VERSION;
  readonly lineage_digest: string;
  readonly cache_identity: ExtractionAttemptLedgerCacheIdentity;
  readonly starting_missing: number;
  readonly maximum_attempts: number;
  readonly successful_shard_ceiling: number;
  readonly attempts: number;
  readonly successful_shards: readonly ExtractionSuccessfulShard[];
  readonly pending_keys: readonly string[];
  readonly unresolved_attempts: readonly ExtractionAttemptReservationRecord[];
  readonly transport_failures: readonly ExtractionTransportFailureRecord[];
  readonly telemetry: ExtractionAttemptTelemetryRecord;
}

export function readAttemptLedgerRecord(path: string): ExtractionAttemptLedgerRecord {
  return readAttemptLedgerRecordEnvelope(path).record;
}

export function readAttemptLedgerRecordEnvelope(path: string): {
  readonly record: ExtractionAttemptLedgerRecord;
  readonly rawSha256: string;
} {
  const text = readBoundedCanonicalUtf8Artifact({
    path, maxBytes: MAX_ATTEMPT_LEDGER_BYTES, label: "extraction attempt ledger"
  });
  const raw = Buffer.from(text, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`extraction attempt ledger is unreadable: ${path}`, { cause });
  }
  const rawSha256 = createHash("sha256").update(raw).digest("hex");
  if (isAttemptLedgerRecord(parsed)) return { record: parsed, rawSha256 };
  const migrated = migrateLegacyRecord(parsed);
  if (migrated !== undefined) return { record: migrated, rawSha256 };
  throw new Error(`extraction attempt ledger is invalid: ${path}`);
}

export function persistAttemptLedgerRecord(
  path: string,
  record: ExtractionAttemptLedgerRecord,
  temporaryDirectory: string = dirname(dirname(path))
): void {
  assertStoredAttemptLedgerRecord(record);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  replaceBytesDurable({
    destination: path,
    bytes: serializeLedger(record),
    ownerIdentity: record.lineage_digest,
    temporaryDirectory
  });
}

export function persistAttemptLedgerRecordExclusive(
  path: string,
  record: ExtractionAttemptLedgerRecord,
  temporaryDirectory: string = dirname(dirname(path))
): void {
  assertStoredAttemptLedgerRecord(record);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  publishBytesExclusiveDurable({
    destination: path,
    bytes: serializeLedger(record),
    ownerIdentity: record.lineage_digest,
    temporaryDirectory
  });
}

function serializeLedger(record: ExtractionAttemptLedgerRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

export function assertStoredAttemptLedgerRecord(record: ExtractionAttemptLedgerRecord): void {
  const reservations = record.unresolved_attempts;
  const failures = record.transport_failures;
  if (record.attempts > record.maximum_attempts ||
      record.successful_shards.length + record.pending_keys.length >
        record.successful_shard_ceiling ||
      reservations.length > record.attempts ||
      failures.length + reservations.length > record.attempts ||
      record.successful_shards.some((shard) => record.pending_keys.includes(shard.cacheKey)) ||
      !hasUniqueOrderedOrdinals(reservations) || !hasUniqueOrderedOrdinals(failures) ||
      hasOrdinalBeyondAttempts(reservations, record.attempts) ||
      hasOrdinalBeyondAttempts(failures, record.attempts) ||
      hasOrdinalOverlap(reservations, failures)) {
    throw new Error("extraction attempt ledger exceeds its recorded authority");
  }
}

export function emptyAttemptTelemetry(): ExtractionAttemptTelemetryRecord {
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

function isAttemptLedgerRecord(value: unknown): value is ExtractionAttemptLedgerRecord {
  if (!hasExactKeys(value, [
    "schema_version", "lineage_digest", "cache_identity", "starting_missing",
    "maximum_attempts", "successful_shard_ceiling", "attempts", "successful_shards",
    "pending_keys", "unresolved_attempts", "transport_failures", "telemetry"
  ])) return false;
  const record = value as unknown as ExtractionAttemptLedgerRecord;
  if (record.schema_version !== EXTRACTION_ATTEMPT_LEDGER_VERSION ||
      !isDigest(record.lineage_digest) || !isCacheIdentity(record.cache_identity) ||
      !isNonNegativeSafeInteger(record.starting_missing) ||
      !isNonNegativeSafeInteger(record.maximum_attempts) ||
      !isNonNegativeSafeInteger(record.successful_shard_ceiling) ||
      !isNonNegativeSafeInteger(record.attempts) || !isShards(record.successful_shards) ||
      !isKeys(record.pending_keys) || !isReservations(record.unresolved_attempts) ||
      !isFailures(record.transport_failures) || !isTelemetry(record.telemetry)) return false;
  try {
    assertStoredAttemptLedgerRecord(record);
    return true;
  } catch {
    return false;
  }
}

function migrateLegacyRecord(value: unknown): ExtractionAttemptLedgerRecord | undefined {
  if (isPreviousRecord(value)) {
    const migrated: ExtractionAttemptLedgerRecord = {
      ...value,
      schema_version: EXTRACTION_ATTEMPT_LEDGER_VERSION,
      successful_shards: classifyLegacyShards(value.successful_shards)
    };
    assertStoredAttemptLedgerRecord(migrated);
    return migrated;
  }
  if (!isLegacyRecord(value)) return undefined;
  if (value.unresolved_attempts.length > 0) {
    throw new Error(
      "legacy extraction attempt ledger has unresolved reservations without recoverable ordinals"
    );
  }
  const migrated: ExtractionAttemptLedgerRecord = {
    ...value,
    schema_version: EXTRACTION_ATTEMPT_LEDGER_VERSION,
    successful_shards: classifyLegacyShards(value.successful_shards),
    unresolved_attempts: [],
    transport_failures: []
  };
  assertStoredAttemptLedgerRecord(migrated);
  return migrated;
}

interface LegacySuccessfulShard {
  readonly cacheKey: string;
  readonly rawJsonSha256: string;
}

interface PreviousRecord extends Omit<
  ExtractionAttemptLedgerRecord, "schema_version" | "successful_shards"
> {
  readonly schema_version: typeof PREVIOUS_LEDGER_VERSION;
  readonly successful_shards: readonly LegacySuccessfulShard[];
}

interface LegacyRecord extends Omit<
  PreviousRecord, "schema_version" | "unresolved_attempts" | "transport_failures"
> {
  readonly schema_version: typeof LEGACY_LEDGER_VERSION;
  readonly unresolved_attempts: readonly string[];
}

function isPreviousRecord(value: unknown): value is PreviousRecord {
  if (!hasExactKeys(value, [
    "schema_version", "lineage_digest", "cache_identity", "starting_missing",
    "maximum_attempts", "successful_shard_ceiling", "attempts", "successful_shards",
    "pending_keys", "unresolved_attempts", "transport_failures", "telemetry"
  ])) return false;
  const record = value as unknown as PreviousRecord;
  return record.schema_version === PREVIOUS_LEDGER_VERSION &&
    isCommonLegacyRecord(record) && isReservations(record.unresolved_attempts) &&
    isFailures(record.transport_failures);
}

function isLegacyRecord(value: unknown): value is LegacyRecord {
  if (!hasExactKeys(value, [
    "schema_version", "lineage_digest", "cache_identity", "starting_missing",
    "maximum_attempts", "successful_shard_ceiling", "attempts", "successful_shards",
    "pending_keys", "unresolved_attempts", "telemetry"
  ])) return false;
  const record = value as unknown as LegacyRecord;
  return record.schema_version === LEGACY_LEDGER_VERSION && isDigest(record.lineage_digest) &&
    isCacheIdentity(record.cache_identity) && isNonNegativeSafeInteger(record.starting_missing) &&
    isNonNegativeSafeInteger(record.maximum_attempts) &&
    isNonNegativeSafeInteger(record.successful_shard_ceiling) &&
    isNonNegativeSafeInteger(record.attempts) && isLegacyShards(record.successful_shards) &&
    isKeys(record.pending_keys) && isKeys(record.unresolved_attempts) &&
    record.unresolved_attempts.length <= record.attempts && isTelemetry(record.telemetry);
}

function isCommonLegacyRecord(record: PreviousRecord): boolean {
  return isDigest(record.lineage_digest) && isCacheIdentity(record.cache_identity) &&
    isNonNegativeSafeInteger(record.starting_missing) &&
    isNonNegativeSafeInteger(record.maximum_attempts) &&
    isNonNegativeSafeInteger(record.successful_shard_ceiling) &&
    isNonNegativeSafeInteger(record.attempts) && isLegacyShards(record.successful_shards) &&
    isKeys(record.pending_keys) && isTelemetry(record.telemetry);
}

function classifyLegacyShards(
  shards: readonly LegacySuccessfulShard[]
): readonly ExtractionSuccessfulShard[] {
  return shards.map((shard) => ({ ...shard, successKind: "legacy-unclassified" }));
}

function isReservations(value: unknown): value is readonly ExtractionAttemptReservationRecord[] {
  return Array.isArray(value) && value.every((entry) => hasExactKeys(
    entry, ["attempt_ordinal", "cache_key"]
  ) && isPositiveSafeInteger(entry.attempt_ordinal) && isDigest(entry.cache_key));
}

function isFailures(value: unknown): value is readonly ExtractionTransportFailureRecord[] {
  return Array.isArray(value) && value.every((entry) => hasExactKeys(entry, [
    "attempt_ordinal", "cache_key", "kind", "phase", "http_status", "fingerprint"
  ]) && isPositiveSafeInteger(entry.attempt_ordinal) && isDigest(entry.cache_key) &&
    isFailureKind(entry.kind) && isFailurePhase(entry.phase) &&
    isHttpStatus(entry.http_status) && isDigest(entry.fingerprint));
}

function isTelemetry(value: unknown): value is ExtractionAttemptTelemetryRecord {
  if (!hasExactKeys(value, [
    "retry_successes", "rate_limit_retries", "terminal", "input_tokens",
    "output_tokens", "total_tokens", "usage_unavailable_requests"
  ])) return false;
  const telemetry = value as unknown as ExtractionAttemptTelemetryRecord;
  const terminal = telemetry.terminal;
  return isNonNegativeSafeInteger(telemetry.retry_successes) &&
    isNonNegativeSafeInteger(telemetry.rate_limit_retries) &&
    isNonNegativeSafeInteger(telemetry.input_tokens) &&
    isNonNegativeSafeInteger(telemetry.output_tokens) &&
    isNonNegativeSafeInteger(telemetry.total_tokens) &&
    isNonNegativeSafeInteger(telemetry.usage_unavailable_requests) &&
    hasExactKeys(terminal, [
      "failure_max_retries", "failure_non_retryable_4xx", "failure_timeout", "failure_aborted"
    ]) && Object.values(terminal).every(isNonNegativeSafeInteger);
}

const FAILURE_KINDS = new Set<string>([
  "network_error", "http_error", "body_read_error", "response_parse_error",
  "response_schema_error", "empty_response", "timeout", "aborted"
]);
const FAILURE_PHASES = new Set<string>([
  "request", "response_status", "response_body", "response_parse", "response_schema"
]);

function isFailureKind(value: unknown): value is BenchTransportFailureKind {
  return typeof value === "string" && FAILURE_KINDS.has(value);
}

function isFailurePhase(value: unknown): value is BenchTransportFailurePhase {
  return typeof value === "string" && FAILURE_PHASES.has(value);
}

function isHttpStatus(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599);
}

function isShards(value: unknown): value is readonly ExtractionSuccessfulShard[] {
  return Array.isArray(value) && value.every((shard) => {
    if (!hasShardIdentity(shard) || typeof shard.successKind !== "string") return false;
    if (shard.successKind === "provider") {
      return hasExactKeys(shard, [
        "cacheKey", "rawJsonSha256", "successKind", "transportProvenance"
      ]) && isTransportProvenance(shard.transportProvenance);
    }
    return (shard.successKind === "deterministic" ||
      shard.successKind === "legacy-unclassified") && hasExactKeys(
      shard, ["cacheKey", "rawJsonSha256", "successKind"]
    );
  });
}

function isLegacyShards(value: unknown): value is readonly LegacySuccessfulShard[] {
  return Array.isArray(value) && value.every((shard) => hasExactKeys(
    shard, ["cacheKey", "rawJsonSha256"]
  ) && hasShardIdentity(shard));
}

function hasShardIdentity(value: unknown): value is Record<string, unknown> & LegacySuccessfulShard {
  return typeof value === "object" && value !== null &&
    isDigest((value as Record<string, unknown>).cacheKey) &&
    isDigest((value as Record<string, unknown>).rawJsonSha256);
}

function isTransportProvenance(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ["provider_url_sha256", "model"]) &&
    typeof record.provider_url_sha256 === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(record.provider_url_sha256) &&
    typeof record.model === "string" && record.model.length > 0;
}

function isKeys(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isDigest);
}

function isCacheIdentity(value: unknown): value is ExtractionAttemptLedgerCacheIdentity {
  return hasExactKeys(value, ["model", "requestProfile"]) &&
    typeof value.model === "string" && value.model.length > 0 &&
    typeof value.requestProfile === "string" && value.requestProfile.length > 0;
}

function hasUniqueOrderedOrdinals(
  records: readonly { readonly attempt_ordinal: number }[]
): boolean {
  return records.every((record, index) => record.attempt_ordinal > 0 &&
    (index === 0 || record.attempt_ordinal > records[index - 1]!.attempt_ordinal));
}

function hasOrdinalBeyondAttempts(
  records: readonly { readonly attempt_ordinal: number }[],
  attempts: number
): boolean {
  return records.some((record) => record.attempt_ordinal > attempts);
}

function hasOrdinalOverlap(
  reservations: readonly ExtractionAttemptReservationRecord[],
  failures: readonly ExtractionTransportFailureRecord[]
): boolean {
  const unresolved = new Set(reservations.map((entry) => entry.attempt_ordinal));
  return failures.some((entry) => unresolved.has(entry.attempt_ordinal));
}

function hasExactKeys<T extends string>(
  value: unknown,
  keys: readonly T[]
): value is Record<T, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
