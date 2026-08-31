import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseExtractionCacheManifestContents,
  type ExtractionCacheManifestV3
} from "../../cache/extraction-cache-manifest.js";
import type { ExtractionTargetSelectionReceipt } from
  "../../authority/target-selection/receipt.js";
import { assertExtractionTargetSelectionReceiptIntegrity } from
  "../../authority/target-selection/receipt-shape.js";
import { publishBytesExclusiveDurable } from
  "../../fill/manifest/durable-exclusive-publication.js";
import { serializeMaterializedTargetFillManifest } from
  "../../fill/manifest/fill-manifest.js";
import { readBoundedCanonicalUtf8Artifact } from "../bounded-artifact-reader.js";

export const MATERIALIZATION_JOURNAL_NAME =
  ".alaya-extraction-cache-materialization-journal.json";
export const MATERIALIZATION_COMMIT_NAME =
  ".alaya-extraction-cache-materialization-commit.json";
export const MATERIALIZATION_STAGE_NAME =
  ".alaya-extraction-cache-materialization-stage";
export const MAX_MATERIALIZATION_CONTROL_BYTES = 32 * 1024 * 1024;
export const MAX_MATERIALIZATION_SHARD_BYTES = 128 * 1024;

export interface MaterializationShardDescriptor {
  readonly cache_key: string;
  readonly raw_json_sha256: string;
  readonly file_sha256: string;
  readonly byte_length: number;
}

export interface MaterializationBinding {
  readonly operation_id: string;
  readonly source_root_sha256: string;
  readonly source_root_device: string;
  readonly source_root_inode: string;
  readonly source_manifest_sha256: string;
  readonly source_manifest_bytes: number;
  readonly target_root_marker_sha256: string;
  readonly audit_decision_digest: string;
  readonly occurrence_index_sha256: string;
  readonly raw_inventory_sha256: string;
  readonly target_selection_receipt_digest: string;
  readonly target_selection: ExtractionTargetSelectionReceipt;
  readonly expected_turns: number;
  readonly expected_key_set_sha256: string;
  readonly materialized_key_count: number;
  readonly materialized_key_set_sha256: string;
  readonly remaining_key_count: number;
  readonly remaining_key_set_sha256: string;
  readonly remaining_keys: readonly string[];
  readonly materialized_content_sha256: string;
  readonly initial_target_manifest_sha256: string;
  readonly initial_target_manifest: ExtractionCacheManifestV3;
  readonly max_shard_bytes: number;
  readonly shards: readonly MaterializationShardDescriptor[];
}

export interface ExtractionCacheMaterializationJournal extends MaterializationBinding {
  readonly schema_version: 1;
  readonly kind: "longmemeval-extraction-cache-materialization-journal";
  readonly state: "publishing";
  readonly created_at: string;
  readonly journal_digest: string;
}

export interface ExtractionCacheMaterializationCommit extends MaterializationBinding {
  readonly schema_version: 1;
  readonly kind: "longmemeval-extraction-cache-materialization-commit";
  readonly state: "committed";
  readonly created_at: string;
  readonly committed_at: string;
  readonly journal_digest: string;
  readonly target_manifest_sha256: string;
  readonly commit_digest: string;
}

export function buildMaterializationJournal(input: {
  readonly binding: Omit<MaterializationBinding, "operation_id">;
  readonly createdAt: string;
}): ExtractionCacheMaterializationJournal {
  const operationId = digest(JSON.stringify(input.binding));
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval-extraction-cache-materialization-journal" as const,
    state: "publishing" as const,
    created_at: input.createdAt,
    operation_id: operationId,
    ...input.binding
  };
  return Object.freeze({ ...unsigned, journal_digest: digest(JSON.stringify(unsigned)) });
}

export function buildMaterializationCommit(input: {
  readonly journal: ExtractionCacheMaterializationJournal;
  readonly committedAt: string;
  readonly targetManifestSha256: string;
}): ExtractionCacheMaterializationCommit {
  const { schema_version: _schema, kind: _kind, state: _state,
    journal_digest: journalDigest, ...binding } = input.journal;
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval-extraction-cache-materialization-commit" as const,
    state: "committed" as const,
    ...binding,
    committed_at: input.committedAt,
    journal_digest: journalDigest,
    target_manifest_sha256: input.targetManifestSha256
  };
  return Object.freeze({ ...unsigned, commit_digest: digest(JSON.stringify(unsigned)) });
}

export function writeExclusiveMaterializationRecord(
  path: string,
  value: object & { readonly operation_id: string },
  temporaryDirectory: string = dirname(dirname(path))
): void {
  publishBytesExclusiveDurable({
    destination: path,
    bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    ownerIdentity: value.operation_id,
    temporaryDirectory
  });
}

export function readMaterializationRecord(path: string): unknown {
  const text = readBoundedCanonicalUtf8Artifact({
    path, maxBytes: MAX_MATERIALIZATION_CONTROL_BYTES,
    label: "materialization control record"
  });
  return JSON.parse(text) as unknown;
}

export function parseMaterializationCommit(value: unknown): ExtractionCacheMaterializationCommit {
  const commit = value as ExtractionCacheMaterializationCommit;
  if (!isRecord(value) || value.schema_version !== 1 ||
      value.kind !== "longmemeval-extraction-cache-materialization-commit" ||
      value.state !== "committed" || !isSha(value.commit_digest) ||
      !isSha(value.journal_digest) || !isSha(value.target_manifest_sha256) ||
      !hasExactFields(value, COMMIT_FIELDS) ||
      typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.committed_at !== "string" ||
      !Number.isFinite(Date.parse(value.committed_at)) ||
      Date.parse(value.committed_at) < Date.parse(value.created_at)) {
    throw new Error("invalid extraction cache materialization commit");
  }
  const { commit_digest: _digest, ...unsigned } = commit;
  if (digest(JSON.stringify(unsigned)) !== commit.commit_digest) {
    throw new Error("extraction cache materialization commit digest is invalid");
  }
  assertBinding(commit);
  const canonicalJournal = canonicalMaterializationJournalForCommit(commit);
  if (commit.journal_digest !== canonicalJournal.journal_digest) {
    throw new Error("extraction cache materialization commit journal digest is invalid");
  }
  return Object.freeze(commit);
}

export function canonicalMaterializationJournalForCommit(
  commit: ExtractionCacheMaterializationCommit
): ExtractionCacheMaterializationJournal {
  return buildMaterializationJournal({
    binding: operationPayload(commit), createdAt: commit.created_at
  });
}

export function parseMaterializationJournal(value: unknown):
ExtractionCacheMaterializationJournal {
  const journal = value as ExtractionCacheMaterializationJournal;
  if (!isRecord(value) || value.schema_version !== 1 ||
      value.kind !== "longmemeval-extraction-cache-materialization-journal" ||
      value.state !== "publishing" || !isSha(value.journal_digest) ||
      !hasExactFields(value, JOURNAL_FIELDS) ||
      typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error("invalid extraction cache materialization journal");
  }
  const { journal_digest: _digest, ...unsigned } = journal;
  if (digest(JSON.stringify(unsigned)) !== journal.journal_digest) {
    throw new Error("materialization journal digest is invalid");
  }
  assertBinding(journal);
  return Object.freeze(journal);
}

export function readMaterializationCommit(path: string): ExtractionCacheMaterializationCommit {
  return parseMaterializationCommit(readMaterializationRecord(path));
}

export function hasValidMaterializationCommit(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    readMaterializationCommit(path);
    return true;
  } catch {
    return false;
  }
}

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBinding(value: MaterializationBinding): void {
  const digests = [
    value.operation_id, value.source_root_sha256, value.source_manifest_sha256,
    value.target_root_marker_sha256, value.audit_decision_digest,
    value.occurrence_index_sha256, value.raw_inventory_sha256,
    value.target_selection_receipt_digest, value.initial_target_manifest_sha256,
    value.expected_key_set_sha256, value.materialized_key_set_sha256,
    value.remaining_key_set_sha256, value.materialized_content_sha256
  ];
  const counts = [
    value.source_manifest_bytes, value.expected_turns, value.materialized_key_count,
    value.remaining_key_count, value.max_shard_bytes
  ];
  if (!digests.every(isSha) || !counts.every(isCount) || value.max_shard_bytes === 0 ||
      value.max_shard_bytes > MAX_MATERIALIZATION_SHARD_BYTES ||
      !isIntegerString(value.source_root_device) || !isIntegerString(value.source_root_inode) ||
      !Array.isArray(value.shards) || value.shards.length !== value.materialized_key_count ||
      !value.shards.every(isDescriptor) || !Array.isArray(value.remaining_keys)) {
    throw new Error("invalid extraction cache materialization binding");
  }
  const keys = value.shards.map((shard) => shard.cache_key);
  const sortedKeys = [...new Set(keys)].sort((left, right) => left.localeCompare(right));
  const remainingKeys = [...new Set(value.remaining_keys)]
    .sort((left, right) => left.localeCompare(right));
  const contentDigest = digest(value.shards.map((shard) =>
    `${shard.cache_key}\0${shard.file_sha256}\0${shard.byte_length}`
  ).join("\n"));
  if (!sameStrings(keys, sortedKeys) || keySetDigest(keys) !== value.materialized_key_set_sha256 ||
      !sameStrings(value.remaining_keys, remainingKeys) ||
      value.remaining_keys.length !== value.remaining_key_count ||
      keySetDigest(value.remaining_keys) !== value.remaining_key_set_sha256 ||
      keys.some((key) => remainingKeys.includes(key)) ||
      keys.length + remainingKeys.length !== value.expected_turns ||
      keySetDigest([...keys, ...remainingKeys]) !== value.expected_key_set_sha256 ||
      contentDigest !== value.materialized_content_sha256 ||
      value.shards.some((shard) => shard.byte_length > value.max_shard_bytes) ||
      digest(JSON.stringify(operationPayload(value))) !== value.operation_id) {
    throw new Error("extraction cache materialization binding is inconsistent");
  }
  assertWitnesses(value);
}

function operationPayload(value: MaterializationBinding): Omit<MaterializationBinding, "operation_id"> {
  return {
    source_root_sha256: value.source_root_sha256,
    source_root_device: value.source_root_device,
    source_root_inode: value.source_root_inode,
    source_manifest_sha256: value.source_manifest_sha256,
    source_manifest_bytes: value.source_manifest_bytes,
    target_root_marker_sha256: value.target_root_marker_sha256,
    audit_decision_digest: value.audit_decision_digest,
    occurrence_index_sha256: value.occurrence_index_sha256,
    raw_inventory_sha256: value.raw_inventory_sha256,
    target_selection_receipt_digest: value.target_selection_receipt_digest,
    target_selection: value.target_selection,
    expected_turns: value.expected_turns,
    expected_key_set_sha256: value.expected_key_set_sha256,
    materialized_key_count: value.materialized_key_count,
    materialized_key_set_sha256: value.materialized_key_set_sha256,
    remaining_key_count: value.remaining_key_count,
    remaining_key_set_sha256: value.remaining_key_set_sha256,
    remaining_keys: value.remaining_keys,
    materialized_content_sha256: value.materialized_content_sha256,
    initial_target_manifest_sha256: value.initial_target_manifest_sha256,
    initial_target_manifest: value.initial_target_manifest,
    max_shard_bytes: value.max_shard_bytes,
    shards: value.shards
  };
}

function assertWitnesses(value: MaterializationBinding): void {
  assertExtractionTargetSelectionReceiptIntegrity(value.target_selection);
  const parsed = parseExtractionCacheManifestContents(
    JSON.stringify(value.initial_target_manifest), "materialization initial target manifest"
  );
  const manifest = value.initial_target_manifest;
  const selection = value.target_selection;
  if (parsed.schema_version !== 3 || !isDeepStrictEqual(parsed, manifest) ||
      digest(serializeMaterializedTargetFillManifest(manifest)) !==
        value.initial_target_manifest_sha256 ||
      selection.receipt_digest !== value.target_selection_receipt_digest ||
      selection.target_root.cache_root_marker_sha256 !== value.target_root_marker_sha256 ||
      manifest.expected_turns !== value.expected_turns ||
      manifest.expected_key_set_sha256 !== value.expected_key_set_sha256 ||
      manifest.cached_turns !== value.materialized_key_count ||
      manifest.fill_status !== "in_progress" ||
      selection.selection_basis.kind !== "cache_audit" ||
      selection.selection_basis.audit_decision_digest !== value.audit_decision_digest ||
      selection.initial_selection.expected_turns !== value.expected_turns ||
      selection.initial_selection.key_digest !== value.expected_key_set_sha256 ||
      manifest.window_offset !== selection.initial_selection.offset ||
      manifest.window_limit !== selection.initial_selection.limit ||
      manifest.dataset !== selection.final_identity.dataset_variant.replace(/_/u, "-") ||
      manifest.dataset_revision !== selection.final_identity.dataset_revision_sha256 ||
      manifest.extraction_model !== selection.final_identity.model ||
      manifest.model_family !== selection.final_identity.model_family ||
      manifest.request_profile !== selection.final_identity.request_profile ||
      manifest.provider_url !== selection.final_identity.provider_url ||
      manifest.system_prompt_sha256 !== selection.final_identity.system_prompt_sha256 ||
      manifest.cache_key_algo !== selection.final_identity.cache_key_algorithm) {
    throw new Error("extraction cache materialization witnesses are inconsistent");
  }
}

function isDescriptor(value: unknown): value is MaterializationShardDescriptor {
  return isRecord(value) && isSha(value.cache_key) && isSha(value.raw_json_sha256) &&
    isSha(value.file_sha256) && isCount(value.byte_length) &&
    hasExactFields(value, SHARD_DESCRIPTOR_FIELDS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value);
}

function keySetDigest(keys: readonly string[]): string {
  return digest([...new Set(keys)].sort((left, right) => left.localeCompare(right)).join("\n"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[]
): boolean {
  return sameStrings(Object.keys(value).sort(), [...fields].sort());
}

const JOURNAL_FIELDS = [
  "schema_version", "kind", "state", "created_at", "operation_id",
  "source_root_sha256", "source_root_device", "source_root_inode",
  "source_manifest_sha256", "source_manifest_bytes", "target_root_marker_sha256",
  "audit_decision_digest", "occurrence_index_sha256", "raw_inventory_sha256",
  "target_selection_receipt_digest", "target_selection",
  "expected_turns", "expected_key_set_sha256", "materialized_key_count",
  "materialized_key_set_sha256", "remaining_key_count", "remaining_key_set_sha256",
  "remaining_keys", "materialized_content_sha256", "initial_target_manifest_sha256",
  "initial_target_manifest", "max_shard_bytes", "shards", "journal_digest"
] as const;

const COMMIT_FIELDS = [
  "schema_version", "kind", "state", "created_at", "operation_id",
  "source_root_sha256", "source_root_device", "source_root_inode",
  "source_manifest_sha256", "source_manifest_bytes", "target_root_marker_sha256",
  "audit_decision_digest", "occurrence_index_sha256", "raw_inventory_sha256",
  "target_selection_receipt_digest", "target_selection",
  "expected_turns", "expected_key_set_sha256", "materialized_key_count",
  "materialized_key_set_sha256", "remaining_key_count", "remaining_key_set_sha256",
  "remaining_keys", "materialized_content_sha256", "initial_target_manifest_sha256",
  "initial_target_manifest", "max_shard_bytes", "shards", "committed_at",
  "journal_digest", "target_manifest_sha256", "commit_digest"
] as const;

const SHARD_DESCRIPTOR_FIELDS = [
  "cache_key", "raw_json_sha256", "file_sha256", "byte_length"
] as const;
