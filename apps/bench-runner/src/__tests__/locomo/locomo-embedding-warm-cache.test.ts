import {
  buildMockDaemon,
  buildRecallResult,
  describe,
  expect,
  it,
  loadLocomoMock,
  startBenchDaemonMock,
  tmpDir,
  vi
} from "./locomo-runner.test-support.js";
import { readFile } from "node:fs/promises";
import { LocomoSampleSchema } from "../../locomo/dataset.js";
import { runLocomo } from "../../locomo/runner.js";

describe("LoCoMo runner", () => {

  it("normalizes semicolon-joined gold evidence before recall scoring", async () => {
    loadLocomoMock.mockResolvedValue([
      LocomoSampleSchema.parse({
        sample_id: "sample-1",
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "2026-05-20",
          session_1: [
            { speaker: "Alice", dia_id: "d1", text: "Alice keeps the violin receipt." },
            { speaker: "Bob", dia_id: "d2", text: "Bob stores the sunset painting." }
          ]
        },
        qa: [
          {
            question: "What painting was stored?",
            answer: "sunset",
            evidence: ["d1; d2"],
            category: 3
          }
        ]
      })
    ]);
    const recall = vi.fn(async () => buildRecallResult("memory-d2"));
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir
    });

    expect(result.payload.sample_size).toBe(1);
    expect(result.payload.evaluated_count).toBe(1);
    expect(result.payload.kpi.r_at_5).toBe(1);
    expect(recall).toHaveBeenCalledTimes(1);
  });

  it("fails closed before scoring when embedding warm cache is incomplete", async () => {
    const recall = vi.fn();
    const warmEmbeddingCache = vi.fn(async () => {
      throw new Error("embedding warm cache not ready after 1 pass(es)");
    });
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ recall, warmEmbeddingCache })
    );

    await expect(
      runLocomo({
        variant: "locomo10",
        historyRoot: tmpDir,
        embeddingMode: "env"
      })
    ).rejects.toThrow("embedding warm cache not ready");

    expect(warmEmbeddingCache).toHaveBeenCalledWith(["memory-d1", "memory-d2"]);
    expect(recall).not.toHaveBeenCalled();
  });

  it("archives embedding warm-cache readiness for env LoCoMo runs", async () => {
    const warmEmbeddingCache = vi.fn(async () => ({
      status: "ready" as const,
      expected_count: 2,
      ready_count: 2,
      ready_rate: 1,
      pass_count: 1,
      missing_object_ids: [],
      provider_kind: "openai",
      model_id: "text-embedding-3-small"
    }));
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ warmEmbeddingCache })
    );

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      embeddingMode: "env"
    });
    const kpi = JSON.parse(await readFile(result.kpiPath, "utf8")) as {
      readonly kpi: {
        readonly provider_returned_rate?: number;
        readonly embedding_vector_cache_ready_rate?: number;
        readonly query_embedding_cache_ready_rate?: number;
      };
    };
    const diagnostics = JSON.parse(await readFile(result.diagnosticsPath, "utf8")) as {
      readonly embedding_vector_cache?: {
        readonly expected_count: number;
        readonly ready_count: number;
        readonly ready_rate: number;
      };
      readonly query_embedding_cache?: {
        readonly requested_count: number;
        readonly ready_count: number;
        readonly ready_rate: number;
      };
    };

    expect(kpi.kpi.provider_returned_rate).toBe(1);
    expect(kpi.kpi.embedding_vector_cache_ready_rate).toBe(1);
    expect(kpi.kpi.query_embedding_cache_ready_rate).toBe(1);
    expect(diagnostics.embedding_vector_cache).toEqual(
      expect.objectContaining({
        expected_count: 2,
        ready_count: 2,
        ready_rate: 1
      })
    );
    expect(diagnostics.query_embedding_cache).toEqual(
      expect.objectContaining({
        requested_count: 1,
        ready_count: 1,
        ready_rate: 1
      })
    );
  });
});
