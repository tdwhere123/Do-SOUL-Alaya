import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeSystemPromptSha256,
  extractionCacheManifestPath,
  readExtractionCacheManifest,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../longmemeval/extraction-cache-manifest.js";

const BASE_MANIFEST: ExtractionCacheManifest = {
  schema_version: 1,
  extraction_model: "gpt-5.4-mini",
  provider_url: "https://yunwu.ai/v1",
  system_prompt_sha256: "a".repeat(64),
  cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
  dataset: "longmemeval-s",
  dataset_revision: "rev-abc",
  requested_turns: 35234,
  cached_turns: 10262,
  coverage: 0.291,
  storage: "git-tracked",
  built_at: "2026-05-27T11:07:34Z",
  builder: "run-full-bench-v0311.mjs"
};

describe("extraction-cache-manifest", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-manifest-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("round-trips a full manifest write -> read", () => {
    writeExtractionCacheManifest(cacheRoot, BASE_MANIFEST);
    const read = readExtractionCacheManifest(cacheRoot);
    expect(read).toEqual(BASE_MANIFEST);
  });

  it("round-trips a coverage-less (pre-fill) manifest", () => {
    const preFill: ExtractionCacheManifest = {
      schema_version: 1,
      extraction_model: "gpt-5.4-mini",
      provider_url: "https://yunwu.ai/v1",
      system_prompt_sha256: "b".repeat(64),
      cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
      dataset: "longmemeval-s",
      dataset_revision: "rev-xyz",
      storage: "archive",
      archive_url: "https://example.test/cache.tar.zst",
      archive_sha256: "c".repeat(64),
      built_at: "2026-05-27T11:07:34Z",
      builder: "extraction-fill"
    };
    writeExtractionCacheManifest(cacheRoot, preFill);
    const read = readExtractionCacheManifest(cacheRoot);
    expect(read).toEqual(preFill);
    expect(read?.coverage).toBeUndefined();
    expect(read?.requested_turns).toBeUndefined();
  });

  it("returns undefined when no manifest file exists", () => {
    expect(readExtractionCacheManifest(cacheRoot)).toBeUndefined();
  });

  it("throws on a corrupt (non-JSON) manifest rather than treating it as absent", () => {
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(extractionCacheManifestPath(cacheRoot), "{ not json", "utf8");
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /not valid JSON/u
    );
  });

  it("throws when a required string field is missing", () => {
    mkdirSync(cacheRoot, { recursive: true });
    const { extraction_model: _omit, ...rest } = BASE_MANIFEST;
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify(rest),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /missing required string field "extraction_model"/u
    );
  });

  it("throws on an invalid storage value", () => {
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify({ ...BASE_MANIFEST, storage: "s3" }),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /invalid storage/u
    );
  });

  it("computeSystemPromptSha256 is stable and changes with the prompt", () => {
    const a = computeSystemPromptSha256("prompt one");
    const b = computeSystemPromptSha256("prompt one");
    const c = computeSystemPromptSha256("prompt two");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });
});
