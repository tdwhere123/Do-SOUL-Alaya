import { createHash } from "node:crypto";
import {
  mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheFilePath } from
  "../../../longmemeval/compile-seed/compile-seed-cache.js";
import { computeExtractionKeySetSha256 } from
  "../../../longmemeval/extraction/content-closure.js";
import {
  hashExtractionCacheInventory,
  inspectExtractionCacheInventory
} from "../../../longmemeval/extraction/cache-audit/inventory.js";
import { buildExtractionCacheAuditReceipt } from
  "../../../longmemeval/extraction/cache-audit/receipt.js";
import { materializeAuditedExtractionCacheTarget } from
  "../../../longmemeval/extraction/cache-audit/target-materializer.js";
import {
  MATERIALIZATION_JOURNAL_NAME,
  buildMaterializationJournal,
  digest,
  writeExclusiveMaterializationRecord
} from "../../../longmemeval/extraction/cache-audit/materialization/contract.js";
import { createFreshExtractionTargetSelectionRoot } from
  "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import { digestExtractionTargetSelectionReceipt } from
  "../../../longmemeval/extraction/authority/target-selection/receipt-shape.js";
import {
  buildMaterializedTargetFillManifest,
  serializeMaterializedTargetFillManifest
} from "../../../longmemeval/extraction/fill/manifest/fill-manifest.js";
import { parseExtractionCacheManifestContents } from
  "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";

export const model = "gpt-5.4-mini";
export const requestProfile = "provider-default-v1" as const;
export const targetMarkerName = ".alaya-extraction-target-root.json";
export const journalName = MATERIALIZATION_JOURNAL_NAME;

const roots: string[] = [];

export interface MaterializerFixtureOptions {
  readonly hitCount?: number;
  readonly totalCount?: number;
  readonly selectionExpectedTurns?: number;
  readonly selectionKeyDigest?: string;
  readonly rawJsonPaddingBytes?: number;
}

export function cleanupMaterializerFixtures(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}

export function createMaterializerFixture(options: MaterializerFixtureOptions = {}) {
  const hitCount = options.hitCount ?? 3;
  const totalCount = options.totalCount ?? 5;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alaya-cache-materializer-")));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  mkdirSync(sourceRoot);
  const expectedKeys = Array.from({ length: totalCount }, (_, index) =>
    String.fromCharCode(97 + index).repeat(64)
  );
  for (const key of expectedKeys.slice(0, hitCount)) {
    writeShard(sourceRoot, key, options.rawJsonPaddingBytes ?? 0);
  }
  const sourceManifestRaw = sourceManifest(expectedKeys, hitCount);
  const sourceManifestPath = join(sourceRoot, "manifest.json");
  writeFileSync(sourceManifestPath, sourceManifestRaw, "utf8");
  const inventory = inspectExtractionCacheInventory({
    cacheRoot: sourceRoot, cacheKeys: expectedKeys, model, requestProfile
  });
  const auditReceipt = auditReceiptFor(
    sourceRoot,
    sha256(sourceManifestRaw),
    hashExtractionCacheInventory(inventory),
    inventory.counts.hit === inventory.counts.expected && inventory.counts.orphan === 0
  );
  const targetSelection = targetSelectionFor(targetRoot, auditReceipt, {
    expectedTurns: options.selectionExpectedTurns ?? expectedKeys.length,
    keyDigest: options.selectionKeyDigest ?? computeExtractionKeySetSha256(expectedKeys)
  });
  return {
    root, sourceRoot, targetRoot, sourceManifestPath, sourceManifestRaw,
    expectedKeys, hitKeys: expectedKeys.slice(0, hitCount), inventory,
    auditReceipt, targetSelection
  };
}

export function materialize(
  fixture: ReturnType<typeof createMaterializerFixture>,
  options: {
    readonly maxShardBytes?: number;
    readonly now?: () => string;
  } = {}
) {
  return materializeAuditedExtractionCacheTarget({
    sourceRoot: fixture.sourceRoot,
    targetRoot: fixture.targetRoot,
    auditReceipt: fixture.auditReceipt,
    inventory: fixture.inventory,
    targetSelection: fixture.targetSelection,
    auditedSourceManifestRaw: fixture.sourceManifestRaw,
    now: options.now ?? (() => "2026-08-12T00:00:00.000Z"),
    ...(options.maxShardBytes === undefined
      ? {}
      : { maxShardBytes: options.maxShardBytes })
  });
}

export function targetShardPath(
  fixture: ReturnType<typeof createMaterializerFixture>,
  key: string
): string {
  return cacheFilePath(fixture.targetRoot, key);
}

export function sourceShardPath(
  fixture: ReturnType<typeof createMaterializerFixture>,
  key: string
): string {
  return cacheFilePath(fixture.sourceRoot, key);
}

export function writeOpenMaterializationJournal(
  fixture: ReturnType<typeof createMaterializerFixture>,
  maxShardBytes = 128 * 1024
) {
  const journal = buildMaterializationJournal({
    binding: openJournalBinding(fixture, maxShardBytes),
    createdAt: "2026-08-12T00:00:00.000Z"
  });
  writeExclusiveMaterializationRecord(join(fixture.targetRoot, journalName), journal);
  return journal;
}

function openJournalBinding(
  fixture: ReturnType<typeof createMaterializerFixture>,
  maxShardBytes: number
) {
  const rootStat = statSync(fixture.sourceRoot, { bigint: true });
  const shards = journalShards(fixture);
  const remainingKeys = fixture.expectedKeys.filter((key) => !fixture.hitKeys.includes(key));
  const initialTargetManifest = fixtureInitialTargetManifest(fixture, shards.length);
  return {
      source_root_sha256: digest(fixture.sourceRoot),
      source_root_device: rootStat.dev.toString(),
      source_root_inode: rootStat.ino.toString(),
      source_manifest_sha256: fixture.auditReceipt.source_manifest_sha256,
      source_manifest_bytes: Buffer.byteLength(fixture.sourceManifestRaw),
      target_root_marker_sha256: fixture.targetSelection.target_root.cache_root_marker_sha256,
      audit_decision_digest: fixture.auditReceipt.decision_digest,
      occurrence_index_sha256: fixture.auditReceipt.occurrence_index_sha256,
      raw_inventory_sha256: fixture.auditReceipt.raw_inventory_sha256,
      target_selection_receipt_digest: fixture.targetSelection.receipt_digest,
      target_selection: fixture.targetSelection,
      expected_turns: fixture.expectedKeys.length,
      expected_key_set_sha256: computeExtractionKeySetSha256(fixture.expectedKeys),
      materialized_key_count: shards.length,
      materialized_key_set_sha256: computeExtractionKeySetSha256(fixture.hitKeys),
      remaining_key_count: fixture.expectedKeys.length - shards.length,
      remaining_key_set_sha256: computeExtractionKeySetSha256(remainingKeys),
      remaining_keys: remainingKeys,
      materialized_content_sha256: digest(shards.map((shard) =>
        `${shard.cache_key}\0${shard.file_sha256}\0${shard.byte_length}`
      ).join("\n")),
      initial_target_manifest_sha256: digest(
        serializeMaterializedTargetFillManifest(initialTargetManifest)
      ),
      initial_target_manifest: initialTargetManifest,
      max_shard_bytes: maxShardBytes,
      shards
  };
}

function journalShards(fixture: ReturnType<typeof createMaterializerFixture>) {
  return fixture.hitKeys.map((key) => {
    const bytes = readFileSync(sourceShardPath(fixture, key));
    const audited = fixture.inventory.shards.find((shard) => shard.cacheKey === key)!;
    return {
      cache_key: key, raw_json_sha256: audited.rawJsonSha256!,
      file_sha256: digest(bytes), byte_length: bytes.byteLength
    };
  });
}

function fixtureInitialTargetManifest(
  fixture: ReturnType<typeof createMaterializerFixture>, cachedTurns: number
) {
  const sourceManifest = parseExtractionCacheManifestContents(
    fixture.sourceManifestRaw, "fixture source manifest"
  );
  if (sourceManifest.schema_version !== 3) throw new Error("expected V3 fixture manifest");
  return buildMaterializedTargetFillManifest({
    sourceManifest, targetSelection: fixture.targetSelection,
    expectedTurns: fixture.expectedKeys.length, cachedTurns,
    expectedKeySetSha256: computeExtractionKeySetSha256(fixture.expectedKeys),
    builtAt: "2026-08-12T00:00:00.000Z"
  });
}

export function copySourceShardToTarget(
  fixture: ReturnType<typeof createMaterializerFixture>,
  key: string
): void {
  const targetPath = targetShardPath(fixture, key);
  mkdirSync(join(targetPath, ".."), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourceShardPath(fixture, key)));
}

function targetSelectionFor(
  targetRoot: string,
  auditReceipt: ReturnType<typeof auditReceiptFor>,
  selection: { readonly expectedTurns: number; readonly keyDigest: string }
) {
  const targetBinding = createFreshExtractionTargetSelectionRoot({
    cacheRoot: targetRoot, auditReceipt
  });
  const unsigned = {
    schema_version: 2 as const,
    kind: "longmemeval-extraction-target-selection" as const,
    created_at: "2026-08-12T00:00:00.000Z",
    selection_basis: {
      kind: "cache_audit" as const,
      audit_decision_digest: auditReceipt.decision_digest
    },
    target_root: targetBinding,
    final_identity: {
      revision: "a".repeat(40), dataset_variant: "longmemeval_s",
      dataset_revision_sha256: "2".repeat(64), model, model_family: model,
      request_profile: requestProfile, provider_url: "https://example.test/v1",
      system_prompt_sha256: "3".repeat(64), cache_key_algorithm: cacheKeyAlgorithm
    },
    initial_selection: {
      selection_digest: "c".repeat(64), key_digest: selection.keyDigest,
      offset: 0, limit: 100, expected_turns: selection.expectedTurns
    }
  };
  return Object.freeze({
    ...unsigned,
    receipt_digest: digestExtractionTargetSelectionReceipt(unsigned)
  });
}

function auditReceiptFor(
  sourceRoot: string,
  sourceManifestSha256: string,
  inventorySha256: string,
  rawInventoryClosed: boolean
) {
  const sourceRaw = {
    datasetRevision: "2".repeat(64), model, requestProfile,
    providerUrl: "https://example.test/v1", systemPromptSha256: "3".repeat(64),
    cacheKeyAlgorithm, rawClosureSha256: "6".repeat(64)
  };
  const finalRaw = rawInventoryClosed
    ? { ...sourceRaw, rawClosureSha256: "8".repeat(64) }
    : sourceRaw;
  const projection = {
    modelFamily: model, parserSemanticsSha256: "4".repeat(64),
    formationSemanticsSha256: "5".repeat(64), temporalSchemaRevision: "relation-assertion-v1"
  };
  return buildExtractionCacheAuditReceipt({
    createdAt: "2026-08-12T00:00:00.000Z", sourceRoot,
    sourceManifestSha256, rawInventorySha256: inventorySha256,
    occurrenceIndexSha256: "f".repeat(64),
    decision: {
      sourceRoot,
      raw: {
        action: "rebuild",
        reasons: [rawInventoryClosed ? "raw_closure_mismatch" : "raw_inventory_not_closed"],
        source: sourceRaw,
        final: finalRaw
      },
      projection: {
        action: "replay", reasons: ["raw_cache_rebuild"],
        source: projection, final: projection,
        replay: {
          occurrenceCount: 5, accountedOccurrences: 5,
          elementCount: 5, accountedElements: 5,
          admitted: 5, deferred: 0, rejected: 0, invalid: 0,
          ledgerSha256: "1".repeat(64)
        }
      }
    }
  });
}

function sourceManifest(expectedKeys: readonly string[], cachedTurns: number): string {
  const expectedTurns = expectedKeys.length;
  return json({
    schema_version: 3, extraction_model: model, model_family: model,
    request_profile: requestProfile, provider_url: "https://example.test/v1",
    system_prompt_sha256: "3".repeat(64), cache_key_algo: cacheKeyAlgorithm,
    dataset: "longmemeval-s", dataset_revision: "2".repeat(64),
    requested_turns: expectedTurns, cached_turns: cachedTurns,
    coverage: cachedTurns / expectedTurns, fill_status: "in_progress",
    window_offset: 0, window_limit: 100, expected_turns: expectedTurns,
    expected_key_set_sha256: computeExtractionKeySetSha256(expectedKeys), storage: "git-tracked",
    built_at: "2026-08-12T00:00:00.000Z", builder: "test"
  });
}

function writeShard(root: string, key: string, paddingBytes: number): void {
  const path = cacheFilePath(root, key);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    cache_key: key, model, request_profile: requestProfile,
    raw_json: JSON.stringify({ signals: [], padding: "x".repeat(paddingBytes) })
  }), "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const cacheKeyAlgorithm = "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)";
