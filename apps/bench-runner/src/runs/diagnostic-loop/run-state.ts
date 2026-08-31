import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./checkpoint.js";
import {
  resolvedDiagnosticLoopIdentityDigest,
  type ResolvedDiagnosticLoopIdentity
} from "./authority/identity.js";
import { CACHED_F3_EXPOSURE_POLICY } from
  "../../diagnostics/stage-attribution/exposure/contract.js";
import { isDiagnosticLoopMode, type DiagnosticLoopMode } from "./phases.js";
import { assertDiagnosticLoopIdentity, isSha256Hex, sha256Utf8 } from "./identity.js";
import { isCurrentQueryFactorCacheRunIdentity } from
  "../query-factors/query-semantic-factor-cache-identity.js";

export interface DiagnosticLoopRunRecord {
  readonly schema_version: 4;
  readonly kind: "diagnostic_loop_run";
  readonly identity_digest: string;
  readonly identity: ResolvedDiagnosticLoopIdentity;
  readonly mode: DiagnosticLoopMode;
  readonly argv: readonly string[];
  readonly run_record_digest: string;
}

type UnsignedRunRecord = Omit<DiagnosticLoopRunRecord, "run_record_digest">;
const RUN_RECORD_KEYS = [
  "schema_version", "kind", "identity_digest", "identity", "mode", "argv",
  "run_record_digest"
] as const;
const REQUEST_REQUIRED_KEYS = [
  "datasetRevision", "requestedKeys", "providerRoute", "model", "requestProfile",
  "promptDigest", "schemaDigest", "operatorDigest", "cacheMode", "variant", "worker"
] as const;
const REQUEST_OPTIONAL_KEYS = [
  "limit", "offset", "extractionCacheRoot", "snapshotPath", "snapshotOutPath",
  "treatmentFactorCachePath", "historyRoot", "dataDir"
] as const;

export function runRecordPath(workRoot: string): string {
  return join(workRoot, "run.json");
}

export function recordedQueryCacheFileSha256(workRoot: string): string | undefined {
  const path = runRecordPath(workRoot);
  if (!existsSync(path)) return undefined;
  return readRunRecord(path).identity.query_factor_cache?.file_sha256;
}

export function persistRunRecord(input: {
  readonly workRoot: string;
  readonly identity: ResolvedDiagnosticLoopIdentity;
  readonly mode: DiagnosticLoopMode;
  readonly argv: readonly string[];
}): string {
  mkdirSync(input.workRoot, { recursive: true });
  const identityDigest = resolvedDiagnosticLoopIdentityDigest(input.identity);
  const existingPath = runRecordPath(input.workRoot);
  if (existsSync(existingPath)) {
    const existing = readRunRecord(existingPath);
    if (existing.identity_digest !== identityDigest) {
      throw new Error(
        "diagnostic-loop work root already binds a different identity; " +
        "use a new --work-root"
      );
    }
    return existing.run_record_digest;
  }
  const unsigned: UnsignedRunRecord = {
    schema_version: 4,
    kind: "diagnostic_loop_run",
    identity_digest: identityDigest,
    identity: input.identity,
    mode: input.mode,
    argv: input.argv
  };
  const record = { ...unsigned, run_record_digest: runRecordDigest(unsigned) };
  writeJsonAtomic(existingPath, record);
  return record.run_record_digest;
}

export function readRunRecord(path: string): DiagnosticLoopRunRecord {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertRunRecordShape(parsed, path);
  const record = parsed;
  if (resolvedDiagnosticLoopIdentityDigest(record.identity) !== record.identity_digest) {
    throw new Error(`diagnostic-loop run record identity digest mismatch: ${path}`);
  }
  const { run_record_digest: actual, ...unsigned } = record;
  if (actual !== runRecordDigest(unsigned)) {
    throw new Error(`diagnostic-loop run record digest mismatch: ${path}`);
  }
  return record;
}

export function runRecordDigest(record: UnsignedRunRecord): string {
  return sha256Utf8(JSON.stringify(record));
}

function assertRunRecordShape(
  value: unknown,
  path: string
): asserts value is DiagnosticLoopRunRecord {
  if (!isRecord(value) || !hasExactKeys(value, RUN_RECORD_KEYS) ||
      value.schema_version !== 4 || value.kind !== "diagnostic_loop_run" ||
      !isSha(value.identity_digest) || !isSha(value.run_record_digest) ||
      typeof value.mode !== "string" || !isDiagnosticLoopMode(value.mode) ||
      !Array.isArray(value.argv) ||
      !value.argv.every((arg) => typeof arg === "string") ||
      !isResolvedIdentity(value.identity)) {
    throw new Error(`invalid diagnostic-loop run record: ${path}`);
  }
}

function isResolvedIdentity(value: unknown): value is ResolvedDiagnosticLoopIdentity {
  if (!isRecord(value) || value.schema_version !== 3 ||
      value.canonical_mode !== "cache_only" ||
      !isSha(value.request_identity_digest) || !isRequest(value.request)) return false;
  const allowed = new Set([
    "schema_version", "canonical_mode", "request_identity_digest", "request",
    "extraction_cache", "snapshot", "query_factor_cache", "treatment_exposure_policy"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return isExposurePolicy(value.treatment_exposure_policy) &&
    optionalExtraction(value.extraction_cache) &&
    optionalSnapshot(value.snapshot) && optionalQueryCache(value.query_factor_cache);
}

function isExposurePolicy(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "schema_version", "kind", "denominator_kind", "named_negative_control_ids",
    "candidate_attribution_required", "control_non_exposure_required"
  ]) && value.schema_version === CACHED_F3_EXPOSURE_POLICY.schema_version &&
    value.kind === CACHED_F3_EXPOSURE_POLICY.kind &&
    value.denominator_kind === CACHED_F3_EXPOSURE_POLICY.denominator_kind &&
    Array.isArray(value.named_negative_control_ids) &&
    value.named_negative_control_ids.length ===
      CACHED_F3_EXPOSURE_POLICY.named_negative_control_ids.length &&
    value.named_negative_control_ids.every((id, index) =>
      id === CACHED_F3_EXPOSURE_POLICY.named_negative_control_ids[index]) &&
    value.candidate_attribution_required ===
      CACHED_F3_EXPOSURE_POLICY.candidate_attribution_required &&
    value.control_non_exposure_required ===
      CACHED_F3_EXPOSURE_POLICY.control_non_exposure_required;
}

function isRequest(value: unknown): boolean {
  if (!isRecord(value) || !hasRequiredAllowedKeys(
    value, REQUEST_REQUIRED_KEYS, REQUEST_OPTIONAL_KEYS
  )) return false;
  if (!Array.isArray(value.requestedKeys) ||
      !value.requestedKeys.every((key) => typeof key === "string") ||
      typeof value.worker !== "boolean" ||
      !optionalPositive(value.limit) || !optionalCount(value.offset) ||
      !isVariant(value.variant) ||
      !REQUEST_OPTIONAL_KEYS.slice(2).every((key) => optionalString(value[key]))) {
    return false;
  }
  try {
    assertDiagnosticLoopIdentity(value as never);
    return true;
  } catch {
    return false;
  }
}

function optionalExtraction(value: unknown): boolean {
  if (value === undefined) return true;
  const strings = [
    "root", "manifest_sha256", "dataset_revision", "extraction_model",
    "request_profile", "system_prompt_sha256", "content_closure_sha256",
    "expected_key_set_sha256"
  ];
  return exactTypedObject(value, strings, ["shard_count", "window_offset", "window_limit"]);
}

function optionalSnapshot(value: unknown): boolean {
  if (value === undefined || !isRecord(value)) return value === undefined;
  const strings = [
    "path", "db_sha256", "manifest_sha256", "sidecar_sha256",
    "extraction_authority_sha256", "question_id_digest", "dataset_sha256",
    "identity_digest"
  ];
  return hasExactKeys(value, [
    ...strings, "question_count", "question_ids", "extraction_binding"
  ]) &&
    strings.every((key) => typeof value[key] === "string") &&
    isCount(value.question_count) && Array.isArray(value.question_ids) &&
    value.question_ids.every((id) => typeof id === "string" && id.length > 0) &&
    value.question_ids.length === value.question_count &&
    optionalExtractionBinding(value.extraction_binding);
}

function optionalExtractionBinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return optionalExtraction({ root: "/bound", ...value });
}

function optionalQueryCache(value: unknown): boolean {
  return value === undefined || isCurrentQueryFactorCacheRunIdentity(value);
}

function exactTypedObject(
  value: unknown,
  strings: readonly string[],
  counts: readonly string[]
): boolean {
  return isRecord(value) && hasExactKeys(value, [...strings, ...counts]) &&
    strings.every((key) => typeof value[key] === "string") &&
    counts.every((key) => isCount(value[key]));
}

function hasRequiredAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalCount(value: unknown): boolean {
  return value === undefined || isCount(value);
}

function optionalPositive(value: unknown): boolean {
  return value === undefined || (isCount(value) && value > 0);
}

function isVariant(value: unknown): boolean {
  return value === "longmemeval_oracle" || value === "longmemeval_s" ||
    value === "longmemeval_m";
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && isSha256Hex(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}
