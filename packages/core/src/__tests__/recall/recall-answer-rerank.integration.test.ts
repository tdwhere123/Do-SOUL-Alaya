import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("RecallService answer rerank integration", () => {
  it("keeps an installed scorer idle and preserves fusion output", async () => {
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
    const score = vi.fn(async () => {
      throw new Error("secret model path");
    });
    const baseline = await new RecallService(dependencies).recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });
    const installed = await new RecallService({
      ...dependencies,
      answerRerankService: { score }
    }).recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(score).not.toHaveBeenCalled();
    expect(installed.candidates).toEqual(baseline.candidates);
    expect(installed.diagnostics).toMatchObject({
      answer_rerank_status: "not_requested",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: null
    });
    expect(JSON.stringify(installed.diagnostics)).not.toContain("secret model path");
  });
});
