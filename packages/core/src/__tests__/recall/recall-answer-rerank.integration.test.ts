import { describe, expect, it } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("RecallService answer rerank integration", () => {
  it("keeps answer rerank idle and preserves fusion output", async () => {
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
    const result = await new RecallService(dependencies).recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(result.diagnostics).toMatchObject({
      answer_rerank_status: "not_requested",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: null
    });
  });
});
