import { mkdirSync, renameSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCachedExtraction } from
  "../../../runs/compile-seed/cache/cache-shard.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from "../../../runs/extraction/content-closure.js";
import { hasCompleteExtractionFillAuthority } from
  "../../../runs/extraction/fill/fill-authority.js";
import { acquireExtractionCacheWriteLease } from
  "../../../runs/extraction/fill/manifest/fill-root-guard.js";
import {
  assertHistoricalSubstratePublish,
  captureHistoricalSubstrateBinding,
  inspectHistoricalKeyRawClosure,
  assertClaimedHistoricalKeyRawClosure
} from "../../../runs/extraction/fill/manifest/substrate-key-raw-closure.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("historical F0-F2 key/raw closure", () => {
  it("does not treat a complete manifest as coverage=1 after shards are deleted", async () => {
    const cacheRoot = await fixtureRoot();
    const cacheKey = writeCompleteHistoricalRoot(cacheRoot);
    expect(hasCompleteExtractionFillAuthority(
      readExtractionCacheManifest(cacheRoot)!
    )).toBe(true);

    rmSync(join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`));

    const closure = inspectHistoricalKeyRawClosure(cacheRoot);
    expect(closure.claimedComplete).toBe(true);
    expect(closure.complete).toBe(false);
    expect(closure.coverage).toBeLessThan(1);
    expect(closure.missingKeys).toBeGreaterThan(0);

    expect(() => captureHistoricalSubstrateBinding(cacheRoot))
      .toThrow(/coverage cannot be 1|incomplete/u);
    expect(() => assertClaimedHistoricalKeyRawClosure(cacheRoot))
      .toThrow(/coverage cannot be 1|incomplete/u);
    const writer = acquireExtractionCacheWriteLease(cacheRoot);
    writer.release();
    expect(readExtractionCacheManifest(cacheRoot)?.coverage).toBe(1);
  });

  it("proves complete key/raw closure before overlay success may report coverage=1", async () => {
    const cacheRoot = await fixtureRoot();
    writeCompleteHistoricalRoot(cacheRoot);
    const binding = captureHistoricalSubstrateBinding(cacheRoot);
    assertHistoricalSubstratePublish(binding);
    const closure = inspectHistoricalKeyRawClosure(cacheRoot);
    expect(closure.complete).toBe(true);
    expect(closure.coverage).toBe(1);
    const lease = acquireExtractionCacheWriteLease(cacheRoot);
    expect(lease.rootIdentity).toEqual(binding.identity);
    lease.release();
  });

  it("fails publish when the historical root is replaced with another complete-looking tree", async () => {
    const parent = await fixtureRoot();
    const cacheRoot = join(parent, "historical");
    const heldRoot = join(parent, "held");
    const replacement = join(parent, "replacement-complete");
    mkdirSync(cacheRoot);
    writeCompleteHistoricalRoot(cacheRoot);
    const binding = captureHistoricalSubstrateBinding(cacheRoot);

    writeCompleteHistoricalRoot(replacement);
    renameSync(cacheRoot, heldRoot);
    renameSync(replacement, cacheRoot);

    expect(() => assertHistoricalSubstratePublish(binding))
      .toThrow(/identity changed/u);
    expect(inspectHistoricalKeyRawClosure(cacheRoot).complete).toBe(true);
  });
});

function writeCompleteHistoricalRoot(cacheRoot: string): string {
  mkdirSync(cacheRoot, { recursive: true });
  const cacheKey = `ab${"11".repeat(31)}`;
  const rawJson = JSON.stringify({ signals: [] });
  const inspection = inspectExtractionRawJson(rawJson);
  const model = "gpt-5.4-mini";
  const requestProfile = "provider-default-v1" as const;
  writeCachedExtraction(cacheRoot, cacheKey, {
    model,
    request_profile: requestProfile,
    cache_key: cacheKey,
    raw_json: rawJson,
    extracted_at: "2026-09-03T00:00:00.000Z"
  });
  const entry = { cacheKey, model, requestProfile, ...inspection };
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: model,
    model_family: model,
    request_profile: requestProfile,
    provider_url: "https://fixture-provider.invalid/v1",
    system_prompt_sha256: "aa".repeat(32),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "bb".repeat(32),
    storage: "git-tracked",
    built_at: "2026-09-03T00:00:00Z",
    builder: "historical-substrate-closure-test",
    requested_turns: 1,
    cached_turns: 1,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    expected_turns: 1,
    expected_key_set_sha256: computeExtractionKeySetSha256([cacheKey]),
    content_closure_sha256: computeExtractionContentClosureSha256([entry]),
    content_closure_index: {
      [cacheKey]: [
        inspection.rawJsonSha256,
        inspection.rawSignalCount,
        inspection.parsedDraftCount
      ]
    }
  });
  return cacheKey;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "historical-substrate-"));
  roots.push(root);
  return root;
}
