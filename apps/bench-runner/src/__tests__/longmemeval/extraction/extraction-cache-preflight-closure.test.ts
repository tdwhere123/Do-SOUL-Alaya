import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { preflightExtractionCache } from "../../../runs/compile-seed.js";
import {
  cacheFilePath,
  computeExtractionContentClosureSha256,
  computeExtractionRawJsonSha256,
  computeSourceTurnCacheKey
} from "../../../runs/compile-seed/compile-seed-cache.js";
import {
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest
} from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { createExtractionCachePreflightProof } from
  "../../../runs/compile-seed/preflight/cache-preflight-proof.js";
import {
  inspectExtractionCacheContentClosure,
  inspectExtractionCacheRawContentClosure
} from "../../../runs/extraction/fill/fill-completion.js";
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

  it("keeps raw closure valid when only parser draft cardinality changes", () => {
    const turnContent = "parser projection changed";
    const rawJson = JSON.stringify({
      signals: [{
        confidence: 0.9,
        matched_text: turnContent,
        evidence_refs: [],
        source_memory_refs: []
      }]
    });
    const cacheKey = computeSourceTurnCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent }
    );
    const historicalEntry = {
      cacheKey,
      model: CONFIG.model,
      requestProfile: CONFIG.requestProfile,
      rawJsonSha256: computeExtractionRawJsonSha256(rawJson),
      rawSignalCount: 1,
      parsedDraftCount: 0
    } as const;
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, rawJson);
    writeExtractionCacheManifest(cacheRoot, {
      ...scopedManifestFor([turnContent], "complete"),
      content_closure_sha256: computeExtractionContentClosureSha256([historicalEntry]),
      content_closure_index: {
        [cacheKey]: [historicalEntry.rawJsonSha256, 1, 0]
      }
    });

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, apiKey: null },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).not.toThrow();
  });

  it("computes the same raw closure without semantic draft projection", () => {
    const turns = ["raw closure first", "raw closure second"];
    for (const turn of turns) {
      writeCacheShard(cacheRoot, CONFIG.model, turn, '{"signals":[]}');
    }
    const input = {
      cacheRoot,
      model: CONFIG.model,
      requestProfile: CONFIG.requestProfile
    } as const;

    const full = inspectExtractionCacheContentClosure(input);
    const rawOnly = inspectExtractionCacheRawContentClosure(input);
    expect(rawOnly).toMatchObject({
      shardTurns: full.shardTurns,
      validTurns: full.validTurns,
      invalidTurns: full.invalidTurns,
      keySetSha256: full.keySetSha256,
      rawContentClosureSha256: full.rawContentClosureSha256
    });
  });

  it("does not mint a proof from a stale caller-supplied manifest identity", () => {
    const turnContent = "stale manifest proof";
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, '{"signals":[]}');
    const manifest = scopedManifestFor([turnContent], "complete");
    writeExtractionCacheManifest(cacheRoot, manifest);
    const staleIdentity = readExtractionCacheManifestIdentity(cacheRoot)!;
    writeExtractionCacheManifest(cacheRoot, {
      ...manifest,
      built_at: "2026-07-01T00:00:01Z"
    });

    expect(() => createExtractionCachePreflightProof({
      cacheRoot,
      manifestIdentity: staleIdentity,
      config: { ...CONFIG, apiKey: null },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent],
      requiredQuestionWindow: { offset: 0, limit: 1 },
      liveExtractionPossible: false
    })).toThrow(/manifest identity is not current/iu);
  });

  it("rejects an invalid raw envelope even when its bytes are indexed", () => {
    const turnContent = "indexed invalid raw envelope";
    const rawJson = '{"not_signals":[]}';
    const cacheKey = computeSourceTurnCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent }
    );
    const entry = {
      cacheKey,
      model: CONFIG.model,
      requestProfile: CONFIG.requestProfile,
      rawJsonSha256: computeExtractionRawJsonSha256(rawJson),
      rawSignalCount: 0,
      parsedDraftCount: 0
    } as const;
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, rawJson);
    writeExtractionCacheManifest(cacheRoot, {
      ...scopedManifestFor([turnContent], "complete"),
      content_closure_sha256: computeExtractionContentClosureSha256([entry]),
      content_closure_index: { [cacheKey]: [entry.rawJsonSha256, 0, 0] }
    });

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, apiKey: null },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).toThrow(/content closure/iu);
  });

  it.each([
    ["truncated", { finish_reason: "length", max_output_tokens: 2048 }],
    ["malformed usage", {
      finish_reason: "stop",
      usage: { input_tokens: -1, output_tokens: 1, total_tokens: 0 }
    }]
  ] as const)("rejects %s response metadata from raw-only closure", (_label, metadata) => {
    const turnContent = `indexed ${_label} response metadata`;
    const rawJson = '{"signals":[]}';
    const cacheKey = computeSourceTurnCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent }
    );
    const rawJsonSha256 = computeExtractionRawJsonSha256(rawJson);
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, rawJson, metadata);
    writeExtractionCacheManifest(cacheRoot, {
      ...scopedManifestFor([turnContent], "complete"),
      content_closure_index: { [cacheKey]: [rawJsonSha256, 0, 0] }
    });

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, apiKey: null },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent],
      requiredQuestionWindow: { offset: 0, limit: 1 }
    })).toThrow(/content closure/iu);
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
    const invalidKey = computeSourceTurnCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent: invalidTurn }
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
    const cacheKey = computeSourceTurnCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent }
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
    const cacheKey = computeSourceTurnCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent }
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
