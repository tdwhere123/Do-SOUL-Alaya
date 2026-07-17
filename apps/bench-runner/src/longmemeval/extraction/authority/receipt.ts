import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtractionRequestProfile } from "../request-profile.js";
import { computeExtractionAttemptCeiling } from "./attempt-ledger.js";

const RECEIPT_VERSION = 2;
const NO_PROGRESS_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_CONCURRENCY = 32;
const MILLION = 1_000_000;

export interface ExtractionAuthorityObservation {
  readonly revision: string;
  readonly commandDigest: string;
  readonly selectionDigest: string;
  readonly keyDigest: string;
  readonly dataset: {
    readonly variant: string;
    readonly revisionSha256: string;
    readonly windowOffset: number;
    readonly windowLimit: number;
    readonly expectedKeySetSha256: string;
  };
  readonly extraction: {
    readonly model: string;
    readonly modelFamily: string;
    readonly requestProfile: ExtractionRequestProfile;
    readonly providerUrl: string;
    readonly systemPromptSha256: string;
    readonly cacheKeyAlgorithm: string;
    readonly manifestSha256: string | null;
    readonly rawContentClosureSha256: string | null;
  };
  readonly inventory: {
    readonly expectedTurns: number;
    readonly validTurns: number;
    readonly missingTurns: number;
    readonly invalidTurns: number;
    readonly orphanTurns: number;
  };
}

export interface ExtractionAuthorityReceipt {
  readonly schema_version: typeof RECEIPT_VERSION;
  readonly kind: "longmemeval-extraction-authority";
  readonly action: "probe" | "fill";
  readonly generated_at: string;
  readonly identity_digest: string;
  readonly lineage_digest: string;
  readonly receipt_digest: string;
  readonly observation: ExtractionAuthorityObservation;
  readonly inspection: ExtractionAuthorityInspection;
  readonly limits: {
    readonly starting_missing: number;
    readonly maximum_attempts: number;
    readonly successful_shard_ceiling: number;
    readonly max_concurrency: number;
    readonly max_output_tokens: number;
    readonly output_token_field: "max_tokens" | "max_completion_tokens";
    readonly disk_floor_bytes: number;
    readonly no_progress_timeout_ms: typeof NO_PROGRESS_TIMEOUT_MS;
  };
  readonly price: {
    readonly input_usd_per_million: number;
    readonly output_usd_per_million: number;
    readonly maximum_input_tokens_per_attempt: number;
    readonly estimated_upper_usd: number;
  };
  readonly probe_key?: string;
}

export interface ExtractionAuthorityInspection {
  readonly writerLock: "absent" | "present";
  readonly disk: { readonly status: "available"; readonly freeBytes: number } |
    { readonly status: "unavailable" };
  readonly credentialStatus: "present" | "absent";
  readonly modelReadiness: "not_probed";
}

export function createExtractionAuthorityReceipt(input: {
  readonly action: ExtractionAuthorityReceipt["action"];
  readonly observation: ExtractionAuthorityObservation;
  readonly outputTokenCap: {
    readonly field: ExtractionAuthorityReceipt["limits"]["output_token_field"];
    readonly value: number;
  };
  readonly priceEstimate: {
    readonly inputUsdPerMillion: number;
    readonly outputUsdPerMillion: number;
    readonly maximumInputTokensPerAttempt: number;
  };
  readonly diskFloorBytes: number;
  readonly inspection: ExtractionAuthorityInspection;
  readonly maxConcurrency?: number;
  readonly probeKey?: string;
  readonly cumulativeLimits?: {
    readonly startingMissing: number;
    readonly maximumAttempts: number;
    readonly successfulShardCeiling: number;
  };
  readonly now?: Date;
}): ExtractionAuthorityReceipt {
  assertObservation(input.observation);
  const limits = resolveLimits(input);
  const price = resolvePrice(input.priceEstimate, limits);
  assertInspection(input.inspection);
  const probeKey = input.action === "probe" ? requireProbeKey(input.probeKey) : undefined;
  const unsigned: Omit<ExtractionAuthorityReceipt, "receipt_digest"> = {
    schema_version: RECEIPT_VERSION,
    kind: "longmemeval-extraction-authority" as const,
    action: input.action,
    generated_at: (input.now ?? new Date()).toISOString(),
    identity_digest: computeExtractionAuthorityIdentityDigest(input.observation),
    lineage_digest: computeExtractionAuthorityLineageDigest(input.observation),
    observation: freezeObservation(input.observation),
    inspection: freezeInspection(input.inspection),
    limits,
    price,
    ...(probeKey === undefined ? {} : { probe_key: probeKey })
  };
  return Object.freeze({
    ...unsigned,
    receipt_digest: computeReceiptDigest(unsigned)
  });
}

export function assertExtractionAuthorityReceipt(
  receipt: ExtractionAuthorityReceipt,
  observation: ExtractionAuthorityObservation
): void {
  assertReceiptShape(receipt);
  assertObservation(observation);
  assertReceiptIdentity(receipt);
  if (receipt.lineage_digest !== computeExtractionAuthorityLineageDigest(observation)) {
    throw new Error("extraction authority receipt does not match the current identity drift");
  }
  assertMonotonicInventory(receipt.observation.inventory, observation.inventory);
  if (receipt.observation.extraction.rawContentClosureSha256 !==
      observation.extraction.rawContentClosureSha256) {
    throw new Error("extraction authority receipt raw cache closure drifted after inspection");
  }
  const limits = expectedLimits(receipt.action, receipt.limits.starting_missing);
  if (receipt.limits.maximum_attempts !== limits.maximumAttempts ||
      receipt.limits.successful_shard_ceiling !== limits.successfulShardCeiling) {
    throw new Error("extraction authority receipt has reset or widened its cumulative limits");
  }
  if (receipt.action === "probe" && receipt.probe_key === undefined) {
    throw new Error("extraction probe authority receipt requires a target key");
  }
}

export function assertExtractionAuthorityRuntimeReadiness(
  receipt: ExtractionAuthorityReceipt,
  inspection: ExtractionAuthorityInspection,
  input: { readonly allowOwnedWriterLock?: boolean } = {}
): void {
  assertReceiptShape(receipt);
  assertInspection(inspection);
  if (inspection.writerLock !== "absent" && input.allowOwnedWriterLock !== true) {
    throw new Error("extraction authority refused: cache writer lock is present");
  }
  if (inspection.disk.status !== "available" ||
      inspection.disk.freeBytes < receipt.limits.disk_floor_bytes) {
    throw new Error("extraction authority refused: disk floor is unavailable or exhausted");
  }
  if (inspection.credentialStatus !== "present") {
    throw new Error("extraction authority refused: extraction credentials are unavailable");
  }
}

export function computeExtractionAuthorityIdentityDigest(
  observation: ExtractionAuthorityObservation
): string {
  assertObservation(observation);
  return createHash("sha256")
    .update(JSON.stringify(canonicalObservation(observation)), "utf8")
    .digest("hex");
}

export function computeExtractionAuthorityLineageDigest(
  observation: ExtractionAuthorityObservation
): string {
  assertObservation(observation);
  return createHash("sha256")
    .update(JSON.stringify(canonicalLineage(observation)), "utf8")
    .digest("hex");
}

export function writeExtractionAuthorityReceipt(
  outputPath: string,
  receipt: ExtractionAuthorityReceipt
): void {
  assertReceiptShape(receipt);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  renameSync(temporary, outputPath);
}

export function readExtractionAuthorityReceipt(outputPath: string): ExtractionAuthorityReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outputPath, "utf8"));
  } catch (cause) {
    throw new Error(`extraction authority receipt is unreadable: ${outputPath}`, { cause });
  }
  assertReceiptShape(parsed);
  return parsed;
}

function resolveLimits(input: Parameters<typeof createExtractionAuthorityReceipt>[0]): ExtractionAuthorityReceipt["limits"] {
  const carried = input.cumulativeLimits;
  const missing = carried?.startingMissing ?? input.observation.inventory.missingTurns;
  const expected = expectedLimits(input.action, missing);
  if (carried !== undefined && (carried.maximumAttempts !== expected.maximumAttempts ||
      carried.successfulShardCeiling !== expected.successfulShardCeiling)) {
    throw new Error("extraction authority cumulative limits are not derivable from its starting inventory");
  }
  const maxConcurrency = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 ||
      maxConcurrency > DEFAULT_MAX_CONCURRENCY) {
    throw new Error(`extraction authority max concurrency must be 1-${DEFAULT_MAX_CONCURRENCY}`);
  }
  if (!Number.isSafeInteger(input.outputTokenCap.value) || input.outputTokenCap.value < 1) {
    throw new Error("extraction authority output token cap must be a positive integer");
  }
  if (!Number.isSafeInteger(input.diskFloorBytes) || input.diskFloorBytes < 0) {
    throw new Error("extraction authority disk floor must be a non-negative safe integer");
  }
  return Object.freeze({
    starting_missing: missing,
    maximum_attempts: carried?.maximumAttempts ?? expected.maximumAttempts,
    successful_shard_ceiling: carried?.successfulShardCeiling ?? expected.successfulShardCeiling,
    max_concurrency: maxConcurrency,
    max_output_tokens: input.outputTokenCap.value,
    output_token_field: input.outputTokenCap.field,
    disk_floor_bytes: input.diskFloorBytes,
    no_progress_timeout_ms: NO_PROGRESS_TIMEOUT_MS
  });
}

function resolvePrice(
  input: Parameters<typeof createExtractionAuthorityReceipt>[0]["priceEstimate"],
  limits: ExtractionAuthorityReceipt["limits"]
): ExtractionAuthorityReceipt["price"] {
  assertNonNegativeFinite(input.inputUsdPerMillion, "input price");
  assertNonNegativeFinite(input.outputUsdPerMillion, "output price");
  if (!Number.isSafeInteger(input.maximumInputTokensPerAttempt) ||
      input.maximumInputTokensPerAttempt < 0) {
    throw new Error("extraction authority maximum input tokens must be a non-negative integer");
  }
  const perAttempt = (
    input.maximumInputTokensPerAttempt * input.inputUsdPerMillion +
    limits.max_output_tokens * input.outputUsdPerMillion
  ) / MILLION;
  return Object.freeze({
    input_usd_per_million: input.inputUsdPerMillion,
    output_usd_per_million: input.outputUsdPerMillion,
    maximum_input_tokens_per_attempt: input.maximumInputTokensPerAttempt,
    estimated_upper_usd: perAttempt * limits.maximum_attempts
  });
}

function expectedLimits(action: ExtractionAuthorityReceipt["action"], missing: number): {
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
} {
  if (action === "probe") {
    if (missing < 1) throw new Error("extraction probe requires at least one missing shard");
    return { maximumAttempts: 1, successfulShardCeiling: 1 };
  }
  return {
    maximumAttempts: computeExtractionAttemptCeiling(missing),
    successfulShardCeiling: missing
  };
}

function assertReceiptShape(value: unknown): asserts value is ExtractionAuthorityReceipt {
  if (typeof value !== "object" || value === null) {
    throw new Error("extraction authority receipt is invalid");
  }
  const receipt = value as Partial<ExtractionAuthorityReceipt>;
  if (receipt.schema_version !== RECEIPT_VERSION ||
      receipt.kind !== "longmemeval-extraction-authority" ||
      (receipt.action !== "probe" && receipt.action !== "fill") ||
      typeof receipt.generated_at !== "string" ||
      !isDigest(receipt.identity_digest) ||
      !isDigest(receipt.lineage_digest) ||
      !isDigest(receipt.receipt_digest) ||
      !isObservation(receipt.observation) ||
      !isInspection(receipt.inspection) ||
      !isReceiptLimits(receipt.limits) || !isReceiptPrice(receipt.price)) {
    throw new Error("extraction authority receipt is invalid");
  }
  if (receipt.action === "probe" && !isDigest(receipt.probe_key)) {
    throw new Error("extraction probe authority receipt is missing its target key");
  }
  const verified = receipt as ExtractionAuthorityReceipt;
  if (verified.receipt_digest !== computeReceiptDigest(withoutReceiptDigest(verified))) {
    throw new Error("extraction authority receipt digest is invalid");
  }
}

function assertObservation(observation: ExtractionAuthorityObservation): void {
  if (!isObservation(observation)) throw new Error("extraction authority observation is invalid");
  const inventory = observation.inventory;
  if (inventory.expectedTurns !== inventory.validTurns + inventory.missingTurns + inventory.invalidTurns) {
    throw new Error("extraction authority inventory does not conserve expected turns");
  }
}

function assertInspection(value: ExtractionAuthorityInspection): void {
  if (!isInspection(value)) throw new Error("extraction authority inspection is invalid");
}

function isObservation(value: unknown): value is ExtractionAuthorityObservation {
  if (typeof value !== "object" || value === null) return false;
  const observation = value as Partial<ExtractionAuthorityObservation>;
  const dataset = observation.dataset;
  const extraction = observation.extraction;
  const inventory = observation.inventory;
  return isAuthorityRevision(observation.revision) && isDigest(observation.commandDigest) &&
    isDigest(observation.selectionDigest) && isDigest(observation.keyDigest) &&
    isObject(dataset) && typeof dataset.variant === "string" &&
    isDigest(dataset.revisionSha256) && isNonNegativeSafeInteger(dataset.windowOffset) &&
    isNonNegativeSafeInteger(dataset.windowLimit) && isDigest(dataset.expectedKeySetSha256) &&
    isObject(extraction) && typeof extraction.model === "string" &&
    typeof extraction.modelFamily === "string" &&
    (extraction.requestProfile === "provider-default-v1" ||
      extraction.requestProfile === "deepseek-v4-nonthinking-v1") &&
    typeof extraction.providerUrl === "string" && isDigest(extraction.systemPromptSha256) &&
    typeof extraction.cacheKeyAlgorithm === "string" &&
    (extraction.manifestSha256 === null || isDigest(extraction.manifestSha256)) &&
    (extraction.rawContentClosureSha256 === null || isDigest(extraction.rawContentClosureSha256)) &&
    isObject(inventory) && isNonNegativeSafeInteger(inventory.expectedTurns) &&
    isNonNegativeSafeInteger(inventory.validTurns) && isNonNegativeSafeInteger(inventory.missingTurns) &&
    isNonNegativeSafeInteger(inventory.invalidTurns) && isNonNegativeSafeInteger(inventory.orphanTurns);
}

function isInspection(value: unknown): value is ExtractionAuthorityInspection {
  if (!isObject(value) || (value.writerLock !== "absent" && value.writerLock !== "present") ||
      (value.credentialStatus !== "present" && value.credentialStatus !== "absent") ||
      value.modelReadiness !== "not_probed" || !isObject(value.disk)) {
    return false;
  }
  return value.disk.status === "unavailable" ||
    (value.disk.status === "available" && isNonNegativeSafeInteger(value.disk.freeBytes));
}

function isReceiptLimits(value: unknown): boolean {
  if (!isObject(value)) return false;
  return isNonNegativeSafeInteger(value.starting_missing) &&
    isNonNegativeSafeInteger(value.maximum_attempts) &&
    isNonNegativeSafeInteger(value.successful_shard_ceiling) &&
    isNonNegativeSafeInteger(value.max_concurrency) &&
    isNonNegativeSafeInteger(value.max_output_tokens) &&
    (value.output_token_field === "max_tokens" || value.output_token_field === "max_completion_tokens") &&
    isNonNegativeSafeInteger(value.disk_floor_bytes) &&
    value.no_progress_timeout_ms === NO_PROGRESS_TIMEOUT_MS;
}

function isReceiptPrice(value: unknown): boolean {
  return isObject(value) && typeof value.input_usd_per_million === "number" &&
    typeof value.output_usd_per_million === "number" &&
    isNonNegativeSafeInteger(value.maximum_input_tokens_per_attempt) &&
    typeof value.estimated_upper_usd === "number";
}

function canonicalObservation(observation: ExtractionAuthorityObservation): ExtractionAuthorityObservation {
  return {
    revision: observation.revision,
    commandDigest: observation.commandDigest,
    selectionDigest: observation.selectionDigest,
    keyDigest: observation.keyDigest,
    dataset: { ...observation.dataset },
    extraction: { ...observation.extraction },
    inventory: { ...observation.inventory }
  };
}

function canonicalLineage(observation: ExtractionAuthorityObservation): object {
  return {
    revision: observation.revision,
    commandDigest: observation.commandDigest,
    selectionDigest: observation.selectionDigest,
    keyDigest: observation.keyDigest,
    dataset: { ...observation.dataset },
    extraction: {
      model: observation.extraction.model,
      modelFamily: observation.extraction.modelFamily,
      requestProfile: observation.extraction.requestProfile,
      providerUrl: observation.extraction.providerUrl,
      systemPromptSha256: observation.extraction.systemPromptSha256,
      cacheKeyAlgorithm: observation.extraction.cacheKeyAlgorithm
    },
    expectedTurns: observation.inventory.expectedTurns
  };
}

function assertReceiptIdentity(receipt: ExtractionAuthorityReceipt): void {
  if (receipt.identity_digest !== computeExtractionAuthorityIdentityDigest(receipt.observation) ||
      receipt.lineage_digest !== computeExtractionAuthorityLineageDigest(receipt.observation)) {
    throw new Error("extraction authority receipt identity digest is invalid");
  }
}

function assertMonotonicInventory(
  authorized: ExtractionAuthorityObservation["inventory"],
  current: ExtractionAuthorityObservation["inventory"]
): void {
  if (authorized.invalidTurns !== 0 || authorized.orphanTurns !== 0 ||
      current.invalidTurns !== 0 || current.orphanTurns !== 0) {
    throw new Error("extraction authority receipt cannot authorize invalid or orphan shards");
  }
  if (authorized.expectedTurns !== current.expectedTurns ||
      current.validTurns < authorized.validTurns ||
      current.missingTurns > authorized.missingTurns) {
    throw new Error("extraction authority receipt inventory regressed after inspection");
  }
}

function freezeObservation(observation: ExtractionAuthorityObservation): ExtractionAuthorityObservation {
  return Object.freeze({
    revision: observation.revision,
    commandDigest: observation.commandDigest,
    selectionDigest: observation.selectionDigest,
    keyDigest: observation.keyDigest,
    dataset: Object.freeze({ ...observation.dataset }),
    extraction: Object.freeze({ ...observation.extraction }),
    inventory: Object.freeze({ ...observation.inventory })
  });
}

function freezeInspection(inspection: ExtractionAuthorityInspection): ExtractionAuthorityInspection {
  return Object.freeze({
    writerLock: inspection.writerLock,
    disk: inspection.disk.status === "available"
      ? Object.freeze({ status: "available" as const, freeBytes: inspection.disk.freeBytes })
      : Object.freeze({ status: "unavailable" as const }),
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  });
}

function requireProbeKey(value: string | undefined): string {
  if (!isDigest(value)) throw new Error("extraction probe authority requires a SHA-256 target key");
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isDigest40(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isAuthorityRevision(value: unknown): value is string {
  return isDigest40(value) || (typeof value === "string" &&
    /^git-worktree-v1:[a-f0-9]{40}:[a-f0-9]{64}$/u.test(value));
}

function withoutReceiptDigest(receipt: ExtractionAuthorityReceipt): Omit<
  ExtractionAuthorityReceipt,
  "receipt_digest"
> {
  const { receipt_digest: _receiptDigest, ...unsigned } = receipt;
  return unsigned;
}

function computeReceiptDigest(value: Omit<ExtractionAuthorityReceipt, "receipt_digest">): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`extraction authority ${name} must be non-negative and finite`);
  }
}
