import { describe, expect, it } from "vitest";
import type { CompileSeedExtractionStats } from
  "../../../runs/compile-seed.js";
import { buildRoundExtractionLedger } from
  "../../../datasets/longmemeval/runner/question/seed-round-extraction-ledger.js";

describe("seed round extraction ledger", () => {
  it("binds every bounded raw shard without inventing an aggregate raw response", () => {
    const stats = extractionStats();
    stats.lastExtractionSource = "cache";
    stats.lastTurnRawSignalCount = 3;
    stats.lastTurnDraftCount = 2;
    stats.lastExtractionShards = [
      shard("a", "c", 2, 1),
      shard("b", "d", 1, 1)
    ];

    expect(buildRoundExtractionLedger(stats)).toEqual({
      extractionSource: "cache",
      cacheKey: null,
      rawJsonSha256: null,
      rawSignalCount: 3,
      draftCount: 2,
      extractionShards: [
        { cacheKey: "a".repeat(64), rawJsonSha256: "c".repeat(64), rawSignalCount: 2, draftCount: 1 },
        { cacheKey: "b".repeat(64), rawJsonSha256: "d".repeat(64), rawSignalCount: 1, draftCount: 1 }
      ]
    });
  });
});

function shard(
  cache: string,
  raw: string,
  rawSignalCount: number,
  draftCount: number
) {
  return {
    extractionSource: "cache" as const,
    cacheKey: cache.repeat(64),
    rawJsonSha256: raw.repeat(64),
    rawSignalCount,
    draftCount
  };
}

function extractionStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastRawJsonSha256: null
  };
}
