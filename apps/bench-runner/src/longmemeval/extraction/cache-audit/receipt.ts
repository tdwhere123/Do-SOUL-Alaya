import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  hashExtractionCacheCompatibilityDecision,
  type ExtractionCacheCompatibilityDecision,
  type ExtractionCacheCompatibilityIdentity,
  type ExtractionCacheCompatibilityReason,
  type ExtractionReplayClosure
} from "./compatibility.js";

export interface ExtractionCacheAuditReceipt {
  readonly schema_version: 1;
  readonly kind: "longmemeval_extraction_cache_compatibility_decision";
  readonly created_at: string;
  readonly source_root: string;
  readonly source_manifest_sha256: string;
  readonly raw_inventory_sha256: string;
  readonly occurrence_index_sha256: string;
  readonly decision: ExtractionCacheCompatibilityDecision;
  readonly decision_digest: string;
}

export function buildExtractionCacheAuditReceipt(input: {
  readonly createdAt: string;
  readonly sourceRoot: string;
  readonly sourceManifestSha256: string;
  readonly rawInventorySha256: string;
  readonly occurrenceIndexSha256: string;
  readonly decision: ExtractionCacheCompatibilityDecision;
}): ExtractionCacheAuditReceipt {
  const receipt = {
    schema_version: 1 as const,
    kind: "longmemeval_extraction_cache_compatibility_decision" as const,
    created_at: input.createdAt,
    source_root: input.sourceRoot,
    source_manifest_sha256: input.sourceManifestSha256,
    raw_inventory_sha256: input.rawInventorySha256,
    occurrence_index_sha256: input.occurrenceIndexSha256,
    decision: input.decision
  };
  return Object.freeze({ ...receipt, decision_digest: hashReceipt(receipt) });
}

export function writeExtractionCacheAuditReceipt(
  path: string,
  receipt: ExtractionCacheAuditReceipt
): void {
  assertReceiptIntegrity(receipt);
  writeExtractionCacheAuditArtifact(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

export function writeExtractionCacheAuditArtifact(path: string, contents: string): void {
  if (existsSync(path)) throw new Error("extraction cache audit artifact already exists");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readExtractionCacheAuditReceipt(path: string): ExtractionCacheAuditReceipt {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isExtractionCacheAuditReceipt(value)) {
    throw new Error("invalid extraction cache audit receipt shape");
  }
  assertReceiptIntegrity(value);
  return value;
}

function assertReceiptIntegrity(receipt: ExtractionCacheAuditReceipt): void {
  assertReceiptShape(receipt);
  if (!isSha256(receipt.source_manifest_sha256) || !isSha256(receipt.raw_inventory_sha256) ||
      !isSha256(receipt.occurrence_index_sha256) || !isSha256(receipt.decision_digest)) {
    throw new Error("extraction cache audit receipt requires SHA-256 bindings");
  }
  if (receipt.decision_digest !== hashReceipt(withoutDigest(receipt))) {
    throw new Error("extraction cache audit receipt digest does not bind its payload");
  }
}

function hashReceipt(
  receipt: Omit<ExtractionCacheAuditReceipt, "decision_digest">
): string {
  return createHash("sha256").update(JSON.stringify({
    ...receipt,
    decision_digest: hashExtractionCacheCompatibilityDecision(receipt.decision)
  }), "utf8").digest("hex");
}

function withoutDigest(
  receipt: ExtractionCacheAuditReceipt
): Omit<ExtractionCacheAuditReceipt, "decision_digest"> {
  const { decision_digest: _digest, ...payload } = receipt;
  return payload;
}

function isExtractionCacheAuditReceipt(value: unknown): value is ExtractionCacheAuditReceipt {
  return isRecord(value) && value.schema_version === 1 &&
    value.kind === "longmemeval_extraction_cache_compatibility_decision" &&
    typeof value.created_at === "string" && typeof value.source_root === "string" &&
    typeof value.source_manifest_sha256 === "string" &&
    typeof value.raw_inventory_sha256 === "string" &&
    typeof value.occurrence_index_sha256 === "string" &&
    typeof value.decision_digest === "string" && isDecision(value.decision);
}

function assertReceiptShape(receipt: ExtractionCacheAuditReceipt): void {
  if (!isExtractionCacheAuditReceipt(receipt) || !isIsoDate(receipt.created_at) ||
      receipt.source_root.trim().length === 0 || receipt.decision.sourceRoot !== receipt.source_root) {
    throw new Error("invalid extraction cache audit receipt shape");
  }
}

function isDecision(value: unknown): value is ExtractionCacheCompatibilityDecision {
  return isRecord(value) && (value.action === "reuse" || value.action === "rebuild") &&
    typeof value.sourceRoot === "string" && Array.isArray(value.reasons) &&
    value.reasons.every(isCompatibilityReason) && isCompatibilityIdentity(value.source) &&
    isCompatibilityIdentity(value.final) && isReplayClosure(value.replay);
}

function isCompatibilityIdentity(value: unknown): value is ExtractionCacheCompatibilityIdentity {
  if (!isRecord(value)) return false;
  return compatibilityFields.every((field) => typeof value[field] === "string");
}

function isReplayClosure(value: unknown): value is ExtractionReplayClosure {
  if (!isRecord(value) || typeof value.ledgerSha256 !== "string") return false;
  return replayCountFields.every((field) => isNonnegativeInteger(value[field]));
}

function isCompatibilityReason(value: unknown): value is ExtractionCacheCompatibilityReason {
  return typeof value === "string" && compatibilityReasons.has(
    value as ExtractionCacheCompatibilityReason
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isNonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

const compatibilityFields: readonly (keyof ExtractionCacheCompatibilityIdentity)[] = [
  "datasetRevision", "model", "modelFamily", "requestProfile", "providerUrl",
  "systemPromptSha256", "cacheKeyAlgorithm", "rawClosureSha256", "parserSemanticsSha256",
  "formationSemanticsSha256", "temporalSchemaRevision"
];

const replayCountFields: readonly (keyof Omit<ExtractionReplayClosure, "ledgerSha256">)[] = [
  "occurrenceCount", "accountedOccurrences", "elementCount", "accountedElements",
  "admitted", "deferred", "rejected", "invalid"
];

const compatibilityReasons = new Set<ExtractionCacheCompatibilityReason>([
  "dataset_revision_mismatch", "model_mismatch", "model_family_mismatch",
  "request_profile_mismatch", "provider_url_mismatch", "system_prompt_mismatch",
  "cache_key_algorithm_mismatch", "raw_closure_mismatch", "parser_semantics_mismatch",
  "formation_semantics_mismatch", "temporal_schema_mismatch", "raw_inventory_not_closed",
  "replay_not_closed"
]);
