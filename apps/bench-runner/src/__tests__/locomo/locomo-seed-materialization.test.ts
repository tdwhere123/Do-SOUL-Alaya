import {
  benchRefToDiaId,
  buildMockDaemon,
  buildRecallResult,
  describe,
  expect,
  it,
  startBenchDaemonMock,
  tmpDir,
  vi,
  type KpiPayload
} from "./locomo-runner.test-support.js";
import { readFile } from "node:fs/promises";
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
            materialization_drop: 0
          },
          parseDropped: 0,
          compileOverflowDropped: 0,
          lastTurnRawSignalCount: 0,
          lastTurnDraftCount: 0,
          lastExtractionSource: null,
          lastCacheKey: null,
          lastRawJsonSha256: null
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

  it("tolerates and discloses a scored gold dia_id that materializes to zero memory ids", async () => {
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
          factsProduced: 2,
          signalsDropped: 1,
          signalsDroppedByReason: {
            candidate_absent: 1,
            materialization_drop: 0
          },
          parseDropped: 0,
          compileOverflowDropped: 0,
          lastTurnRawSignalCount: 0,
          lastTurnDraftCount: 0,
          lastExtractionSource: null,
          lastCacheKey: null,
          lastRawJsonSha256: null
        },
        seedTurn: vi.fn(async ({ evidenceRefBase }: { evidenceRefBase: string }) => {
          if (benchRefToDiaId(evidenceRefBase) === "d1") {
            return { seeds: [], turnTruncated: false, charsClipped: 0 };
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
    const recall = vi.fn(async () => buildRecallResult());
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    try {
      // LoCoMo gold references unmaterializable dia_ids; the run completes,
      // recall still runs, and the unscorable question drops out of the denominator.
      const result = await runLocomo({
        variant: "locomo10",
        historyRoot: tmpDir
      });
      expect(recall).toHaveBeenCalled();
      expect(Number.isFinite(result.payload.kpi.r_at_5)).toBe(true);
    } finally {
      createCompileSeedRunnerSpy.mockRestore();
    }
  });

  it("archives the seed-extraction path and blocker text on the LoCoMo surface", async () => {
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({}));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir
    });
    const kpi = JSON.parse(await readFile(result.kpiPath, "utf8")) as KpiPayload;
    const report = await readFile(result.reportPath, "utf8");
    const findings = await readFile(result.findingsPath, "utf8");

    expect(kpi.kpi.seed_extraction_path).toMatchObject({
      path: "no_credentials_fallback",
      offline_fallbacks: 2
    });
    expect(report).toContain("seed_extraction_path no_credentials_fallback");
    expect(findings).toContain("seed_extraction_path no_credentials_fallback");
  });

  it("drains the edge plane before recall when ALAYA_BENCH_RUN_EDGE_PLANE is enabled", async () => {
    vi.stubEnv("ALAYA_BENCH_RUN_EDGE_PLANE", "1");
    const runEdgePlanePassIfConfigured = vi.fn(async () => undefined);
    const recall = vi.fn(async () => buildRecallResult("memory-d1"));
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ recall, runEdgePlanePassIfConfigured })
    );

    await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir
    });

    expect(runEdgePlanePassIfConfigured).toHaveBeenCalledTimes(1);
    expect(runEdgePlanePassIfConfigured.mock.invocationCallOrder[0]).toBeLessThan(
      recall.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });
});
