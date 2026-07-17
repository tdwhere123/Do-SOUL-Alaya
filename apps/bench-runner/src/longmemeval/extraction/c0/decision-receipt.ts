import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  hashC0Decision,
  type C0CacheCompatibilityIdentity,
  type C0ReplayClosure,
  type C0ReuseDecision,
  type C0ReuseReason
} from "./decision.js";

export interface C0DecisionReceipt {
  readonly schema_version: 1;
  readonly kind: "longmemeval_c0_reuse_decision";
  readonly created_at: string;
  readonly source_root: string;
  readonly source_manifest_sha256: string;
  readonly raw_inventory_sha256: string;
  readonly occurrence_index_sha256: string;
  readonly decision: C0ReuseDecision;
  readonly decision_digest: string;
}

export function buildC0DecisionReceipt(input: {
  readonly createdAt: string;
  readonly sourceRoot: string;
  readonly sourceManifestSha256: string;
  readonly rawInventorySha256: string;
  readonly occurrenceIndexSha256: string;
  readonly decision: C0ReuseDecision;
}): C0DecisionReceipt {
  const receipt = {
    schema_version: 1 as const,
    kind: "longmemeval_c0_reuse_decision" as const,
    created_at: input.createdAt,
    source_root: input.sourceRoot,
    source_manifest_sha256: input.sourceManifestSha256,
    raw_inventory_sha256: input.rawInventorySha256,
    occurrence_index_sha256: input.occurrenceIndexSha256,
    decision: input.decision
  };
  return Object.freeze({ ...receipt, decision_digest: hashReceipt(receipt) });
}

export function writeC0DecisionReceipt(path: string, receipt: C0DecisionReceipt): void {
  assertReceiptIntegrity(receipt);
  writeC0EvidenceArtifact(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

export function writeC0EvidenceArtifact(path: string, contents: string): void {
  if (existsSync(path)) throw new Error("C0 evidence artifact already exists");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readC0DecisionReceipt(path: string): C0DecisionReceipt {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isC0DecisionReceipt(value)) throw new Error("invalid C0 decision receipt shape");
  assertReceiptIntegrity(value);
  return value;
}

function assertReceiptIntegrity(receipt: C0DecisionReceipt): void {
  assertReceiptShape(receipt);
  if (!isSha256(receipt.source_manifest_sha256) || !isSha256(receipt.raw_inventory_sha256) ||
      !isSha256(receipt.occurrence_index_sha256) || !isSha256(receipt.decision_digest)) {
    throw new Error("C0 decision receipt requires SHA-256 bindings");
  }
  if (receipt.decision_digest !== hashReceipt(withoutDigest(receipt))) {
    throw new Error("C0 decision receipt digest does not bind its payload");
  }
}

function hashReceipt(receipt: Omit<C0DecisionReceipt, "decision_digest">): string {
  return createHash("sha256").update(JSON.stringify({
    ...receipt,
    decision_digest: hashC0Decision(receipt.decision)
  }), "utf8").digest("hex");
}

function withoutDigest(receipt: C0DecisionReceipt): Omit<C0DecisionReceipt, "decision_digest"> {
  const { decision_digest: _digest, ...payload } = receipt;
  return payload;
}

function isC0DecisionReceipt(value: unknown): value is C0DecisionReceipt {
  return isRecord(value) && value.schema_version === 1 &&
    value.kind === "longmemeval_c0_reuse_decision" &&
    typeof value.created_at === "string" && typeof value.source_root === "string" &&
    typeof value.source_manifest_sha256 === "string" &&
    typeof value.raw_inventory_sha256 === "string" &&
    typeof value.occurrence_index_sha256 === "string" &&
    typeof value.decision_digest === "string" && isDecision(value.decision);
}

function assertReceiptShape(receipt: C0DecisionReceipt): void {
  if (!isC0DecisionReceipt(receipt) || !isIsoDate(receipt.created_at) ||
      receipt.source_root.trim().length === 0 || receipt.decision.sourceRoot !== receipt.source_root) {
    throw new Error("invalid C0 decision receipt shape");
  }
}

function isDecision(value: unknown): value is C0ReuseDecision {
  return isRecord(value) && (value.action === "reuse" || value.action === "rebuild") &&
    typeof value.sourceRoot === "string" && Array.isArray(value.reasons) &&
    value.reasons.every(isReuseReason) && isCompatibilityIdentity(value.source) &&
    isCompatibilityIdentity(value.final) && isReplayClosure(value.replay);
}

function isCompatibilityIdentity(value: unknown): value is C0CacheCompatibilityIdentity {
  if (!isRecord(value)) return false;
  return compatibilityFields.every((field) => typeof value[field] === "string");
}

function isReplayClosure(value: unknown): value is C0ReplayClosure {
  if (!isRecord(value) || typeof value.ledgerSha256 !== "string") return false;
  return replayCountFields.every((field) => isNonnegativeInteger(value[field]));
}

function isReuseReason(value: unknown): value is C0ReuseReason {
  return typeof value === "string" && reuseReasons.has(value as C0ReuseReason);
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

const compatibilityFields: readonly (keyof C0CacheCompatibilityIdentity)[] = [
  "datasetRevision", "model", "modelFamily", "requestProfile", "providerUrl",
  "systemPromptSha256", "cacheKeyAlgorithm", "rawClosureSha256", "parserSemanticsSha256",
  "formationSemanticsSha256", "temporalSchemaRevision"
];

const replayCountFields: readonly (keyof Omit<C0ReplayClosure, "ledgerSha256">)[] = [
  "occurrenceCount", "accountedOccurrences", "elementCount", "accountedElements",
  "admitted", "deferred", "rejected", "invalid"
];

const reuseReasons = new Set<C0ReuseReason>([
  "dataset_revision_mismatch", "model_mismatch", "model_family_mismatch",
  "request_profile_mismatch", "provider_url_mismatch", "system_prompt_mismatch",
  "cache_key_algorithm_mismatch", "raw_closure_mismatch", "parser_semantics_mismatch",
  "formation_semantics_mismatch", "temporal_schema_mismatch", "raw_inventory_not_closed",
  "replay_not_closed"
]);
