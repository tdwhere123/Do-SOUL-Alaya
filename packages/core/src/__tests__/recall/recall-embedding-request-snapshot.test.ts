import { describe, expect, it, vi } from "vitest";
import { RecallService, runConditionalFieldRecall } from "../../recall/recall-service.js";
import { createDependencies, createTaskSurface } from "./recall-service-test-fixtures.js";

describe("conditional Recall request snapshot", () => {
  it("executes the target under one snapshot without invoking legacy embedding phases", async () => {
    const events: string[] = [];
    const { dependencies, appendSpy } = createDependencies([]);
    const querySupplement = vi.fn(async () => { throw new Error("query provider forbidden"); });
    const prepareRecallEmbeddingSnapshot = vi.fn(async () => { throw new Error("legacy embedding phase forbidden"); });
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy,
      readSnapshot: {
        beginDeferred: () => { events.push("begin"); },
        commit: () => { events.push("commit"); },
        rollback: () => { events.push("rollback"); }
      },
      embeddingRecallService: { querySupplement, prepareRecallEmbeddingSnapshot },
      conditionalFieldPort: {
        recall: async (request) => {
          expect(events).toEqual(["begin"]);
          expect(request.query_text).toBe("deployment checklist");
          events.push("observe");
          return { index: runConditionalFieldRecall({ ...request, readers: {} }), previews: {} };
        }
      }
    });
    const result = await service.recall({ taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", strategy: "analyze", queryText: "deployment checklist" });
    expect(events).toEqual(["begin", "observe", "commit"]);
    expect(result.index.completeness.observed_coverage).toBe("unavailable");
    expect(result.provider_calls).toBe(0);
    expect(querySupplement).not.toHaveBeenCalled();
    expect(prepareRecallEmbeddingSnapshot).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("rolls back a failed target read and retains the original fault without provider fallback", async () => {
    const events: string[] = [];
    const { dependencies, appendSpy } = createDependencies([]);
    const failure = new Error("snapshot source failed");
    const querySupplement = vi.fn(async () => { throw new Error("query provider forbidden"); });
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy,
      readSnapshot: {
        beginDeferred: () => { events.push("begin"); },
        commit: () => { events.push("commit"); },
        rollback: () => { events.push("rollback"); }
      },
      embeddingRecallService: { querySupplement },
      conditionalFieldPort: { recall: async () => { throw failure; } }
    });
    await expect(service.recall({ taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", strategy: "analyze" })).rejects.toBe(failure);
    expect(events).toEqual(["begin", "rollback"]);
    expect(querySupplement).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
  });
});
