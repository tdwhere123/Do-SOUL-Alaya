import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCachedExtraction } from
  "../../../runs/compile-seed/cache/cache-shard.js";
import * as durablePublication from
  "../../../runs/extraction/fill/manifest/durable-exclusive-publication.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable extraction shard publication", () => {
  it("publishes shards through replaceBytesDurable", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "durable-shard-"));
    roots.push(cacheRoot);
    const replace = vi.spyOn(durablePublication, "replaceBytesDurable");
    writeCachedExtraction(cacheRoot, "ab".repeat(32), {
      model: "test-model",
      request_profile: "provider-default-v1",
      cache_key: "ab".repeat(32),
      raw_json: '{"signals":[]}',
      extracted_at: "2026-09-13T00:00:00.000Z",
      empty_classification: "deterministic_empty"
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(replace.mock.calls[0]?.[0].destination).toContain("ab".repeat(32));
  });
});
