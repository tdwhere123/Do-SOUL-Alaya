import {
  readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectCachedExtraction } from
  "../../../../../longmemeval/compile-seed/compile-seed-cache.js";
import { readExtractionCacheManifestIdentity } from
  "../../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { readExtractionCatalogRefillAllowlist } from
  "../../../../../longmemeval/extraction/authority/catalog-refill/scope.js";
import {
  cleanupMaterializerFixtures, createMaterializerFixture,
  sourceShardPath, model, requestProfile
} from "../../materializer-fixture.js";

afterEach(cleanupMaterializerFixtures);

describe("bounded no-follow source authority readers", () => {
  it("rejects a symlinked manifest before parsing its valid target", () => {
    const fixture = createMaterializerFixture();
    const path = join(fixture.sourceRoot, "manifest.json");
    const outside = join(fixture.root, "outside-manifest.json");
    writeFileSync(outside, fixture.sourceManifestRaw, "utf8");
    rmSync(path);
    symlinkSync(outside, path);

    expect(() => readExtractionCacheManifestIdentity(fixture.sourceRoot))
      .toThrow(/manifest.*(?:symlink|regular)|(?:symlink|regular).*manifest/iu);
  });

  it("rejects a broken manifest symlink instead of treating it as absent", () => {
    const fixture = createMaterializerFixture();
    const path = join(fixture.sourceRoot, "manifest.json");
    rmSync(path);
    symlinkSync(join(fixture.root, "missing-manifest.json"), path);

    expect(() => readExtractionCacheManifestIdentity(fixture.sourceRoot))
      .toThrow(/manifest.*(?:symlink|regular|open)|(?:symlink|regular|open).*manifest/iu);
  });

  it("rejects an oversized sparse manifest at its bounded reader", () => {
    const fixture = createMaterializerFixture();
    truncateSync(join(fixture.sourceRoot, "manifest.json"), 32 * 1024 * 1024 + 1);

    expect(() => readExtractionCacheManifestIdentity(fixture.sourceRoot))
      .toThrow(/manifest.*(?:exceeds|size limit)|size limit.*manifest/iu);
  });

  it("classifies a symlinked cache shard as invalid before parsing", () => {
    const fixture = createMaterializerFixture({ hitCount: 1, totalCount: 2 });
    const key = fixture.hitKeys[0]!;
    const path = sourceShardPath(fixture, key);
    const outside = join(fixture.root, "outside-shard.json");
    writeFileSync(outside, readFileSync(path));
    rmSync(path);
    symlinkSync(outside, path);

    expect(inspectCachedExtraction(
      fixture.sourceRoot, key, model, requestProfile
    )).toMatchObject({ status: "invalid", reason: expect.stringMatching(/symlink|regular/iu) });
  });

  it("rejects a symlinked catalog allowlist before parsing", () => {
    const fixture = createMaterializerFixture({ hitCount: 1, totalCount: 2 });
    const outside = join(fixture.root, "outside-allowlist.json");
    const path = join(fixture.root, "allowlist.json");
    writeFileSync(outside, JSON.stringify({
      kind: "test-catalog-refill", expected_turns: 2, cached_turns: 1,
      missing_turns: 1, expected_key_set_sha256: "a".repeat(64),
      cache_keys: [fixture.expectedKeys[1]]
    }), "utf8");
    symlinkSync(outside, path);

    expect(() => readExtractionCatalogRefillAllowlist(path))
      .toThrow(/allowlist.*(?:symlink|regular)|(?:symlink|regular).*allowlist/iu);
  });
});
