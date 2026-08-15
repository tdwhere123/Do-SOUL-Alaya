import {
  existsSync, lstatSync, mkdirSync, unlinkSync
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cacheFilePath } from "../../../compile-seed/compile-seed-cache.js";
import { computeExtractionKeySetSha256 } from "../../content-closure.js";
import {
  extractionCacheManifestPath, readExtractionCacheManifestIdentity
} from "../../cache/extraction-cache-manifest.js";
import type { ExtractionCacheWriteLease } from
  "../../fill/manifest/fill-root-guard.js";
import {
  fsyncDirectory, linkFileExclusiveDurable
} from "../../fill/manifest/durable-exclusive-publication.js";
import {
  buildMaterializedTargetFillManifest,
  serializeMaterializedTargetFillManifest,
  writeNewMaterializedTargetFillManifest
} from
  "../../fill/manifest/fill-manifest.js";
import type { ExtractionCacheAuditReceipt } from "../receipt.js";
import type { ExtractionCacheInventory } from "../inventory.js";
import type { ExtractionTargetSelectionReceipt } from
  "../../authority/target-selection/receipt.js";
import { assertExtractionTargetSelectionRootBinding } from
  "../../authority/target-selection/receipt.js";
import {
  MATERIALIZATION_COMMIT_NAME, MATERIALIZATION_JOURNAL_NAME,
  MATERIALIZATION_STAGE_NAME, buildMaterializationCommit,
  buildMaterializationJournal, digest,
  writeExclusiveMaterializationRecord,
  type ExtractionCacheMaterializationCommit,
  type ExtractionCacheMaterializationJournal,
  type MaterializationBinding, type MaterializationShardDescriptor
} from "./contract.js";
import {
  readStableRegularFileNoFollow, writeAllExclusive
} from "./descriptor-io.js";
import { assertSourceStillBound, type MaterializationPreflight } from "./preflight.js";
import {
  assertExactTargetTree, assertFileMatches, assertRealDirectory,
  assertRecoverableStageFile, assertRecoverableTargetTree, isDescriptorMatch,
  readRecoverableStageFile, removeEmptyStage
} from "./target-tree.js";
import {
  readPersistedMaterializationTransaction,
  reconcileCommittedMaterializationJournal,
  type PersistedMaterializationTransaction
} from "./transaction-recovery.js";
import { triggerMaterializationTestSigkillAfter } from "./transaction-failpoint.js";

export function runMaterializationTransaction(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly auditReceipt: ExtractionCacheAuditReceipt;
  readonly inventory: ExtractionCacheInventory;
  readonly targetSelection: ExtractionTargetSelectionReceipt;
  readonly preflight: MaterializationPreflight;
  readonly sourceLease: ExtractionCacheWriteLease;
  readonly targetLease: ExtractionCacheWriteLease;
  readonly now: () => string;
}): ExtractionCacheMaterializationCommit {
  const targetRoot = input.targetLease.stableRootPath;
  const boundInput = {
    ...input,
    sourceRoot: input.sourceLease.stableRootPath,
    targetRoot
  };
  const persisted = readPersistedMaterializationTransaction(targetRoot);
  const createdAt = persisted.journal?.created_at ?? persisted.commit?.created_at ??
    requireTimestamp(input.now());
  const binding = materializationBinding(input, createdAt);
  const expectedJournal = buildMaterializationJournal({
    binding, createdAt
  });
  const committed = existingCommit(boundInput, binding, persisted);
  if (committed !== undefined) return committed;
  const journal = openOrResumeJournal(
    targetRoot, expectedJournal, binding, persisted.journal, dirname(input.targetRoot)
  );
  assertRecoverableTargetTree(targetRoot, journal.shards, journal.max_shard_bytes);
  assertRecoverableManifest(boundInput, journal);
  publishDescriptors(boundInput, journal);
  removeEmptyStage(targetRoot);
  assertExactTargetTree(
    targetRoot, binding.shards,
    existsSync(extractionCacheManifestPath(targetRoot)) ? "manifest" : "open"
  );
  const manifestSha256 = publishOrVerifyManifest(boundInput, journal, dirname(input.targetRoot));
  triggerMaterializationTestSigkillAfter("manifest-published");
  return commitMaterializationTransaction({
    input, binding, journal, manifestSha256, targetRoot
  });
}

function commitMaterializationTransaction(input: {
  readonly input: Parameters<typeof runMaterializationTransaction>[0];
  readonly binding: Omit<MaterializationBinding, "operation_id">;
  readonly journal: ExtractionCacheMaterializationJournal;
  readonly manifestSha256: string;
  readonly targetRoot: string;
}): ExtractionCacheMaterializationCommit {
  assertSourceStillBound({
    sourceRoot: input.input.sourceRoot,
    expectedManifestBytes: input.input.preflight.sourceManifestBytes,
    expectedManifestSha256: input.input.auditReceipt.source_manifest_sha256,
    expectedRoot: input.input.preflight.sourceIdentity,
    sourceLease: input.input.sourceLease
  });
  input.input.targetLease.assertOwned();
  assertExtractionTargetSelectionRootBinding(
    input.input.targetSelection, input.input.targetRoot, input.input.targetLease
  );
  assertExactTargetTree(input.targetRoot, input.binding.shards, "manifest");
  for (const descriptor of input.binding.shards) {
    assertFileMatches(
      cacheFilePath(input.targetRoot, descriptor.cache_key),
      descriptor,
      input.binding.max_shard_bytes
    );
  }
  const observedCommittedAt = requireTimestamp(input.input.now());
  const commit = buildMaterializationCommit({
    journal: input.journal,
    committedAt: timestampNotBefore(observedCommittedAt, input.journal.created_at),
    targetManifestSha256: input.manifestSha256
  });
  writeExclusiveMaterializationRecord(
    join(input.targetRoot, MATERIALIZATION_COMMIT_NAME), commit,
    dirname(input.input.targetRoot)
  );
  triggerMaterializationTestSigkillAfter("commit-published-before-journal-unlink");
  unlinkSync(join(input.targetRoot, MATERIALIZATION_JOURNAL_NAME));
  fsyncDirectory(input.targetRoot);
  triggerMaterializationTestSigkillAfter("journal-unlinked");
  assertExactTargetTree(input.targetRoot, input.binding.shards, "committed");
  return commit;
}

function timestampNotBefore(observed: string, lowerBound: string): string {
  return Date.parse(observed) < Date.parse(lowerBound) ? lowerBound : observed;
}

function materializationBinding(input: Parameters<typeof runMaterializationTransaction>[0],
  createdAt: string): Omit<MaterializationBinding, "operation_id"> {
  const descriptors = [...input.preflight.descriptors]
    .sort((left, right) => left.cache_key.localeCompare(right.cache_key));
  const materializedKeys = descriptors.map((descriptor) => descriptor.cache_key);
  const remainingKeys = [...input.preflight.remainingKeys]
    .sort((left, right) => left.localeCompare(right));
  const initialTargetManifest = buildMaterializedTargetFillManifest({
    sourceManifest: input.preflight.sourceManifest,
    targetSelection: input.targetSelection,
    expectedTurns: input.inventory.shards.length,
    cachedTurns: descriptors.length,
    expectedKeySetSha256: computeExtractionKeySetSha256(
      input.inventory.shards.map((shard) => shard.cacheKey)
    ),
    builtAt: createdAt
  });
  return Object.freeze({
    source_root_sha256: digest(input.sourceRoot),
    source_root_device: input.preflight.sourceIdentity.device,
    source_root_inode: input.preflight.sourceIdentity.inode,
    source_manifest_sha256: input.auditReceipt.source_manifest_sha256,
    source_manifest_bytes: input.preflight.sourceManifestBytes.byteLength,
    target_root_marker_sha256: input.targetSelection.target_root.cache_root_marker_sha256,
    audit_decision_digest: input.auditReceipt.decision_digest,
    occurrence_index_sha256: input.auditReceipt.occurrence_index_sha256,
    raw_inventory_sha256: input.auditReceipt.raw_inventory_sha256,
    target_selection_receipt_digest: input.targetSelection.receipt_digest,
    target_selection: input.targetSelection,
    expected_turns: input.inventory.shards.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(
      input.inventory.shards.map((shard) => shard.cacheKey)
    ),
    materialized_key_count: descriptors.length,
    materialized_key_set_sha256: computeExtractionKeySetSha256(materializedKeys),
    remaining_key_count: remainingKeys.length,
    remaining_key_set_sha256: computeExtractionKeySetSha256(remainingKeys),
    remaining_keys: Object.freeze(remainingKeys),
    materialized_content_sha256: digest(descriptors.map((descriptor) =>
      `${descriptor.cache_key}\0${descriptor.file_sha256}\0${descriptor.byte_length}`
    ).join("\n")),
    initial_target_manifest_sha256: digest(
      serializeMaterializedTargetFillManifest(initialTargetManifest)
    ),
    initial_target_manifest: Object.freeze(initialTargetManifest),
    max_shard_bytes: input.preflight.maxShardBytes,
    shards: Object.freeze(descriptors)
  });
}

function existingCommit(
  input: Parameters<typeof runMaterializationTransaction>[0],
  binding: Omit<MaterializationBinding, "operation_id">,
  persisted: PersistedMaterializationTransaction
): ExtractionCacheMaterializationCommit | undefined {
  const commit = persisted.commit;
  if (commit === undefined) return undefined;
  const expectedOperation = digest(JSON.stringify(binding));
  if (commit.operation_id !== expectedOperation || !matchesBinding(commit, binding)) {
    throw new Error("materialization commit belongs to a different operation");
  }
  verifyCommittedManifest(input.targetRoot, commit);
  for (const descriptor of commit.shards) {
    assertFileMatches(
      cacheFilePath(input.targetRoot, descriptor.cache_key),
      descriptor,
      commit.max_shard_bytes
    );
  }
  reconcileCommittedMaterializationJournal(input.targetRoot, commit, persisted.journal);
  assertExactTargetTree(input.targetRoot, binding.shards, "committed");
  return commit;
}

function openOrResumeJournal(
  targetRoot: string,
  expected: ExtractionCacheMaterializationJournal,
  binding: Omit<MaterializationBinding, "operation_id">,
  existing: ExtractionCacheMaterializationJournal | undefined,
  temporaryDirectory: string
): ExtractionCacheMaterializationJournal {
  const path = join(targetRoot, MATERIALIZATION_JOURNAL_NAME);
  if (existing === undefined) {
    assertExactTargetTree(targetRoot, binding.shards, "fresh");
    writeExclusiveMaterializationRecord(path, expected, temporaryDirectory);
    triggerMaterializationTestSigkillAfter("journal-published");
    return expected;
  }
  if (existing.operation_id !== expected.operation_id || !matchesBinding(existing, binding)) {
    throw new Error("materialization journal belongs to a different operation");
  }
  return existing;
}

function publishDescriptors(
  input: Parameters<typeof runMaterializationTransaction>[0],
  journal: ExtractionCacheMaterializationJournal
): void {
  const stageRoot = join(input.targetRoot, MATERIALIZATION_STAGE_NAME);
  if (!existsSync(stageRoot)) {
    mkdirSync(stageRoot, { mode: 0o700 });
    fsyncDirectory(input.targetRoot);
  }
  assertRealDirectory(stageRoot, "materialization stage");
  for (const descriptor of journal.shards) {
    const targetPath = cacheFilePath(input.targetRoot, descriptor.cache_key);
    const stagePath = join(stageRoot, `${descriptor.cache_key}.json`);
    if (existsSync(targetPath)) {
      assertFileMatches(targetPath, descriptor, journal.max_shard_bytes);
      if (existsSync(stagePath)) {
        assertRecoverableStageFile(stagePath, journal.max_shard_bytes);
        unlinkSync(stagePath);
        fsyncDirectory(stageRoot);
      }
      continue;
    }
    stageDescriptor(input.sourceRoot, stagePath, descriptor, journal.max_shard_bytes);
    const prefix = dirname(targetPath);
    if (!existsSync(prefix)) {
      mkdirSync(prefix);
      fsyncDirectory(input.targetRoot);
    }
    assertRealDirectory(prefix, "target shard prefix");
    linkFileExclusiveDurable(stagePath, targetPath);
    triggerMaterializationTestSigkillAfter("stage-entry-published");
    unlinkSync(stagePath);
    fsyncDirectory(stageRoot);
  }
}

function stageDescriptor(
  sourceRoot: string,
  stagePath: string,
  descriptor: MaterializationShardDescriptor,
  maxShardBytes: number
): void {
  if (existsSync(stagePath)) {
    const staged = readRecoverableStageFile(stagePath, maxShardBytes);
    if (isDescriptorMatch(staged.identity, descriptor)) return;
    unlinkSync(stagePath);
    fsyncDirectory(dirname(stagePath));
  }
  const source = readStableRegularFileNoFollow(
    cacheFilePath(sourceRoot, descriptor.cache_key), maxShardBytes
  );
  if (source.identity.sha256 !== descriptor.file_sha256 ||
      source.identity.byteLength !== descriptor.byte_length) {
    throw new Error("source shard changed after materialization journal creation");
  }
  writeAllExclusive(stagePath, source.bytes);
  assertFileMatches(stagePath, descriptor, maxShardBytes);
}

function publishOrVerifyManifest(
  input: Parameters<typeof runMaterializationTransaction>[0],
  journal: ExtractionCacheMaterializationJournal,
  temporaryDirectory: string
): string {
  const expected = expectedManifest(journal);
  const path = extractionCacheManifestPath(input.targetRoot);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("target manifest is a symlink");
    const identity = readExtractionCacheManifestIdentity(input.targetRoot);
    if (identity === undefined || !isDeepStrictEqual(identity.manifest, expected)) {
      throw new Error("existing target manifest does not match materialization journal");
    }
    return identity.manifestSha256;
  }
  return writeNewMaterializedTargetFillManifest(
    input.targetRoot, expected, journal.operation_id, temporaryDirectory
  );
}

function assertRecoverableManifest(
  input: Parameters<typeof runMaterializationTransaction>[0],
  journal: ExtractionCacheMaterializationJournal
): void {
  const path = extractionCacheManifestPath(input.targetRoot);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("target manifest is a symlink");
  const identity = readExtractionCacheManifestIdentity(input.targetRoot);
  if (identity === undefined || !isDeepStrictEqual(identity.manifest, expectedManifest(journal))) {
    throw new Error("existing target manifest does not match materialization journal");
  }
}

function expectedManifest(
  journal: ExtractionCacheMaterializationJournal
) {
  return journal.initial_target_manifest;
}

function verifyCommittedManifest(targetRoot: string, commit: ExtractionCacheMaterializationCommit) {
  const path = extractionCacheManifestPath(targetRoot);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("committed manifest is unsafe");
  const identity = readExtractionCacheManifestIdentity(targetRoot);
  if (identity?.manifestSha256 !== commit.target_manifest_sha256) {
    throw new Error("committed target manifest digest changed");
  }
}

function matchesBinding(
  actual: MaterializationBinding,
  expected: Omit<MaterializationBinding, "operation_id">
): boolean {
  return bindingFields.every((field) => isDeepStrictEqual(actual[field], expected[field]));
}

const bindingFields: readonly (keyof Omit<MaterializationBinding, "operation_id">)[] = [
  "source_root_sha256", "source_root_device", "source_root_inode",
  "source_manifest_sha256", "source_manifest_bytes", "target_root_marker_sha256",
  "audit_decision_digest", "occurrence_index_sha256", "raw_inventory_sha256",
  "target_selection_receipt_digest", "target_selection",
  "expected_turns", "expected_key_set_sha256", "materialized_key_count",
  "materialized_key_set_sha256", "remaining_key_count", "remaining_key_set_sha256",
  "remaining_keys", "materialized_content_sha256", "initial_target_manifest_sha256",
  "initial_target_manifest", "max_shard_bytes", "shards"
];

function requireTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("materialization time is invalid");
  return value;
}
