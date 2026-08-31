import { symlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import {
  assertBoundQuerySemanticFactorCacheFileDigest,
  bindQuerySemanticFactorCacheFileToRequest,
  createQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../../runs/query-factors/query-semantic-factor-cache.js";

const SOURCE = "What did I buy?";
const OTHER = "What did I choose?";
const REQUEST = {
  requestProfile: "provider-default-v1" as const,
  model: "test-model",
  providerRoute: "https://provider.invalid/v1",
  requiredSourceTexts: [SOURCE]
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("query cache no-follow bind", () => {
  it("binds one regular-file buffer and refuses symlink or post-bind replace", async () => {
    const root = await tempRoot();
    const path = join(root, "query-cache.json");
    await writeQuerySemanticFactorCache(path, cacheFor(SOURCE));
    const bound = await bindQuerySemanticFactorCacheFileToRequest(path, REQUEST);
    expect(bound.cache.entries[0]?.source_text).toBe(SOURCE);
    assertBoundQuerySemanticFactorCacheFileDigest(path, bound.file_sha256);

    const linkPath = join(root, "query-cache.link.json");
    symlinkSync(path, linkPath);
    await expect(bindQuerySemanticFactorCacheFileToRequest(linkPath, REQUEST))
      .rejects.toThrow(/missing or unreadable/u);

    await rm(path);
    await writeQuerySemanticFactorCache(path, cacheFor(OTHER));
    expect(bound.cache.entries[0]?.source_text).toBe(SOURCE);
    expect(() => assertBoundQuerySemanticFactorCacheFileDigest(path, bound.file_sha256))
      .toThrow(/digest drifted after bind/u);
    await expect(bindQuerySemanticFactorCacheFileToRequest(path, REQUEST))
      .rejects.toThrow(/missing a required query source|source set/u);
  });
});

function cacheFor(sourceText: string) {
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: "query", source_text: sourceText
  });
  return createQuerySemanticFactorCache({
    model_id: "test-model",
    request_profile: "provider-default-v1",
    provider_url: "https://provider.invalid/v1",
    entries: [{
      source_text: sourceText, source_sha256: capture.source_sha256!, capture, receipt: null
    }]
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "query-cache-nofollow-"));
  roots.push(root);
  return root;
}
