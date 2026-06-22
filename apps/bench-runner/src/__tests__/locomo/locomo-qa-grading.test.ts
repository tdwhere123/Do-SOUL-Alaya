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
import { runLocomo } from "../../locomo/runner.js";

describe("LoCoMo runner", () => {

  it("keeps category-5 rows with an explicit gold answer scoreable as factual QA", async () => {
    loadLocomoMock.mockResolvedValue([
      {
        sample_id: "sample-1",
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "2026-05-20",
          session_1: [
            { speaker: "Alice", dia_id: "d1", text: "Alice owns a cat named Oscar." },
            { speaker: "Bob", dia_id: "d2", text: "Oscar belongs to Alice, not Melanie." }
          ]
        },
        qa: [
          {
            question: "Is Oscar Melanie's pet?",
            answer: "No",
            adversarial_answer: "Yes",
            evidence: ["d2"],
            category: 5
          }
        ]
      }
    ]);
    const qaChat = vi.fn(async (system: string, user: string) => {
      if (user.includes("Correct Answer:")) return "yes";
      if (system.includes("strict grader")) return "yes";
      return "No";
    });
    const recall = vi.fn(async () => buildRecallResult("memory-d2"));
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      qa: { chat: qaChat }
    });

    expect(result.payload.sample_size).toBe(1);
    expect(result.payload.evaluated_count).toBe(1);
    expect(result.payload.kpi.r_at_5).toBe(1);
    expect(qaChat).toHaveBeenCalledTimes(2);
    const factualJudgeUser =
      ((qaChat.mock.calls[1] as unknown as string[] | undefined)?.[1] ?? "");
    expect(factualJudgeUser).toContain("Correct Answer: No");
    expect(factualJudgeUser).not.toContain("Explanation:");
  });

  it("routes category-3 LoCoMo QA through the aggregation answer prompt", async () => {
    vi.stubEnv("ALAYA_BENCH_QA_WIDE_AGG", "1");
    loadLocomoMock.mockResolvedValue([
      {
        sample_id: "sample-1",
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "2026-05-20",
          session_1: [
            { speaker: "Alice", dia_id: "d1", text: "Alice planned a mural project." },
            { speaker: "Bob", dia_id: "d2", text: "Bob mentioned a violin project." }
          ]
        },
        qa: [
          {
            question: "How many projects were mentioned?",
            answer: "2",
            evidence: ["d1", "d2"],
            category: 3
          }
        ]
      }
    ]);
    const qaChat = vi.fn(async (system: string) => {
      if (system.includes("strict grader")) return "yes";
      return "2";
    });
    const recall = vi.fn(async () => buildRecallResult("memory-d1"));
    startBenchDaemonMock.mockResolvedValue(buildMockDaemon({ recall }));

    const result = await runLocomo({
      variant: "locomo10",
      historyRoot: tmpDir,
      qa: { chat: qaChat, answerModel: "answer-test", judgeModel: "judge-test" }
    });

    expect(result.payload.sample_size).toBe(1);
    expect(result.payload.evaluated_count).toBe(1);
    expect(result.payload.kpi.r_at_5).toBe(1);
    expect(
      (recall.mock.calls[0] as unknown as unknown[] | undefined)?.[1]
    ).toMatchObject({ maxResults: 20 });
    expect(result.payload.kpi.qa_metrics).toMatchObject({
      answer_model: "answer-test",
      judge_model: "judge-test",
      delivery_settings: expect.objectContaining({
        wide_agg_enabled: true
      })
    });
    const aggregationAnswerSystem =
      ((qaChat.mock.calls[0] as unknown as string[] | undefined)?.[0] ?? "");
    expect(aggregationAnswerSystem).toContain("aggregate across the whole history");
  });
});
