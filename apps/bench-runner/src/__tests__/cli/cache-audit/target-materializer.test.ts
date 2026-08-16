import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExtractionCacheManifest } from
  "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { assertExtractionTargetSelectionRootBinding } from
  "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import { inspectExtractionCacheInventory } from
  "../../../longmemeval/extraction/cache-audit/inventory.js";
import { verifyCommittedAuditedExtractionCacheSuccessor } from
  "../../../longmemeval/extraction/cache-audit/target-materializer.js";
import {
  cleanupMaterializerFixtures,
  createMaterializerFixture,
  materialize,
  model,
  requestProfile,
  sourceShardPath,
  targetMarkerName,
  targetShardPath
} from "./materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

describe("audited extraction cache target materializer", () => {
  it("commits a standard V3 in-progress 3/5 target that remains inspectable", () => {
    const fixture = createMaterializerFixture();
    const markerBefore = readFileSync(join(fixture.targetRoot, targetMarkerName));

    const receipt = materialize(fixture);

    for (const key of fixture.hitKeys) {
      expect(readFileSync(targetShardPath(fixture, key)))
        .toEqual(readFileSync(sourceShardPath(fixture, key)));
    }
    expect(readFileSync(join(fixture.targetRoot, targetMarkerName))).toEqual(markerBefore);
    expect(readExtractionCacheManifest(fixture.targetRoot)).toMatchObject({
      schema_version: 3,
      fill_status: "in_progress",
      requested_turns: 5,
      cached_turns: 3,
      coverage: 0.6,
      expected_turns: 5,
      expected_key_set_sha256: fixture.targetSelection.initial_selection.key_digest
    });
    const inspected = inspectExtractionCacheInventory({
      cacheRoot: fixture.targetRoot,
      cacheKeys: fixture.expectedKeys,
      model,
      requestProfile
    });
    expect(inspected.counts).toEqual({
      expected: 5, hit: 3, missing: 2, invalid: 0, orphan: 0
    });
    expect(() => assertExtractionTargetSelectionRootBinding(
      fixture.targetSelection,
      fixture.targetRoot
    )).not.toThrow();
    expect(receipt).toMatchObject({
      kind: "longmemeval-extraction-cache-materialization",
      materialized_key_count: 3,
      target_selection_receipt_digest: fixture.targetSelection.receipt_digest
    });
  });

  it("excludes audited orphan shards from the rebuilt target", () => {
    const fixture = createMaterializerFixture({
      hitCount: 2,
      totalCount: 3,
      orphanCount: 1
    });

    const receipt = materialize(fixture);

    expect(receipt.materialized_key_count).toBe(2);
    expect(fixture.inventory.orphanKeys).toEqual(fixture.orphanKeys);
    expect(existsSync(sourceShardPath(fixture, fixture.orphanKeys[0]!))).toBe(true);
    expect(existsSync(targetShardPath(fixture, fixture.orphanKeys[0]!))).toBe(false);
  });

  it("revalidates but does not copy a semantically quarantined raw shard", () => {
    const fixture = createMaterializerFixture({ semanticQuarantineIndex: 1 });
    const quarantined = fixture.expectedKeys[1]!;

    const receipt = materialize(fixture);

    expect(existsSync(sourceShardPath(fixture, quarantined))).toBe(true);
    expect(existsSync(targetShardPath(fixture, quarantined))).toBe(false);
    expect(receipt.materialized_key_count).toBe(2);
    expect(readExtractionCacheManifest(fixture.targetRoot)).toMatchObject({
      cached_turns: 2,
      requested_turns: 5,
      fill_status: "in_progress"
    });
  });

  it("keeps commit time valid when the wall clock moves backward", () => {
    const fixture = createMaterializerFixture();
    const timestamps = [
      "2026-08-12T00:00:00.300Z",
      "2026-08-12T00:00:00.100Z"
    ];

    materialize(fixture, { now: () => timestamps.shift()! });

    expect(verifyCommittedAuditedExtractionCacheSuccessor({
      targetRoot: fixture.targetRoot
    })).toMatchObject({
      created_at: "2026-08-12T00:00:00.300Z",
      committed_at: "2026-08-12T00:00:00.300Z"
    });
  });
});
