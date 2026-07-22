import { createHash } from "node:crypto";
import type {
  ExtractionTargetFinalIdentity,
  ExtractionTargetInitialSelection,
  ExtractionTargetRootBinding,
  ExtractionTargetSelectionBasis,
  ExtractionTargetSelectionReceipt
} from "./receipt.js";

export function assertExtractionTargetSelectionReceiptIntegrity(
  value: unknown
): asserts value is ExtractionTargetSelectionReceipt {
  if (!isReceipt(value)) throw new Error("invalid extraction target selection receipt");
  if (value.receipt_digest !== digestExtractionTargetSelectionReceipt(
    withoutDigest(value)
  )) {
    throw new Error("extraction target selection receipt digest is invalid");
  }
}

export function digestExtractionTargetSelectionReceipt(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function withoutDigest(
  receipt: ExtractionTargetSelectionReceipt
): Omit<ExtractionTargetSelectionReceipt, "receipt_digest"> {
  const { receipt_digest: _receiptDigest, ...unsigned } = receipt;
  return unsigned;
}

function isReceipt(value: unknown): value is ExtractionTargetSelectionReceipt {
  if (!isRecord(value) || value.schema_version !== 2 ||
      value.kind !== "longmemeval-extraction-target-selection" ||
      !isIsoDate(value.created_at) || !isSelectionBasis(value.selection_basis) ||
      !isTargetRootBinding(value.target_root) || !isFinalIdentity(value.final_identity) ||
      !isInitialSelection(value.initial_selection) || !isSha256(value.receipt_digest)) return false;
  return true;
}

function isSelectionBasis(value: unknown): value is ExtractionTargetSelectionBasis {
  if (!isRecord(value)) return false;
  if (value.kind === "cache_audit") return isSha256(value.audit_decision_digest);
  if (value.kind === "same_root_continuation") {
    return isSha256(value.predecessor_target_selection_digest) &&
      isSha256(value.predecessor_authority_receipt_digest);
  }
  return value.kind === "retired_source_rebuild" && typeof value.operator === "string" &&
    value.operator.trim().length > 0 && value.operator.length <= 256;
}

function isTargetRootBinding(value: unknown): value is ExtractionTargetRootBinding {
  return isRecord(value) && isSha256(value.cache_root_sha256) &&
    isNonnegativeIntegerString(value.cache_root_device) &&
    isNonnegativeIntegerString(value.cache_root_inode) &&
    isSha256(value.cache_root_marker_sha256);
}

function isFinalIdentity(value: unknown): value is ExtractionTargetFinalIdentity {
  return isRecord(value) && typeof value.revision === "string" &&
    typeof value.dataset_variant === "string" && isSha256(value.dataset_revision_sha256) &&
    typeof value.model === "string" && typeof value.model_family === "string" &&
    typeof value.request_profile === "string" && typeof value.provider_url === "string" &&
    isSha256(value.system_prompt_sha256) && typeof value.cache_key_algorithm === "string";
}

function isInitialSelection(value: unknown): value is ExtractionTargetInitialSelection {
  return isRecord(value) && isSha256(value.selection_digest) && isSha256(value.key_digest) &&
    isNonnegativeInteger(value.offset) && isNonnegativeInteger(value.limit) &&
    isNonnegativeInteger(value.expected_turns);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value);
}
