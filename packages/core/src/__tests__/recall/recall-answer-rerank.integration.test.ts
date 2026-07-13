import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("RecallService answer rerank integration", () => {
  it("uses the optional scorer after fusion and projects its final scalar", async () => {
    const first = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      content: "Implement recall with the established first approach.",
      activation_score: 0.9
    });
    const answer = createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      content: "Implement recall with the answer-relevant second approach.",
      activation_score: 0.1
    });
    const { dependencies } = createDependencies([first, answer]);
    const score = vi.fn(async (_query: string, passages: readonly string[]) =>
      passages.map((passage) => passage.includes("second") ? 0.9 : 0.1)
    );
    const service = new RecallService({
      ...dependencies,
      answerRerankService: { score }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(score).toHaveBeenCalledTimes(1);
    expect(result.candidates[0]?.object_id).toBe(answer.object_id);
    expect(result.candidates[0]?.relevance_score).toBe(0.9);
    expect(result.candidates[0]?.score_factors?.content_relevance).not.toBe(0.9);
    expect(result.diagnostics).toMatchObject({
      answer_rerank_status: "returned",
      answer_rerank_expected_count: 2,
      answer_rerank_scored_count: 2,
      answer_rerank_failure_class: null
    });
  });

  it("surfaces a stable failure class while preserving fusion output", async () => {
    const first = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      content: "first",
      activation_score: 0.9
    });
    const { dependencies } = createDependencies([first]);
    const baseline = await new RecallService(dependencies).recall({
      taskSurface: createTaskSurface(), workspaceId: "workspace-1", strategy: "build"
    });
    const failed = await new RecallService({
      ...dependencies,
      answerRerankService: { score: async () => { throw new Error("secret model path"); } }
    }).recall({
      taskSurface: createTaskSurface(), workspaceId: "workspace-1", strategy: "build"
    });

    expect(failed.candidates).toEqual(baseline.candidates);
    expect(baseline.diagnostics).toMatchObject({
      answer_rerank_status: "not_requested",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: null
    });
    expect(failed.diagnostics).toMatchObject({
      answer_rerank_status: "failed",
      answer_rerank_expected_count: 1,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: "service_error"
    });
    expect(JSON.stringify(failed.diagnostics)).not.toContain("secret model path");
  });

  it("marks an installed scorer not applicable when the normalized query is empty", async () => {
    const score = vi.fn(async () => [0.5]);
    const { dependencies } = createDependencies([]);
    const result = await new RecallService({
      ...dependencies,
      answerRerankService: { score }
    }).recall({
      taskSurface: { ...createTaskSurface(), display_name: "   " },
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(score).not.toHaveBeenCalled();
    expect(result.diagnostics).toMatchObject({
      answer_rerank_status: "not_applicable",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: null
    });
  });
});
