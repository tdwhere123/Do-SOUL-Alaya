import { digest, type ExtractionCacheMaterializationCommit } from "./contract.js";
import { readBoundedCanonicalUtf8Artifact } from "../bounded-artifact-reader.js";

const MAX_MATERIALIZATION_RECEIPT_BYTES = 64 * 1024;

export interface ExtractionCacheMaterializationReceipt {
  readonly schema_version: 1;
  readonly kind: "longmemeval-extraction-cache-materialization";
  readonly created_at: string;
  readonly source_root_sha256: string;
  readonly target_root_marker_sha256: string;
  readonly audit_decision_digest: string;
  readonly raw_inventory_sha256: string;
  readonly target_selection_receipt_digest: string;
  readonly materialized_key_count: number;
  readonly materialized_key_set_sha256: string;
  readonly materialized_content_sha256: string;
  readonly max_shard_bytes: number;
  readonly materialization_commit_digest: string;
  readonly receipt_digest: string;
}

export function materializationReceiptFromCommit(
  commit: ExtractionCacheMaterializationCommit
): ExtractionCacheMaterializationReceipt {
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval-extraction-cache-materialization" as const,
    created_at: commit.committed_at,
    source_root_sha256: commit.source_root_sha256,
    target_root_marker_sha256: commit.target_root_marker_sha256,
    audit_decision_digest: commit.audit_decision_digest,
    raw_inventory_sha256: commit.raw_inventory_sha256,
    target_selection_receipt_digest: commit.target_selection_receipt_digest,
    materialized_key_count: commit.materialized_key_count,
    materialized_key_set_sha256: commit.materialized_key_set_sha256,
    materialized_content_sha256: commit.materialized_content_sha256,
    max_shard_bytes: commit.max_shard_bytes,
    materialization_commit_digest: commit.commit_digest
  };
  return Object.freeze({ ...unsigned, receipt_digest: digest(JSON.stringify(unsigned)) });
}

export function readExtractionCacheMaterializationReceipt(
  path: string
): ExtractionCacheMaterializationReceipt {
  const value = JSON.parse(readBoundedCanonicalUtf8Artifact({
    path,
    maxBytes: MAX_MATERIALIZATION_RECEIPT_BYTES,
    label: "extraction cache materialization receipt"
  })) as unknown;
  if (!isMaterializationReceipt(value)) {
    throw new Error("invalid extraction cache materialization receipt");
  }
  const { receipt_digest: _receiptDigest, ...unsigned } = value;
  if (value.receipt_digest !== digest(JSON.stringify(unsigned))) {
    throw new Error("extraction cache materialization receipt digest is invalid");
  }
  return Object.freeze(value);
}

function isMaterializationReceipt(value: unknown): value is ExtractionCacheMaterializationReceipt {
  if (!isRecord(value) || value.schema_version !== 1 ||
      value.kind !== "longmemeval-extraction-cache-materialization" ||
      typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
    return false;
  }
  const digests = [
    value.source_root_sha256, value.target_root_marker_sha256,
    value.audit_decision_digest, value.raw_inventory_sha256,
    value.target_selection_receipt_digest, value.materialized_key_set_sha256,
    value.materialized_content_sha256, value.materialization_commit_digest,
    value.receipt_digest
  ];
  return digests.every(isSha256) && isCount(value.materialized_key_count) &&
    isCount(value.max_shard_bytes) && Object.keys(value).length === 14;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
