import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cacheFilePath } from "../../../compile-seed/compile-seed-cache.js";
import {
  buildExtractionContentClosureIndex, computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256
} from "../../content-closure.js";
import {
  extractionCacheManifestPath, readExtractionCacheManifestIdentity,
  type ExtractionCacheManifestV3
} from "../../cache/extraction-cache-manifest.js";
import {
  supplementalSourceManifestBinding
} from "../../cache/supplemental-source-receipt.js";
import { buildExtractionTransportProvenance } from "../../transport-route.js";
import { inspectExtractionCacheInventory } from "../inventory.js";
import { decodeCanonicalUtf8Artifact } from "../bounded-artifact-reader.js";
import type { ExtractionCacheWriteLease } from
  "../../fill/manifest/fill-root-guard.js";
import { isStableLeasePath } from "../../fill/manifest/fill-root-guard.js";
import { assertExtractionTargetSelectionRootBinding } from
  "../../authority/target-selection/receipt.js";
import { readSettledExtractionAttemptLedger } from
  "../../authority/attempt-ledger.js";
import {
  CATALOG_REFILL_COMPLETION_PREFIX, readCatalogRefillCompletionWitness
} from "../../authority/catalog-refill/completion-witness.js";
import {
  assertCatalogRefillRootBinding
} from "../../authority/catalog-refill/scope.js";
import { createExtractionPreservedValidClosure } from
  "../../authority/repair/preserved-valid-closure.js";
import {
  MATERIALIZATION_COMMIT_NAME, MATERIALIZATION_STAGE_NAME,
  digest, readMaterializationCommit,
  type ExtractionCacheMaterializationCommit
} from "./contract.js";
import { readStableRegularFileNoFollow } from "./descriptor-io.js";
import { assertExactTargetTree, assertFileMatches } from "./target-tree.js";
import { reconcileCommittedMaterializationJournal } from "./transaction-recovery.js";

const TARGET_MARKER = ".alaya-extraction-target-root.json";

export function verifyCommittedMaterializationSuccessor(input: {
  readonly targetRoot: string;
  readonly targetLease: ExtractionCacheWriteLease;
}): ExtractionCacheMaterializationCommit {
  input.targetLease.assertOwned();
  const targetRoot = input.targetLease.stableRootPath;
  assertNoMaterializationStage(targetRoot);
  const commit = readMaterializationCommit(
    join(targetRoot, MATERIALIZATION_COMMIT_NAME)
  );
  reconcileCommittedMaterializationJournal(targetRoot, commit);
  assertExtractionTargetSelectionRootBinding(commit.target_selection, input.targetRoot, input.targetLease);
  assertOriginShards(targetRoot, commit);
  const manifest = readSuccessorManifest(targetRoot);
  if (manifest.manifestSha256 === commit.target_manifest_sha256) {
    assertOriginState(targetRoot, commit, manifest.manifest);
    input.targetLease.assertOwned();
    return commit;
  }
  assertSuccessorManifest(commit, manifest.manifest, manifest.manifestSha256);
  const remainingProvenance = readRemainingShardProvenance(targetRoot, commit);
  const inventory = inspectExtractionCacheInventory({
    cacheRoot: targetRoot,
    cacheKeys: [...commit.shards.map((shard) => shard.cache_key), ...commit.remaining_keys],
    model: manifest.manifest.extraction_model,
    requestProfile: manifest.manifest.request_profile
  });
  assertClosedInventory(commit, inventory);
  const entries = contentEntries(commit, inventory);
  assertManifestClosure(manifest.manifest, entries);
  const witness = readCompletionWitness(targetRoot, inventory.controlArtifactPaths);
  assertCompletionManifest(witness, manifest.manifest, manifest.manifestSha256);
  assertCatalogAuthority(targetRoot, input.targetRoot, commit, witness, entries);
  assertSettledLedger(targetRoot, commit, witness, inventory);
  assertSupplementalProvenance(commit, manifest.manifest, witness, remainingProvenance);
  assertExpectedControls(targetRoot, input.targetRoot, witness, inventory.controlArtifactPaths);
  input.targetLease.assertOwned();
  return commit;
}

function assertOriginState(
  targetRoot: string,
  commit: ExtractionCacheMaterializationCommit,
  manifest: ExtractionCacheManifestV3
): void {
  if (!isDeepStrictEqual(manifest, commit.initial_target_manifest)) {
    throw new Error("committed origin manifest differs from its immutable witness");
  }
  assertExactTargetTree(targetRoot, commit.shards, "committed");
}

function assertCompletionManifest(
  witness: ReturnType<typeof readCompletionWitness>,
  manifest: ExtractionCacheManifestV3,
  manifestSha256: string
): void {
  if (witness.successor_manifest_sha256 !== manifestSha256 ||
      witness.successor_content_closure_sha256 !== manifest.content_closure_sha256 ||
      witness.completed_at !== manifest.built_at ||
      !isDeepStrictEqual(witness.successor_manifest, manifest)) {
    throw new Error("catalog refill completion witness differs from live successor manifest");
  }
}

function assertNoMaterializationStage(targetRoot: string): void {
  if (existsSync(join(targetRoot, MATERIALIZATION_STAGE_NAME))) {
    throw new Error("materialized successor contains an open transaction stage");
  }
}

function assertOriginShards(
  targetRoot: string,
  commit: ExtractionCacheMaterializationCommit
): void {
  for (const descriptor of commit.shards) {
    assertFileMatches(
      cacheFilePath(targetRoot, descriptor.cache_key), descriptor, commit.max_shard_bytes
    );
  }
}

function readSuccessorManifest(targetRoot: string): {
  readonly manifest: ExtractionCacheManifestV3;
  readonly manifestSha256: string;
} {
  const path = extractionCacheManifestPath(targetRoot);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (!isStableLeasePath(path) && realpathSync(path) !== path)) {
    throw new Error("materialized successor manifest is unsafe");
  }
  const identity = readExtractionCacheManifestIdentity(targetRoot);
  if (identity?.manifest.schema_version !== 3) {
    throw new Error("materialized successor requires a V3 manifest");
  }
  return { manifest: identity.manifest, manifestSha256: identity.manifestSha256 };
}

function assertSuccessorManifest(
  commit: ExtractionCacheMaterializationCommit,
  manifest: ExtractionCacheManifestV3,
  manifestSha256: string
): void {
  const initial = commit.initial_target_manifest;
  const fixedFields: readonly (keyof ExtractionCacheManifestV3)[] = [
    "schema_version", "extraction_model", "model_family", "request_profile",
    "provider_url", "system_prompt_sha256", "cache_key_algo", "dataset",
    "dataset_revision", "requested_turns", "window_offset", "window_limit",
    "expected_turns", "expected_key_set_sha256", "storage", "archive_url",
    "archive_sha256"
  ];
  if (!fixedFields.every((field) => isDeepStrictEqual(manifest[field], initial[field])) ||
      manifestSha256 === commit.target_manifest_sha256 || manifest.fill_status !== "complete" ||
      manifest.cached_turns !== commit.expected_turns || manifest.coverage !== 1 ||
      manifest.builder !== "extraction-fill" ||
      Date.parse(manifest.built_at) < Date.parse(initial.built_at)) {
    throw new Error("materialized successor manifest is not an authorized completed successor");
  }
}

function readRemainingShardProvenance(
  targetRoot: string,
  commit: ExtractionCacheMaterializationCommit
): readonly RemainingShardProvenance[] {
  return commit.remaining_keys.map((key) => {
    const path = cacheFilePath(targetRoot, key);
    if (!isStableLeasePath(path) && realpathSync(path) !== path) {
      throw new Error("successor shard path is not canonical");
    }
    const read = readStableRegularFileNoFollow(path, commit.max_shard_bytes);
    const parsed = JSON.parse(decodeCanonicalUtf8Artifact(
      read.bytes, `materialization successor shard ${key}`
    )) as Record<string, unknown>;
    if (parsed.cache_key !== key) throw new Error("successor shard identity is invalid");
    return Object.freeze({ cacheKey: key, transportProvenance: parsed.transport_provenance });
  });
}

interface RemainingShardProvenance {
  readonly cacheKey: string;
  readonly transportProvenance: unknown;
}

function assertClosedInventory(
  commit: ExtractionCacheMaterializationCommit,
  inventory: ReturnType<typeof inspectExtractionCacheInventory>
): void {
  if (inventory.counts.expected !== commit.expected_turns ||
      inventory.counts.hit !== commit.expected_turns || inventory.counts.missing !== 0 ||
      inventory.counts.invalid !== 0 || inventory.counts.orphan !== 0 ||
      inventory.unexpectedPaths.length !== 0 ||
      computeExtractionKeySetSha256(inventory.shards.map((shard) => shard.cacheKey)) !==
        commit.expected_key_set_sha256) {
    throw new Error("materialized successor inventory is not exactly complete");
  }
}

function contentEntries(
  commit: ExtractionCacheMaterializationCommit,
  inventory: ReturnType<typeof inspectExtractionCacheInventory>
) {
  return inventory.shards.map((shard) => {
    if (shard.status !== "hit" || shard.rawJsonSha256 === undefined ||
        shard.rawSignalCount === undefined || shard.parsedDraftCount === undefined) {
      throw new Error("materialized successor shard lacks strict content closure");
    }
    return {
      cacheKey: shard.cacheKey,
      model: commit.initial_target_manifest.extraction_model,
      requestProfile: commit.initial_target_manifest.request_profile,
      rawJsonSha256: shard.rawJsonSha256,
      rawSignalCount: shard.rawSignalCount,
      parsedDraftCount: shard.parsedDraftCount
    };
  });
}

function assertManifestClosure(
  manifest: ExtractionCacheManifestV3,
  entries: ReturnType<typeof contentEntries>
): void {
  if (manifest.content_closure_sha256 !== computeExtractionContentClosureSha256(entries) ||
      !isDeepStrictEqual(manifest.content_closure_index, buildExtractionContentClosureIndex(entries))) {
    throw new Error("materialized successor manifest content closure differs from its shards");
  }
}

function readCompletionWitness(
  targetRoot: string,
  controls: readonly string[]
) {
  const paths = controls.filter((path) => path.startsWith(CATALOG_REFILL_COMPLETION_PREFIX));
  if (paths.length !== 1) throw new Error("materialized successor completion witness is missing");
  return readCatalogRefillCompletionWitness(join(targetRoot, paths[0]!));
}

function assertCatalogAuthority(
  targetRoot: string,
  boundRootPath: string,
  commit: ExtractionCacheMaterializationCommit,
  witness: ReturnType<typeof readCompletionWitness>,
  entries: ReturnType<typeof contentEntries>
): void {
  const scope = witness.authority_receipt.catalog_refill;
  if (scope === undefined || !sameStrings(scope.keys, commit.remaining_keys) ||
      scope.shard_count !== commit.remaining_key_count ||
      scope.key_set_sha256 !== commit.remaining_key_set_sha256 ||
      scope.expected_key_set_sha256 !== commit.expected_key_set_sha256 ||
      scope.initial_manifest_sha256 !== commit.initial_target_manifest_sha256) {
    throw new Error("catalog refill authority does not exactly bind materialization remainder");
  }
  assertCatalogObservationIdentity(commit, witness.authority_receipt.observation);
  assertCatalogRefillRootBinding(scope.root_binding, boundRootPath);
  const origin = entries.filter((entry) =>
    commit.shards.some((descriptor) => descriptor.cache_key === entry.cacheKey)
  );
  if (scope.initial_raw_content_closure_sha256 !==
      computeExtractionContentClosureSha256(origin)) {
    throw new Error("catalog refill authority initial raw closure differs from origin shards");
  }
  if (!isDeepStrictEqual(scope.preserved_valid_closure,
    createExtractionPreservedValidClosure(origin))) {
    throw new Error("catalog refill authority preserved-valid closure differs from origin shards");
  }
}

function assertCatalogObservationIdentity(
  commit: ExtractionCacheMaterializationCommit,
  observation: ReturnType<typeof readCompletionWitness>["authority_receipt"]["observation"]
): void {
  const initial = commit.initial_target_manifest;
  const extraction = observation.extraction;
  const dataset = observation.dataset;
  if (extraction.manifestSha256 !== commit.initial_target_manifest_sha256 ||
      extraction.model !== initial.extraction_model ||
      extraction.modelFamily !== initial.model_family ||
      extraction.requestProfile !== initial.request_profile ||
      extraction.providerUrl !== initial.provider_url ||
      extraction.systemPromptSha256 !== initial.system_prompt_sha256 ||
      extraction.cacheKeyAlgorithm !== initial.cache_key_algo ||
      dataset.variant.replace(/_/u, "-") !== initial.dataset ||
      dataset.revisionSha256 !== initial.dataset_revision ||
      dataset.windowOffset !== initial.window_offset || dataset.windowLimit !== initial.window_limit ||
      dataset.expectedKeySetSha256 !== commit.expected_key_set_sha256) {
    throw new Error("catalog refill authority logical identity differs from materialization");
  }
}

function assertSettledLedger(
  targetRoot: string,
  commit: ExtractionCacheMaterializationCommit,
  witness: ReturnType<typeof readCompletionWitness>,
  inventory: ReturnType<typeof inspectExtractionCacheInventory>
): void {
  const ledger = readSettledExtractionAttemptLedger({
    cacheRoot: targetRoot,
    lineageDigest: witness.authority_receipt.lineage_digest,
    cacheIdentity: {
      model: commit.initial_target_manifest.extraction_model,
      requestProfile: commit.initial_target_manifest.request_profile
    }
  });
  const rows = ledger.successfulEntries.map((entry) => ({
    cache_key: entry.cacheKey,
    raw_json_sha256: entry.rawJsonSha256,
    success_kind: entry.successKind,
    ...(entry.successKind !== "provider" ? {} : {
      transport_provenance: entry.transportProvenance
    })
  }));
  if (witness.schema_version < 3 ||
      ledger.rawLedgerSha256 !== witness.ledger_raw_sha256 ||
      ledger.ledgerSha256 !== witness.ledger_sha256 ||
      !sameStrings(ledger.successfulKeys, commit.remaining_keys) ||
      ledger.pendingKeys.length !== 0 || ledger.unresolvedAttempts.length !== 0 ||
      ledger.successfulEntries.some((entry) => entry.successKind !== "provider") ||
      !isDeepStrictEqual(rows, witness.successful_shards)) {
    throw new Error("catalog refill settled ledger differs from its completion witness");
  }
  for (const row of rows) {
    const shard = inventory.shards.find((entry) => entry.cacheKey === row.cache_key);
    if (shard?.rawJsonSha256 !== row.raw_json_sha256) {
      throw new Error("catalog refill settled ledger raw digest differs from successor shard");
    }
  }
}

function assertSupplementalProvenance(
  commit: ExtractionCacheMaterializationCommit,
  manifest: ExtractionCacheManifestV3,
  witness: ReturnType<typeof readCompletionWitness>,
  shards: readonly RemainingShardProvenance[]
): void {
  if (witness.schema_version === 3) {
    assertDirectTransportProvenance(commit, manifest, witness, shards);
    return;
  }
  if (witness.schema_version !== 4) {
    throw new Error("catalog refill completion witness lacks typed success provenance");
  }
  const supplemental = witness.supplemental_source_receipt;
  const initial = commit.initial_target_manifest;
  const transport = witness.authority_receipt.observation.transport;
  if (supplemental === undefined || initial.supplemental_source_receipt !== undefined ||
      initial.storage === "archive" || transport === undefined ||
      !isDeepStrictEqual(manifest.supplemental_source_receipt,
        supplementalSourceManifestBinding(supplemental)) ||
      !isDeepStrictEqual(supplemental.logical_cache_identity, {
        provider_url: initial.provider_url, model: initial.extraction_model,
        request_profile: initial.request_profile,
        system_prompt_sha256: initial.system_prompt_sha256
      }) || supplemental.physical_source.provider_url !== transport.providerUrl ||
      supplemental.physical_source.model !== transport.model) {
    throw new Error("supplemental source provenance is not authorized by materialization");
  }
  const expected = buildExtractionTransportProvenance({
    providerUrl: initial.provider_url, model: initial.extraction_model,
    transportProviderUrl: supplemental.physical_source.provider_url,
    transportModel: supplemental.physical_source.model
  });
  assertExactShardTransport(shards, commit.remaining_keys, expected);
}

function assertDirectTransportProvenance(
  commit: ExtractionCacheMaterializationCommit,
  manifest: ExtractionCacheManifestV3,
  witness: ReturnType<typeof readCompletionWitness>,
  shards: readonly RemainingShardProvenance[]
): void {
  const initial = commit.initial_target_manifest;
  const transport = witness.authority_receipt.observation.transport;
  if (!isDeepStrictEqual(
    manifest.supplemental_source_receipt, initial.supplemental_source_receipt
  ) || witness.supplemental_source_receipt !== undefined ||
      (transport !== undefined && (transport.providerUrl !== initial.provider_url ||
        transport.model !== initial.extraction_model))) {
    throw new Error("direct successor transport differs from materialization identity");
  }
  const expected = buildExtractionTransportProvenance({
    providerUrl: initial.provider_url, model: initial.extraction_model
  });
  for (const [index, shard] of shards.entries()) {
    const row = witness.successful_shards[index];
    const validProvider = row?.success_kind === "provider" &&
      isDeepStrictEqual(row.transport_provenance, expected) &&
      isDeepStrictEqual(shard.transportProvenance, expected);
    const validDeterministic = row?.success_kind === "deterministic" &&
      row.transport_provenance === undefined && shard.transportProvenance === undefined;
    if (row?.cache_key !== shard.cacheKey || (!validProvider && !validDeterministic)) {
      throw new Error("direct successor shard success provenance is invalid");
    }
  }
}

function assertExactShardTransport(
  shards: readonly RemainingShardProvenance[],
  expectedKeys: readonly string[],
  expectedTransport: ReturnType<typeof buildExtractionTransportProvenance>
): void {
  if (!sameStrings(shards.map((shard) => shard.cacheKey), expectedKeys) ||
      shards.some((shard) => !isDeepStrictEqual(
        shard.transportProvenance, expectedTransport
      ))) {
    throw new Error("supplemental source shard transport provenance differs from authority");
  }
}

function assertExpectedControls(
  targetRoot: string,
  boundRootPath: string,
  witness: ReturnType<typeof readCompletionWitness>,
  controls: readonly string[]
): void {
  const expected = [
    TARGET_MARKER, MATERIALIZATION_COMMIT_NAME,
    `${CATALOG_REFILL_COMPLETION_PREFIX}${witness.authority_receipt.receipt_digest}.json`,
    `extraction-attempt-ledger.${witness.authority_receipt.lineage_digest}.json`
  ].sort();
  if (!sameStrings([...controls].sort(), expected) || digest(boundRootPath) !==
      witness.authority_receipt.catalog_refill?.root_binding.cache_root_sha256) {
    throw new Error("materialized successor contains unknown or mismatched control artifacts");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
