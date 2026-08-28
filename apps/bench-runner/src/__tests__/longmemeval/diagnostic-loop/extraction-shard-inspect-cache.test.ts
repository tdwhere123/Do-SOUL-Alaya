import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { computeSourceTurnCacheKey } from
  "../../../bench/compile-seed/compile-seed-cache.js";
import { cacheFilePath } from "../../../bench/compile-seed/cache/cache-shard.js";
import { computeSystemPromptSha256 } from
  "../../../bench/extraction/cache/extraction-cache-manifest.js";
import {
  extractionShardInspectCounts,
  resolveExtractionCacheIdentity
} from "../../../bench/diagnostic-loop/authority/identity.js";
import { writeCompletedExtractionCacheFixture } from
  "../extraction/completed-extraction-cache-fixture.js";
import { digest, loopRequest } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop extraction shard inspect cache", () => {
  it("inspects shards once and fails closed after a shard changes", async () => {
    const cacheRoot = await tempRoot();
    const model = "test-extraction-model";
    const requestProfile = "provider-default-v1" as const;
    const key = computeSourceTurnCacheKey(
      model, requestProfile, OFFICIAL_API_SYSTEM_PROMPT, { turnContent: "turn" }
    );
    writeCompletedExtractionCacheFixture({
      cacheRoot,
      turnContents: ["turn"],
      datasetRevision: digest("dataset"),
      windowOffset: 0,
      windowLimit: 1,
      model
    });
    const request = loopRequest({
      extractionCacheRoot: cacheRoot,
      requestedKeys: [key],
      model,
      requestProfile,
      datasetRevision: digest("dataset"),
      promptDigest: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT)
    });

    const before = extractionShardInspectCounts();
    resolveExtractionCacheIdentity(request);
    expect(extractionShardInspectCounts().physicalReads - before.physicalReads).toBe(1);
    resolveExtractionCacheIdentity(request);
    expect(extractionShardInspectCounts().physicalReads - before.physicalReads).toBe(1);
    expect(extractionShardInspectCounts().memoHits).toBeGreaterThan(before.memoHits);

    writeFileSync(cacheFilePath(cacheRoot, key), "tampered shard");
    expect(() => resolveExtractionCacheIdentity(request)).toThrow(/shard drifted/u);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "extraction-shard-inspect-"));
  roots.push(root);
  return root;
}
