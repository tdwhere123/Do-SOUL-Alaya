import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCachedExtraction } from "../../../bench/compile-seed/cache/cache-shard.js";
import { proveCacheOnlyExtraction } from "../../../bench/diagnostic-loop/cache-only.js";
import { DiagnosticLoopFailure } from "../../../bench/diagnostic-loop/failures.js";
import { digest, loopRequest } from "./fixture.js";

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
    const key = digest("present");
    writeCachedExtraction(cacheRoot, key, {
      model: "mimo-v2-flash",
      request_profile: "provider-default-v1",
      cache_key: key,
      raw_json: "{\"signals\":[]}",
      extracted_at: "2026-08-17T00:00:00.000Z"
    });

    const result = proveCacheOnlyExtraction(loopRequest({
      extractionCacheRoot: cacheRoot,
      requestedKeys: [key],
      model: "mimo-v2-flash",
      requestProfile: "provider-default-v1"
    }));

    expect(result.physicalCalls).toBe(0);
    expect(result.avoidedWork?.providerCallsAvoided).toBe(1);
  });

  it("refuses a supplied network adapter even when the cache hits", async () => {
    const cacheRoot = await tempRoot();
    const key = digest("present");
    writeCachedExtraction(cacheRoot, key, {
      model: "mimo-v2-flash",
      request_profile: "provider-default-v1",
      cache_key: key,
      raw_json: "{\"signals\":[]}",
      extracted_at: "2026-08-17T00:00:00.000Z"
    });

    expect(() => proveCacheOnlyExtraction(
      loopRequest({
        extractionCacheRoot: cacheRoot,
        requestedKeys: [key],
        model: "mimo-v2-flash"
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
