import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVerifiedLegacyExtractionEntry } from
  "../../../runs/extraction/cache/semantic-artifact/legacy/legacy-sealed-entry.js";
import {
  buildSnapshotExtractionSummary
} from "../../../runs/snapshot/extraction-authority.js";
import type { ExtractionCacheManifestV3 } from "../../../runs/extraction/cache/extraction-cache-manifest.js";

const SINGLE_KEY = "0c297b4cd1547986994b6f4acd44b7bfa1e40d5eba9c803e2c53cba93bafc295";
const MULTI_KEY = "0cf56b73a55320505f980064c64b0d51afe2143754bd6340199703d9f4e5e673";

describe("sealed MiMo shard conversion", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mimo-convert-")); });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects locator-bearing legacy conversion without opaque external authority", () => {
    expect(() => readVerifiedLegacyExtractionEntry({
      root, cacheKey: SINGLE_KEY
    } as never)).toThrow(/loaded extraction authority/u);
  });

  it("rejects incomplete legacy entries without opaque external authority", () => {
    expect(() => readVerifiedLegacyExtractionEntry({
      root, cacheKey: MULTI_KEY
    } as never)).toThrow(/loaded extraction authority/u);
  });
});

describe("snapshot bench mode binding", () => {
  it("keeps complete snapshot compact free of bench-mode identity", () => {
    const manifest = {
      schema_version: 3,
      extraction_model: "mimo-v2.5",
      model_family: "mimo-v2.5",
      request_profile: "mimo-v2.5-nonthinking-v1",
      provider_url: "https://example.invalid/v1",
      system_prompt_sha256: "11".repeat(32),
      cache_key_algo: "sha256(model\\0requestProfile\\0systemPrompt\\0canonicalExtractionRequest)",
      dataset: "longmemeval-s",
      dataset_revision: "rev",
      requested_turns: 1,
      cached_turns: 1,
      coverage: 1,
      fill_status: "complete",
      window_offset: 0,
      window_limit: 1,
      expected_turns: 1,
      expected_key_set_sha256: "22".repeat(32),
      content_closure_sha256: "33".repeat(32),
      storage: "archive",
      built_at: "2026-08-23T00:00:00Z",
      builder: "test"
    } as ExtractionCacheManifestV3;
    const compact = buildSnapshotExtractionSummary(manifest, "44".repeat(32));
    expect("extraction_bench_mode" in compact).toBe(false);
  });
});
