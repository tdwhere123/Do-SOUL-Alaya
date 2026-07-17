import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { preflightExtractionCache } from "../../../longmemeval/compile-seed.js";
import { cacheFilePath, computeCacheKey } from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import { writeExtractionCacheManifest } from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  EXTRACTION_CONFIG as CONFIG,
  manifestFor,
  registerCacheRootHooks,
  scopedManifestFor,
  writeCacheShard
} from "./extraction-cache-preflight-fixture.js";

describe("preflightExtractionCache", () => {
  let cacheRoot: string;
  registerCacheRootHooks("extraction-preflight-", (root) => { cacheRoot = root; });

  it("rejects an in-progress fill even when every required fixture is valid", () => {
    const turnContent = "cached but not finalized";
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, '{"signals":[]}');
    writeExtractionCacheManifest(
      cacheRoot,
      scopedManifestFor([turnContent], "in_progress")
    );

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/fill is in_progress.*complete/su);
  });

  it("allows live fill to expand and repin an in-progress window", () => {
    const cachedTurn = "cached turn";
    writeCacheShard(cacheRoot, CONFIG.model, cachedTurn, '{"signals":[]}');
    writeExtractionCacheManifest(
      cacheRoot,
      scopedManifestFor([cachedTurn], "in_progress")
    );

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [cachedTurn, "new turn"],
      allowLiveExtraction: true
    })).not.toThrow();
  });

  it("rejects a complete fill scoped to another key set despite all cache hits", () => {
    const originalTurn = "original scoped turn";
    const addedTurn = "manually added superset turn";
    writeCacheShard(cacheRoot, CONFIG.model, originalTurn, '{"signals":[]}');
    writeCacheShard(cacheRoot, CONFIG.model, addedTurn, '{"signals":[]}');
    writeExtractionCacheManifest(
      cacheRoot,
      scopedManifestFor([originalTurn], "complete")
    );

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [originalTurn, addedTurn],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).toThrow(/content closure/iu);
  });

  it("deduplicates production cache keys when binding a complete fill", () => {
    const turnContent = "duplicate required turn";
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, '{"signals":[]}');
    writeExtractionCacheManifest(
      cacheRoot,
      scopedManifestFor([turnContent], "complete")
    );

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent, turnContent],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).not.toThrow();
  });

  it("allows a valid consumer subwindow without treating global shards as orphans", () => {
    const firstTurn = "global first turn";
    const secondTurn = "global second turn";
    writeCacheShard(cacheRoot, CONFIG.model, firstTurn, '{"signals":[]}');
    writeCacheShard(cacheRoot, CONFIG.model, secondTurn, '{"signals":[]}');
    writeExtractionCacheManifest(cacheRoot, {
      ...scopedManifestFor([firstTurn, secondTurn], "complete"),
      window_limit: 2
    });

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, apiKey: null },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [firstTurn],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).not.toThrow();
  });

  it("rejects a missing required fixture inside a consumer subwindow", () => {
    const missingTurn = "missing subwindow turn";
    const cachedTurn = "cached global turn";
    writeCacheShard(cacheRoot, CONFIG.model, cachedTurn, '{"signals":[]}');
    writeExtractionCacheManifest(cacheRoot, {
      ...scopedManifestFor([missingTurn, cachedTurn], "complete"),
      window_limit: 2
    });

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, apiKey: null },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [missingTurn],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).toThrow(/content closure/iu);
  });

  it("rejects an invalid required fixture inside a consumer subwindow", () => {
    const invalidTurn = "invalid subwindow turn";
    const cachedTurn = "other global turn";
    const invalidKey = computeCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      invalidTurn
    );
    mkdirSync(join(cacheRoot, invalidKey.slice(0, 2)), { recursive: true });
    writeFileSync(cacheFilePath(cacheRoot, invalidKey), "{torn", "utf8");
    writeCacheShard(cacheRoot, CONFIG.model, cachedTurn, '{"signals":[]}');
    writeExtractionCacheManifest(cacheRoot, {
      ...scopedManifestFor([invalidTurn, cachedTurn], "complete"),
      window_limit: 2
    });

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, apiKey: null },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [invalidTurn],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).toThrow(/content closure/iu);
  });

  it.each([
    [{ offset: 1, limit: 1 }, "offset"],
    [{ offset: 0, limit: 2 }, "limit"]
  ] as const)("rejects a complete fill with the wrong question-window %s", (window, _field) => {
    const turnContent = "window-bound turn";
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, '{"signals":[]}');
    writeExtractionCacheManifest(
      cacheRoot,
      scopedManifestFor([turnContent], "complete")
    );

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent],
      requiredQuestionWindow: window
    })).toThrow(/complete fill question window.*contain.*offset\/limit/su);
  });

  it("rejects a complete fill when the caller omits question-window metadata", () => {
    const turnContent = "unbound window turn";
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, '{"signals":[]}');
    writeExtractionCacheManifest(
      cacheRoot,
      scopedManifestFor([turnContent], "complete")
    );

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/requires.*question window metadata/su);
  });

  it("rejects a corrupt required fixture instead of trusting its path", () => {
    const turnContent = "required turn";
    const cacheKey = computeCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      turnContent
    );
    mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
    writeFileSync(cacheFilePath(cacheRoot, cacheKey), "{torn", "utf8");
    writeExtractionCacheManifest(cacheRoot, manifestFor());

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/invalid.*fixture|fixture.*invalid/u);
  });

  it.each([0, 1])("rejects a semantically invalid required fixture at coverage %s", (coverage) => {
    const turnContent = "required semantic validation";
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, '{"not_signals":[]}');
    writeExtractionCacheManifest(cacheRoot, manifestFor({ coverage }));

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/invalid fixture/u);
  });

  it.each([
    ["model", { model: "wrong", raw_json: "{}" }],
    ["cache_key", { model: CONFIG.model, cache_key: "wrong", raw_json: "{}" }],
    ["raw_json", { model: CONFIG.model, raw_json: 7 }]
  ])("validates required fixture %s", (_field, override) => {
    const turnContent = `required-${_field}`;
    const cacheKey = computeCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      turnContent
    );
    mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
    const fixture: Record<string, unknown> = {
      model: CONFIG.model,
      cache_key: cacheKey,
      raw_json: "{}"
    };
    Object.assign(fixture, override);
    writeFileSync(cacheFilePath(cacheRoot, cacheKey), JSON.stringify(fixture));
    writeExtractionCacheManifest(cacheRoot, manifestFor());

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/invalid fixture/u);
  });

});
