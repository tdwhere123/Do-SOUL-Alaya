import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  computeSystemPromptSha256,
  extractionCacheManifestPath,
  readExtractionCacheManifest,
  readExtractionCacheManifestIdentity,
  resolveBenchExtractionModel,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../../longmemeval/extraction-cache-manifest.js";

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

  it("round-trips an additive canonical model family without replacing the request model", () => {
    const manifest: ExtractionCacheManifest = {
      ...BASE_MANIFEST,
      schema_version: 2,
      extraction_model: "deepseek-v4-flash-free",
      model_family: "deepseek-v4-flash"
    };
    writeExtractionCacheManifest(cacheRoot, manifest);
    expect(readExtractionCacheManifest(cacheRoot)).toEqual(manifest);
  });

  it("round-trips a v3 manifest with an explicit closed request profile", () => {
    const manifest: ExtractionCacheManifest = {
      ...BASE_MANIFEST,
      schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
      extraction_model: "deepseek-v4-flash-free",
      model_family: "deepseek-v4-flash",
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      request_profile: "deepseek-v4-nonthinking-v1"
    };
    writeExtractionCacheManifest(cacheRoot, manifest);
    expect(readExtractionCacheManifest(cacheRoot)).toEqual(manifest);
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

  it("rejects an unknown schema version instead of guessing compatibility", () => {
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify({ ...BASE_MANIFEST, schema_version: 99 }),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /unsupported schema_version 99/u
    );
  });

  it.each(["99", null, { version: 2 }])(
    "rejects a present non-numeric schema version: %j",
    (schemaVersion) => {
      writeFileSync(
        extractionCacheManifestPath(cacheRoot),
        JSON.stringify({ ...BASE_MANIFEST, schema_version: schemaVersion }),
        "utf8"
      );
      expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
        /invalid schema_version/u
      );
    }
  );

  it("rejects a v1 manifest carrying v2 model-family provenance", () => {
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify({ ...BASE_MANIFEST, model_family: "fixture-family" }),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /schema_version 1.*model_family/u
    );
  });

  it("requires model_family for a v2 manifest", () => {
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify({ ...BASE_MANIFEST, schema_version: 2 }),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /schema_version 2.*model_family/u
    );
  });

  it("requires request_profile for a v3 manifest", () => {
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify({
        ...BASE_MANIFEST,
        schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
        model_family: "fixture-family"
      }),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /schema_version 3.*request_profile/u
    );
  });

  it.each(["", "thinking-v1", null])(
    "rejects an unsupported v3 request profile: %j",
    (requestProfile) => {
      writeFileSync(
        extractionCacheManifestPath(cacheRoot),
        JSON.stringify({
          ...BASE_MANIFEST,
          schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
          model_family: "fixture-family",
          request_profile: requestProfile
        }),
        "utf8"
      );
      expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
        /request_profile/u
      );
    }
  );

  it.each([1, 2])("rejects request_profile on legacy schema v%d", (schemaVersion) => {
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify({
        ...BASE_MANIFEST,
        schema_version: schemaVersion,
        ...(schemaVersion === 2 ? { model_family: "fixture-family" } : {}),
        request_profile: "provider-default-v1"
      }),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      new RegExp(`schema_version ${schemaVersion}.*request_profile`, "u")
    );
  });

  it("refuses to write an invalid version-family combination", () => {
    const invalid = {
      ...BASE_MANIFEST,
      schema_version: 2
    } as unknown as ExtractionCacheManifest;
    expect(() => writeExtractionCacheManifest(cacheRoot, invalid)).toThrow(
      /schema_version 2.*model_family/u
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).not.toThrow();
    expect(readExtractionCacheManifest(cacheRoot)).toBeUndefined();
  });

  it("parses fields and hashes the same manifest bytes", () => {
    writeExtractionCacheManifest(cacheRoot, BASE_MANIFEST);
    const raw = readFileSync(extractionCacheManifestPath(cacheRoot), "utf8");
    const identity = readExtractionCacheManifestIdentity(cacheRoot);
    writeExtractionCacheManifest(cacheRoot, {
      ...BASE_MANIFEST,
      extraction_model: "replacement-model"
    });
    expect(identity?.manifest.extraction_model).toBe("gpt-5.4-mini");
    expect(identity?.manifestSha256).toBe(
      createHash("sha256").update(raw, "utf8").digest("hex")
    );
  });

  it.each([
    ["requested_turns", -1],
    ["requested_turns", 1.5],
    ["requested_turns", null],
    ["requested_turns", Number.NaN],
    ["requested_turns", Number.POSITIVE_INFINITY],
    ["cached_turns", -1],
    ["cached_turns", 1.5],
    ["cached_turns", null],
    ["cached_turns", Number.NaN],
    ["cached_turns", Number.NEGATIVE_INFINITY]
  ])("rejects invalid count field %s=%j", (field, value) => {
    const invalid = { ...BASE_MANIFEST, [field]: value } as unknown as ExtractionCacheManifest;
    expect(() => writeExtractionCacheManifest(cacheRoot, invalid)).toThrow(
      /non-negative integer/u
    );
  });

  it.each([-0.1, 1.1, null, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY])(
    "rejects out-of-range coverage %j",
    (coverage) => {
      const invalid = { ...BASE_MANIFEST, coverage } as unknown as ExtractionCacheManifest;
      expect(() => writeExtractionCacheManifest(cacheRoot, invalid)).toThrow(
        /coverage.*\[0, 1\]/u
      );
    }
  );

  it("rejects a blank model family instead of silently dropping provenance", () => {
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(
      extractionCacheManifestPath(cacheRoot),
      JSON.stringify({ ...BASE_MANIFEST, schema_version: 2, model_family: " " }),
      "utf8"
    );
    expect(() => readExtractionCacheManifest(cacheRoot)).toThrow(
      /field "model_family" must be a non-empty string/u
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

  it("resolveBenchExtractionModel prefers env over manifest", () => {
    const model = resolveBenchExtractionModel(
      { OFFICIAL_API_GARDEN_MODEL: "env-model" },
      BASE_MANIFEST
    );
    expect(model).toBe("env-model");
  });

  it("resolveBenchExtractionModel falls back to manifest extraction_model", () => {
    const model = resolveBenchExtractionModel({}, BASE_MANIFEST);
    expect(model).toBe("gpt-5.4-mini");
  });

  it("resolveBenchExtractionModel throws instead of silently defaulting", () => {
    expect(() => resolveBenchExtractionModel({})).toThrow(
      /extraction model is unresolved/u
    );
  });
});
