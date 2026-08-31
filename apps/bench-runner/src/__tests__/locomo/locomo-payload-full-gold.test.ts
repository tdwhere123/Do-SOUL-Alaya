import { describe, expect, it } from "vitest";
import { buildLocomoPayload } from "../../datasets/locomo/runner-payload.js";

describe("LoCoMo KPI full-gold coverage", () => {
  it("writes the memory-only diagnostic view", () => {
    const { payload } = buildLocomoPayload({
      opts: { variant: "locomo10", historyRoot: "/tmp/locomo-history" },
      conversations: [],
      aggregate: {
        perScenario: [],
        questionDiagnostics: [],
        latencies: [],
        conversationResults: [],
        tierHot: 0,
        tierWarm: 0,
        tierCold: 0,
        totalHitAt1: 0,
        totalHitAt5: 0,
        totalHitAt10: 0,
        totalQa: 0,
        conversationFailures: 0
      },
      runAt: new Date("2026-07-26T00:00:00.000Z"),
      alayaVersion: "0.3.11",
      commitSha7: "abc1234",
      embeddingProvider: "none",
      embeddingMode: "disabled",
      extractionStats: {
        path: "official_api_compile",
        cacheHits: 0,
        llmCalls: 0,
        offlineFallbacks: 0,
        liveExtractionFailures: 0,
        cachedExtractionFailures: 0,
        factsProduced: 0,
        signalsDropped: 0,
        signalsDroppedByReason: {
          candidate_absent: 0,
          materialization_drop: 0
        },
        parseDropped: 0,
        compileOverflowDropped: 0,
        lastTurnRawSignalCount: 0,
        lastTurnDraftCount: 0,
        lastExtractionSource: null,
        lastRawJsonSha256: null
      }
    });

    expect(payload.kpi.full_gold_coverage?.memory_only).toBeDefined();
  });
});
