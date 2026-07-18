import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtractionRequestProfile } from "../request-profile.js";
import {
  assertDirectExtractionSpendAuthorization,
  isDirectExtractionSpendAuthorization,
  type DirectExtractionSpendAuthorization
} from "./direct-deepseek-500.js";
import {
  expectedExtractionAuthorityLimits,
  EXTRACTION_AUTHORITY_NO_PROGRESS_TIMEOUT_MS,
  resolveExtractionAuthorityReceiptLimits,
  resolveExtractionAuthorityReceiptPrice,
  type ExtractionAuthorityPriceEstimate,
  type ExtractionAuthorityReceiptLimits,
  type ExtractionAuthorityReceiptPrice
} from "./receipt-limits.js";

const LEGACY_RECEIPT_VERSION = 2;
const CURRENT_RECEIPT_VERSION = 3;

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
  readonly schema_version: typeof LEGACY_RECEIPT_VERSION | typeof CURRENT_RECEIPT_VERSION;
  readonly kind: "longmemeval-extraction-authority";
  readonly action: "probe" | "fill";
  readonly generated_at: string;
  readonly identity_digest: string;
  readonly lineage_digest: string;
  readonly receipt_digest: string;
  readonly observation: ExtractionAuthorityObservation;
  readonly inspection: ExtractionAuthorityInspection;
  readonly limits: ExtractionAuthorityReceiptLimits;
  readonly price: ExtractionAuthorityReceiptPrice;
  readonly probe_key?: string;
  /** Immutable target-selection receipt that binds the cache root for a new rebuild. */
  readonly target_selection_digest?: string;
  readonly direct_spend?: DirectExtractionSpendAuthorization;
}

export interface ExtractionAuthorityInspection {
  readonly writerLock: "absent" | "present";
  readonly disk: { readonly status: "available"; readonly freeBytes: number } |
    { readonly status: "unavailable" };
  readonly credentialStatus: "present" | "absent";
  readonly modelReadiness: "not_probed";
}

export interface ExtractionAuthorityReceiptInput {
  readonly action: ExtractionAuthorityReceipt["action"];
  readonly observation: ExtractionAuthorityObservation;
  readonly outputTokenCap: {
    readonly field: ExtractionAuthorityReceipt["limits"]["output_token_field"];
    readonly value: number;
  };
  readonly priceEstimate: ExtractionAuthorityPriceEstimate;
  readonly diskFloorBytes: number;
  readonly inspection: ExtractionAuthorityInspection;
  readonly maxConcurrency?: number;
  readonly probeKey?: string;
  readonly targetSelectionDigest?: string;
  readonly cumulativeLimits?: {
    readonly startingMissing: number;
    readonly maximumAttempts: number;
    readonly successfulShardCeiling: number;
  };
  readonly directSpend?: DirectExtractionSpendAuthorization;
  readonly now?: Date;
}

export function createExtractionAuthorityReceipt(
  input: ExtractionAuthorityReceiptInput
): ExtractionAuthorityReceipt {
  assertReceiptCreationInput(input);
  const unsigned = buildUnsignedReceipt(input);
  return Object.freeze({ ...unsigned, receipt_digest: computeReceiptDigest(unsigned) });
}

function assertReceiptCreationInput(input: ExtractionAuthorityReceiptInput): void {
  assertObservation(input.observation);
  if (input.directSpend !== undefined) {
    assertDirectExtractionSpendAuthorization({
      action: input.action,
      authorization: input.directSpend,
      observation: input.observation
    });
  }
  if (input.directSpend !== undefined && input.targetSelectionDigest !== undefined) {
    throw new Error("direct extraction authorization cannot mix target selection evidence");
  }
  if (input.targetSelectionDigest !== undefined && !isDigest(input.targetSelectionDigest)) {
    throw new Error("extraction target selection digest is invalid");
  }
  assertInspection(input.inspection);
}

function buildUnsignedReceipt(
  input: ExtractionAuthorityReceiptInput
): Omit<ExtractionAuthorityReceipt, "receipt_digest"> {
  const limits = resolveExtractionAuthorityReceiptLimits(input);
  const price = resolveExtractionAuthorityReceiptPrice(input.priceEstimate, limits);
  const probeKey = input.action === "probe" ? requireProbeKey(input.probeKey) : undefined;
  return {
    schema_version: CURRENT_RECEIPT_VERSION,
    kind: "longmemeval-extraction-authority" as const,
    action: input.action,
    generated_at: (input.now ?? new Date()).toISOString(),
    identity_digest: computeExtractionAuthorityIdentityDigest(input.observation),
    lineage_digest: computeExtractionAuthorityLineageDigest(input.observation),
    observation: freezeObservation(input.observation),
    inspection: freezeInspection(input.inspection),
    limits,
    price,
    ...(probeKey === undefined ? {} : { probe_key: probeKey }),
    ...(input.targetSelectionDigest === undefined ? {} : {
      target_selection_digest: input.targetSelectionDigest
    }),
    ...(input.directSpend === undefined ? {} : {
      direct_spend: Object.freeze({ ...input.directSpend })
    })
  };
}

export function assertExtractionAuthorityReceipt(
  receipt: ExtractionAuthorityReceipt,
  observation: ExtractionAuthorityObservation
): void {
  assertReceiptShape(receipt);
  assertObservation(observation);
  if (receipt.direct_spend !== undefined) {
    assertDirectExtractionSpendAuthorization({
      action: receipt.action,
      authorization: receipt.direct_spend,
      observation: receipt.observation
    });
  }
  assertReceiptIdentity(receipt);
  if (receipt.lineage_digest !== computeExtractionAuthorityLineageDigest(observation)) {
    throw new Error("extraction authority receipt does not match the current identity drift");
  }
  assertMonotonicInventory(receipt.observation.inventory, observation.inventory);
  if (receipt.observation.extraction.rawContentClosureSha256 !==
      observation.extraction.rawContentClosureSha256) {
    throw new Error("extraction authority receipt raw cache closure drifted after inspection");
  }
  const limits = expectedExtractionAuthorityLimits(
    receipt.action,
    receipt.limits.starting_missing
  );
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

function assertReceiptShape(value: unknown): asserts value is ExtractionAuthorityReceipt {
  if (typeof value !== "object" || value === null) {
    throw new Error("extraction authority receipt is invalid");
  }
  const receipt = value as Partial<ExtractionAuthorityReceipt>;
  if ((receipt.schema_version !== LEGACY_RECEIPT_VERSION &&
       receipt.schema_version !== CURRENT_RECEIPT_VERSION) ||
      receipt.kind !== "longmemeval-extraction-authority" ||
      (receipt.action !== "probe" && receipt.action !== "fill") ||
      typeof receipt.generated_at !== "string" ||
      !isDigest(receipt.identity_digest) ||
      !isDigest(receipt.lineage_digest) ||
      !isDigest(receipt.receipt_digest) ||
      !isObservation(receipt.observation) ||
      !isInspection(receipt.inspection) ||
      !isReceiptLimits(receipt.limits) || !isReceiptPrice(receipt.price) ||
      (receipt.target_selection_digest !== undefined && !isDigest(receipt.target_selection_digest)) ||
      (receipt.direct_spend !== undefined &&
        !isDirectExtractionSpendAuthorization(receipt.direct_spend))) {
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
    value.no_progress_timeout_ms === EXTRACTION_AUTHORITY_NO_PROGRESS_TIMEOUT_MS;
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
