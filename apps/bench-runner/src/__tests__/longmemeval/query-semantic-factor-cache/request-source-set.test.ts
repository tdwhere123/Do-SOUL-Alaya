import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import {
  bindCurrentQuerySemanticFactorCache,
  bindQuerySemanticFactorCacheFileToRequest,
  createQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../../bench/query-factors/query-semantic-factor-cache.js";
import { resolveQueryCacheRequestSourceTexts } from
  "../../../bench/query-factors/cache/source-set.js";

const SOURCE = "What did I buy?";
const PROFILE = "provider-default-v1" as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("query cache request source set", () => {
  it("refuses current bind and empty sidecar without a request source set", async () => {
    const cache = currentCache();
    expect(() => resolveQueryCacheRequestSourceTexts({}))
      .toThrow(/request source set/u);
    expect(() => resolveQueryCacheRequestSourceTexts({ requiredSourceTexts: [] }))
      .toThrow(/source set is empty/u);
    expect(() => bindCurrentQuerySemanticFactorCache(cache, [])).toThrow(/source set is empty/u);

    const root = await tempRoot();
    const path = join(root, "query-cache.json");
    await writeQuerySemanticFactorCache(path, cache);
    await expect(bindQuerySemanticFactorCacheFileToRequest(path, {
      requestProfile: PROFILE, model: "test-model", providerRoute: "https://provider.invalid/v1"
    })).rejects.toThrow(/request source set/u);

    const snapshot = join(root, "empty.db");
    await writeFile(`${snapshot}.sidecar.json`, `${JSON.stringify({
      schema_version: 2, variant: "longmemeval_s", questions: []
    })}\n`);
    await expect(bindQuerySemanticFactorCacheFileToRequest(path, {
      requestProfile: PROFILE, model: "test-model",
      providerRoute: "https://provider.invalid/v1", snapshotPath: snapshot
    })).rejects.toThrow(/source set is empty/u);
  });
});

function currentCache() {
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: "query", source_text: SOURCE
  });
  return createQuerySemanticFactorCache({
    model_id: "test-model",
    request_profile: PROFILE,
    provider_url: "https://provider.invalid/v1",
    entries: [{
      source_text: SOURCE, source_sha256: capture.source_sha256!, capture, receipt: null
    }]
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "query-cache-source-set-"));
  roots.push(root);
  return root;
}
