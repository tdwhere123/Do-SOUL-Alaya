import { describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  preflightExtractionCache,
  resolveBenchRequireExtractionCacheManifest
} from "../../longmemeval/compile-seed.js";
import { writeExtractionCacheManifest } from "../../longmemeval/extraction-cache-manifest.js";
import {
  EXTRACTION_CONFIG as CONFIG,
  manifestFor,
  registerCacheRootHooks
} from "./extraction-cache-preflight-fixture.js";

describe("preflightExtractionCache", () => {
  let cacheRoot: string;
  registerCacheRootHooks("extraction-preflight-", (root) => { cacheRoot = root; });

  it("warns and allows when no manifest exists (first-ever build)", () => {
    const warn = vi.fn();
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        warn
      })
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/first-ever build/u);
  });

  it("passes silently when model, prompt-sha, and coverage all match", () => {
    writeExtractionCacheManifest(cacheRoot, manifestFor());
    const warn = vi.fn();
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        warn
      })
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws on a model mismatch, naming both models", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ extraction_model: "gpt-4.1-mini" })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/extraction model mismatch.*gpt-5\.4-mini.*gpt-4\.1-mini/su);
  });

  it("throws on a system-prompt sha drift", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ system_prompt_sha256: "f".repeat(64) })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/system prompt drift/u);
  });

  it("throws on a cache-key algorithm drift", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cache_key_algo: "sha256(legacy)" })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/cache-key algorithm mismatch/u);
  });

  it("throws when an explicit comparison model family disagrees with the manifest", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      {
        ...manifestFor(),
        model_family: "gpt-5-family"
      }
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: { ...CONFIG, modelFamily: "other-family" },
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/model family mismatch/u);
  });

  it("rejects a v2 cache even when non-thinking is explicit", () => {
    const { request_profile: _profile, ...legacy } = manifestFor();
    writeExtractionCacheManifest(cacheRoot, { ...legacy, schema_version: 2 });
    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, requestProfile: "deepseek-v4-nonthinking-v1" },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    })).toThrow(/request profile mismatch|schema_version 2/u);
  });

  it("throws on a coverage gap when allow-live is not set", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cached_turns: 50, coverage: 0.5 })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/coverage 50\.0% is below.*--allow-live-extraction/su);
  });

  it("allows a coverage gap when allowLiveExtraction is true", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cached_turns: 50, coverage: 0.5 })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        allowLiveExtraction: true
      })
    ).not.toThrow();
  });

  it("rejects provider drift before a live fill can mix cache sources", () => {
    writeExtractionCacheManifest(cacheRoot, manifestFor());
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: { ...CONFIG, providerUrl: "https://opencode.ai/zen/v1" },
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        allowLiveExtraction: true
      })
    ).toThrow(/provider URL mismatch/u);
  });

  it("uses frozen manifest provenance when provider drift cannot trigger a live call", () => {
    writeExtractionCacheManifest(cacheRoot, manifestFor());
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: { ...CONFIG, providerUrl: "https://opencode.ai/zen/v1" },
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).not.toThrow();
  });

  // @anchor finding-1-no-coverage-gap: a manifest WITHOUT a coverage field is a
  // gap, not a silent pass. extraction-fill always writes coverage, so a
  // coverage-less manifest means the cache was never filled against a known
  // denominator.
  it("throws on a manifest with NO coverage field when allow-live is not set", () => {
    const { coverage: _omitCoverage, ...withoutCoverage } = manifestFor();
    void _omitCoverage;
    writeExtractionCacheManifest(
      cacheRoot,
      withoutCoverage as typeof withoutCoverage & { coverage?: number }
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/no coverage field.*--allow-live-extraction/su);
  });

  it("allows a NO-coverage manifest when allowLiveExtraction is true", () => {
    const { coverage: _omitCoverage, ...withoutCoverage } = manifestFor();
    void _omitCoverage;
    writeExtractionCacheManifest(
      cacheRoot,
      withoutCoverage as typeof withoutCoverage & { coverage?: number }
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        allowLiveExtraction: true
      })
    ).not.toThrow();
  });

  it("throws when requireManifest is set and manifest is absent", () => {
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requireManifest: true
      })
    ).toThrow(/ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST=0/u);
  });

  it("defaults runner cache-manifest requirement to fail-closed", () => {
    expect(resolveBenchRequireExtractionCacheManifest({} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      resolveBenchRequireExtractionCacheManifest({
        ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST: "0"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      resolveBenchRequireExtractionCacheManifest({
        ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST: "false"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("requires full coverage when minimumCoverage is 1", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cached_turns: 99, coverage: 0.99 })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        minimumCoverage: 1
      })
    ).toThrow(/below the 100% threshold/u);
  });


});
