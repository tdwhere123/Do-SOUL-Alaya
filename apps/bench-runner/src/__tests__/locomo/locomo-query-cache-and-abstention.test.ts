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
import { runLocomo } from "../../locomo/runner.js";
import { buildLongMemEvalQualityMetrics } from
  "../../longmemeval/diagnostics/quality/diagnostics-quality.js";
import { promotionMeasurementDiagnostic } from
  "../longmemeval/recall-eval/specialized-answerable-recall-fixture.js";

describe("LoCoMo runner", () => {

  it("uses the measurement cohort rather than an ID suffix for shared quality denominators", () => {
    const row = promotionMeasurementDiagnostic("locomo-row_abs", "scorable", true);

    expect(buildLongMemEvalQualityMetrics([row])).toMatchObject({
      candidate_absent_denominator: 1,
      non_monotonic_denominator: 1,
      abstention: { total: 0 }
    });
  });

  it("leaves query encode to timed recall instead of pre-warming the query cache", async () => {
    const warmQueryEmbeddingCache = vi.fn();
    const recall = vi.fn(async () => buildRecallResult());
    const accrueSessionCoRecall = vi.fn(async () => ({
      pairsObserved: 1,
      minted: 1,
      belowThreshold: 0
    }));
    startBenchDaemonMock.mockResolvedValue(
      buildMockDaemon({ recall, warmQueryEmbeddingCache, accrueSessionCoRecall })
    );

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      embeddingMode: "env"
    });
    expect(accrueSessionCoRecall).toHaveBeenCalled();
    const kpi = JSON.parse(await readFile(result.kpiPath, "utf8")) as {
      readonly kpi: {
        readonly query_embedding_cache_ready_rate?: number;
      };
    };
    const diagnostics = JSON.parse(await readFile(result.diagnosticsPath, "utf8")) as {
      readonly query_embedding_cache?: unknown;
    };

    expect(recall).toHaveBeenCalledTimes(1);
    expect(warmQueryEmbeddingCache).not.toHaveBeenCalled();
    expect(kpi.kpi.query_embedding_cache_ready_rate).toBeUndefined();
    expect(diagnostics.query_embedding_cache).toBeUndefined();
    expect(result.payload.kpi.recall_token_economy?.fine_priority_overflow_count)
      .toMatchObject({ mean: 1, max: 1 });
  });

  it("keeps answerless adversarial rows in the retrieval denominator while still using the abstention QA judge", async () => {
    loadLocomoMock.mockResolvedValue([
      {
        sample_id: "sample-1",
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "2026-05-20",
          session_1: [
            { speaker: "Alice", dia_id: "d1", text: "Alice keeps the violin receipt." },
            { speaker: "Bob", dia_id: "d2", text: "Bob talks about weather." }
          ]
        },
        qa: [
          {
            question: "Who keeps the violin receipt?",
            answer: "Alice",
            evidence: ["d1"],
            category: 1
          },
          {
            question: "What is Alice's PIN?",
            answer: "",
            evidence: ["d2"],
            category: 5
          }
        ]
      }
    ]);
    const replies = ["Alice", "yes", "I don't know.", "yes"];
    const qaChat = vi.fn(async () => replies.shift() ?? "yes");
    const recall = vi
      .fn()
      .mockImplementationOnce(async () => buildRecallResult("memory-d1"))
      .mockImplementationOnce(async () => buildRecallResult("memory-d2"));
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      qa: { chat: qaChat }
    });

    expect(result.payload.sample_size).toBe(2);
    expect(result.payload.evaluated_count).toBe(2);
    expect(result.payload.kpi.r_at_5).toBe(1);
    expect(qaChat).toHaveBeenCalledTimes(4);
    const abstentionJudgeUser =
      ((qaChat.mock.calls[3] as unknown as string[] | undefined)?.[1] ?? "");
    expect(abstentionJudgeUser).toContain("Explanation:");
  });
});
