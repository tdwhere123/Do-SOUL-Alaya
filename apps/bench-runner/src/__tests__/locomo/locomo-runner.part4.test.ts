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

describe("LoCoMo runner", () => {

  it("archives partial query warm-cache readiness without aborting scoring", async () => {
    const warmQueryEmbeddingCache = vi.fn(async (queryTexts: readonly string[]) => ({
      status: "ready" as const,
      requested_count: queryTexts.length,
      ready_count: 0,
      cache_hit_count: 0,
      provider_requested_count: queryTexts.length,
      missing_count: queryTexts.length,
      provider_kind: "openai",
      model_id: "text-embedding-3-small",
      last_error: "provider temporarily unreachable"
    }));
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
    // The LoCoMo seed loop drives the EARNED co-recall accrual once per session.
    expect(accrueSessionCoRecall).toHaveBeenCalled();
    const kpi = JSON.parse(await readFile(result.kpiPath, "utf8")) as {
      readonly kpi: {
        readonly query_embedding_cache_ready_rate?: number;
      };
    };
    const diagnostics = JSON.parse(await readFile(result.diagnosticsPath, "utf8")) as {
      readonly query_embedding_cache?: {
        readonly requested_count: number;
        readonly ready_count: number;
        readonly ready_rate: number;
        readonly last_error?: string;
      };
    };

    expect(recall).toHaveBeenCalledTimes(1);
    expect(kpi.kpi.query_embedding_cache_ready_rate).toBe(0);
    expect(diagnostics.query_embedding_cache).toEqual(
      expect.objectContaining({
        requested_count: 1,
        ready_count: 0,
        ready_rate: 0,
        last_error: "provider temporarily unreachable"
      })
    );
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
