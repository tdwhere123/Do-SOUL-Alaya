import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCachedExtraction } from "../../../bench/compile-seed/cache/cache-shard.js";
import { proveCacheOnlyExtraction } from "../../../bench/diagnostic-loop/cache-only.js";
import { DiagnosticLoopFailure } from "../../../bench/diagnostic-loop/failures.js";
import { digest, loopRequest } from "./fixture.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { computeSourceTurnCacheKey } from
  "../../../bench/compile-seed/compile-seed-cache.js";
import { computeSystemPromptSha256 } from
  "../../../bench/extraction/cache/extraction-cache-manifest.js";
import { writeCompletedExtractionCacheFixture } from
  "../extraction/completed-extraction-cache-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cache-only extraction proof", () => {
  it("fails closed on a missing key without touching a network adapter", async () => {
    const cacheRoot = await tempRoot();
    let networkCalls = 0;

    expect(() => proveCacheOnlyExtraction(
      loopRequest({ extractionCacheRoot: cacheRoot, requestedKeys: [digest("missing")] }),
      () => { networkCalls += 1; }
    )).toThrow(DiagnosticLoopFailure);
    expect(networkCalls).toBe(0);
  });

  it("proves zero physical calls when every requested key is present", async () => {
    const cacheRoot = await tempRoot();
    const model = "test-extraction-model";
    const key = computeSourceTurnCacheKey(
      model, "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, { turnContent: "turn" }
    );
    writeCompletedExtractionCacheFixture({
      cacheRoot,
      turnContents: ["turn"],
      datasetRevision: digest("dataset"),
      windowOffset: 0,
      windowLimit: 1,
      model
    });

    const result = proveCacheOnlyExtraction(loopRequest({
      extractionCacheRoot: cacheRoot,
      requestedKeys: [key],
      model,
      requestProfile: "provider-default-v1",
      promptDigest: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT)
    }));

    expect(result.physicalCalls).toBe(0);
    expect(result.avoidedWork?.providerCallsAvoided).toBe(1);
  });

  it("refuses a supplied network adapter even when the cache hits", async () => {
    const cacheRoot = await tempRoot();
    const key = digest("present");
    writeCachedExtraction(cacheRoot, key, {
      model: "mimo-v2.5",
      request_profile: "mimo-v2.5-nonthinking-v1",
      cache_key: key,
      raw_json: "{\"signals\":[]}",
      extracted_at: "2026-08-17T00:00:00.000Z"
    });

    expect(() => proveCacheOnlyExtraction(
      loopRequest({
        extractionCacheRoot: cacheRoot,
        requestedKeys: [key],
        model: "mimo-v2.5"
      }),
      () => undefined
    )).toThrow(/must not receive a network adapter/u);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-loop-cache-"));
  roots.push(root);
  return root;
}
