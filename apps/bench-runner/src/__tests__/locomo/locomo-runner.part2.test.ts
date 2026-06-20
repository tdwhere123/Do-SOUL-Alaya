import {
  benchRefToDiaId,
  buildMockDaemon,
  buildRecallResult,
  describe,
  expect,
  it,
  startBenchDaemonMock,
  tmpDir,
  vi
} from "./locomo-runner.test-support.js";
import * as compileSeedModule from "../../longmemeval/compile-seed.js";
import { runLocomo } from "../../locomo/runner.js";

describe("LoCoMo runner", () => {

  it("maps multi-fact extracted seeds back to the source dia_id for scoring", async () => {
    const createCompileSeedRunnerSpy = vi
      .spyOn(compileSeedModule, "createCompileSeedRunner")
      .mockReturnValue({
        stats: {
          path: "official_api_compile",
          cacheHits: 0,
          llmCalls: 1,
          offlineFallbacks: 0,
          liveExtractionFailures: 0,
          cachedExtractionFailures: 0,
          factsProduced: 3,
          signalsDropped: 0,
          signalsDroppedByReason: {
            candidate_absent: 0,
            materialization_error: 0
          },
          parseDropped: 0,
          compileOverflowDropped: 0,
          lastTurnRawSignalCount: 0,
          lastTurnDraftCount: 0,
          lastExtractionSource: null,
          lastCacheKey: null
        },
        seedTurn: vi.fn(async ({ evidenceRefBase }: { evidenceRefBase: string }) => {
          if (benchRefToDiaId(evidenceRefBase) === "d1") {
            return {
              seeds: [
                {
                  memoryId: "memory-d1-a",
                  signalId: "signal-d1-a",
                  proposalId: "proposal-d1-a",
                  evidenceId: null,
                  truncated: false,
                  charsClipped: 0
                },
                {
                  memoryId: "memory-d1-b",
                  signalId: "signal-d1-b",
                  proposalId: "proposal-d1-b",
                  evidenceId: null,
                  truncated: false,
                  charsClipped: 0
                }
              ],
              turnTruncated: false,
              charsClipped: 0
            };
          }
          return {
            seeds: [
              {
                memoryId: "memory-d2",
                signalId: "signal-d2",
                proposalId: "proposal-d2",
                evidenceId: null,
                truncated: false,
                charsClipped: 0
              }
            ],
            turnTruncated: false,
            charsClipped: 0
          };
        })
      } as ReturnType<typeof compileSeedModule.createCompileSeedRunner>);
    const warmEmbeddingCache = vi.fn(async () => ({
      status: "ready" as const,
      expected_count: 3,
      ready_count: 3,
      ready_rate: 1,
      pass_count: 1,
      missing_object_ids: [],
      provider_kind: "openai",
      model_id: "text-embedding-3-small"
    }));
    const recall = vi.fn(async () => buildRecallResult("memory-d1-b"));
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ recall, warmEmbeddingCache })
    );

    try {
      const result = await runLocomo({
        variant: "locomo10",
        historyRoot: tmpDir,
        embeddingMode: "env"
      });
      expect(result.payload.kpi.r_at_5).toBe(1);
      expect(warmEmbeddingCache).toHaveBeenCalledWith([
        "memory-d1-a",
        "memory-d1-b",
        "memory-d2"
      ]);
    } finally {
      createCompileSeedRunnerSpy.mockRestore();
    }
  });
});
