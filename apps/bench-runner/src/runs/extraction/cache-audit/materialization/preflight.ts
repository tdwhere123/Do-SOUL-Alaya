import { lstatSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { computeExtractionKeySetSha256 } from
  "../../content-closure.js";
import { parseExtractionCacheManifestContents, type ExtractionCacheManifestV3 } from
  "../../cache/extraction-cache-manifest.js";
import type { ExtractionCacheWriteLease } from
  "../../fill/manifest/fill-root-guard.js";
import {
  assertExtractionTargetSelectionRootBinding,
  type ExtractionTargetSelectionReceipt
} from "../../authority/target-selection/receipt.js";
import { assertExtractionTargetSelectionReceiptIntegrity } from
  "../../authority/target-selection/receipt-shape.js";
import { decideExtractionCacheCompatibility } from "../compatibility.js";
import {
  hashExtractionCacheInventory, type ExtractionCacheInventory
} from "../inventory.js";
import { buildExtractionCacheAuditReceipt, type ExtractionCacheAuditReceipt } from
  "../receipt.js";
import {
  digest, MAX_MATERIALIZATION_SHARD_BYTES, type MaterializationShardDescriptor
} from "./contract.js";
import { matchStableRegularFileNoFollow } from "./descriptor-io.js";
import { inspectBoundedMaterializationInventory } from "./preflight-inventory.js";
import { isStableLeasePath } from "../../fill/manifest/fill-root-guard.js";
import { isPhysicalNamedPath } from "../../../fs/opened-contained-path.js";

export const DEFAULT_MAX_SHARD_BYTES = MAX_MATERIALIZATION_SHARD_BYTES;
export const MAX_SOURCE_MANIFEST_BYTES = 32 * 1024 * 1024;

export interface MaterializationPreflight {
  readonly sourceManifest: ExtractionCacheManifestV3;
  readonly sourceManifestBytes: Buffer;
  readonly sourceIdentity: { readonly device: string; readonly inode: string };
  readonly descriptors: readonly MaterializationShardDescriptor[];
  readonly remainingKeys: readonly string[];
  readonly maxShardBytes: number;
}

export function preflightMaterialization(input: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly auditReceipt: ExtractionCacheAuditReceipt;
  readonly inventory: ExtractionCacheInventory;
  readonly targetSelection: ExtractionTargetSelectionReceipt;
  readonly auditedSourceManifestRaw: string;
  readonly maxShardBytes?: number;
  readonly sourceLease: ExtractionCacheWriteLease;
  readonly targetLease: ExtractionCacheWriteLease;
}): MaterializationPreflight {
  assertCanonicalRoots(input.sourceRoot, input.targetRoot);
  input.sourceLease.assertOwned();
  input.targetLease.assertOwned();
  const sourcePath = input.sourceLease.stableRootPath;
  if (input.sourceRoot !== input.auditReceipt.source_root) {
    throw new Error("source root does not exactly match cache audit authority");
  }
  const sourceIdentity = rootIdentity(sourcePath);
  const manifest = auditedManifest(input);
  const maxShardBytes = resolveMaxShardBytes(input.maxShardBytes);
  const inspected = inspectBoundedMaterializationInventory({
    sourceRoot: sourcePath, audited: input.inventory,
    model: manifest.extraction_model, requestProfile: manifest.request_profile,
    maxShardBytes
  });
  const inventory = liveInventory(input, inspected.inventory);
  assertAudit(input.auditReceipt, inventory);
  assertSelection(input, manifest, inventory);
  const remainingKeys = inventory.shards.filter((shard) => shard.status !== "hit")
    .map((shard) => shard.cacheKey);
  return Object.freeze({
    sourceManifest: manifest,
    sourceManifestBytes: Buffer.from(input.auditedSourceManifestRaw, "utf8"),
    sourceIdentity,
    descriptors: inspected.descriptors,
    remainingKeys: Object.freeze(remainingKeys),
    maxShardBytes
  });
}

export function assertSourceStillBound(input: {
  readonly sourceRoot: string;
  readonly expectedManifestBytes: Uint8Array;
  readonly expectedManifestSha256: string;
  readonly expectedRoot: MaterializationPreflight["sourceIdentity"];
  readonly sourceLease: ExtractionCacheWriteLease;
}): void {
  input.sourceLease.assertOwned();
  const root = rootIdentity(input.sourceLease.stableRootPath);
  if (!isDeepStrictEqual(root, input.expectedRoot)) throw new Error("source root changed");
  const live = matchStableRegularFileNoFollow(
    `${input.sourceLease.stableRootPath}/manifest.json`,
    input.expectedManifestBytes, MAX_SOURCE_MANIFEST_BYTES
  );
  if (live.sha256 !== input.expectedManifestSha256) {
    throw new Error("live source manifest digest changed since audit");
  }
}

function auditedManifest(
  input: Parameters<typeof preflightMaterialization>[0]
): ExtractionCacheManifestV3 {
  const bytes = Buffer.from(input.auditedSourceManifestRaw, "utf8");
  if (bytes.byteLength > MAX_SOURCE_MANIFEST_BYTES ||
      digest(bytes) !== input.auditReceipt.source_manifest_sha256) {
    throw new Error("audited source manifest does not match the cache audit receipt");
  }
  const parsed = parseExtractionCacheManifestContents(
    input.auditedSourceManifestRaw, "audited source manifest"
  );
  if (parsed.schema_version !== 3) throw new Error("materialization requires a V3 source manifest");
  const live = matchStableRegularFileNoFollow(
    `${input.sourceLease.stableRootPath}/manifest.json`, bytes, MAX_SOURCE_MANIFEST_BYTES
  );
  if (live.sha256 !== input.auditReceipt.source_manifest_sha256) {
    throw new Error("live source manifest changed since audit");
  }
  return parsed;
}

function liveInventory(
  input: Parameters<typeof preflightMaterialization>[0],
  live: ExtractionCacheInventory
): ExtractionCacheInventory {
  if (!isDeepStrictEqual(live, input.inventory) ||
      hashExtractionCacheInventory(live) !== input.auditReceipt.raw_inventory_sha256) {
    throw new Error("live source inventory changed since cache audit");
  }
  return live;
}

function assertAudit(
  receipt: ExtractionCacheAuditReceipt,
  inventory: ExtractionCacheInventory
): void {
  const decision = receipt.decision;
  const recomputed = decideExtractionCacheCompatibility({
    sourceRoot: receipt.source_root,
    source: { raw: decision.raw.source, projection: decision.projection.source },
    final: { raw: decision.raw.final, projection: decision.projection.final },
    replay: decision.projection.replay,
    rawInventoryClosed: isInventoryClosed(inventory),
    retiredSourceKeys: inventory.retiredKeys
  });
  const rebuilt = buildExtractionCacheAuditReceipt({
    createdAt: receipt.created_at, sourceRoot: receipt.source_root,
    sourceManifestSha256: receipt.source_manifest_sha256,
    rawInventorySha256: receipt.raw_inventory_sha256,
    occurrenceIndexSha256: receipt.occurrence_index_sha256, decision: receipt.decision
  });
  if (!isDeepStrictEqual(decision, recomputed) || !isDeepStrictEqual(receipt, rebuilt)) {
    throw new Error("cache audit receipt integrity is invalid");
  }
  if (decision.raw.action !== "rebuild" || decision.projection.action === "blocked") {
    throw new Error("cache materialization requires an unblocked rebuild audit");
  }
}

function assertSelection(
  input: Parameters<typeof preflightMaterialization>[0],
  manifest: ExtractionCacheManifestV3,
  inventory: ExtractionCacheInventory
): void {
  const selection = input.targetSelection;
  assertExtractionTargetSelectionReceiptIntegrity(selection);
  if (selection.selection_basis.kind !== "cache_audit" ||
      selection.selection_basis.audit_decision_digest !== input.auditReceipt.decision_digest) {
    throw new Error("target selection does not bind this cache audit");
  }
  const keys = inventory.shards.map((shard) => shard.cacheKey);
  if (keys.length !== selection.initial_selection.expected_turns ||
      computeExtractionKeySetSha256(keys) !== selection.initial_selection.key_digest) {
    throw new Error("cache inventory does not match target selection key authority");
  }
  assertIdentityBindings(input.auditReceipt, selection, manifest);
  input.targetLease.assertOwned();
  assertExtractionTargetSelectionRootBinding(selection, input.targetRoot, input.targetLease);
}

function assertIdentityBindings(
  audit: ExtractionCacheAuditReceipt,
  selection: ExtractionTargetSelectionReceipt,
  manifest: ExtractionCacheManifestV3
): void {
  const source = audit.decision.raw.source;
  const final = audit.decision.raw.final;
  const selected = selection.final_identity;
  const sourceValues = [
    manifest.dataset_revision, manifest.extraction_model, manifest.request_profile,
    manifest.provider_url, manifest.system_prompt_sha256, manifest.cache_key_algo
  ];
  const auditedValues = [
    source.datasetRevision, source.model, source.requestProfile, source.providerUrl,
    source.systemPromptSha256, source.cacheKeyAlgorithm
  ];
  const finalValues = [
    selected.dataset_revision_sha256, selected.model, selected.request_profile,
    selected.provider_url, selected.system_prompt_sha256, selected.cache_key_algorithm
  ];
  const expectedFinal = [
    final.datasetRevision, final.model, final.requestProfile, final.providerUrl,
    final.systemPromptSha256, final.cacheKeyAlgorithm
  ];
  const providerValues = [
    manifest.provider_url, source.providerUrl, final.providerUrl, selected.provider_url
  ];
  if (new Set(providerValues).size !== 1) {
    throw new Error(
      "logical provider identity differs across source, audit, and target; " +
      "physical supplier changes must use a transport override or supplemental source receipt"
    );
  }
  if (!isDeepStrictEqual(sourceValues, auditedValues) ||
      !isDeepStrictEqual(finalValues, expectedFinal) ||
      !isDeepStrictEqual(auditedValues.slice(1), expectedFinal.slice(1)) ||
      manifest.model_family !== selection.final_identity.model_family ||
      selection.final_identity.model_family !== audit.decision.projection.final.modelFamily) {
    throw new Error("source manifest and target selection identity differ from cache audit");
  }
}

function assertCanonicalRoots(sourceRoot: string, targetRoot: string): void {
  for (const root of [sourceRoot, targetRoot]) {
    const stat = lstatSync(root);
    if (resolve(root) !== root || !isPhysicalNamedPath(root) ||
        !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("materialization roots must be canonical non-symlink directories");
    }
  }
  if (sourceRoot === targetRoot) throw new Error("source and target roots must differ");
}

function rootIdentity(root: string): { readonly device: string; readonly inode: string } {
  const stat = isStableLeasePath(root)
    ? statSync(root, { bigint: true })
    : lstatSync(root, { bigint: true });
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() });
}

function resolveMaxShardBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_SHARD_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 ||
      resolved > MAX_MATERIALIZATION_SHARD_BYTES) {
    throw new Error("maxShardBytes must be a positive integer at or below the 128 KiB ceiling");
  }
  return resolved;
}

function isInventoryClosed(inventory: ExtractionCacheInventory): boolean {
  const counts = inventory.counts;
  return counts.hit === counts.expected && counts.missing === 0 && counts.invalid === 0 &&
    counts.orphan === 0 && inventory.unexpectedPaths.length === 0;
}
