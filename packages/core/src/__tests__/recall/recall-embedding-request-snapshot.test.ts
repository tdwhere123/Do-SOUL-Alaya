import { describe, expect, it } from "vitest";
import { RecallService, runConditionalFieldRecall } from "../../recall/recall-service.js";
import { createDependencies, createTaskSurface } from "./recall-service-test-fixtures.js";

describe("conditional Recall request snapshot", () => {
  it("executes the target under one snapshot and exposes unavailable observers", async () => {
    const events: string[] = [];
    const { dependencies } = createDependencies();
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy,
      readSnapshot: {
        beginDeferred: () => { events.push("begin"); },
        commit: () => { events.push("commit"); },
        rollback: () => { events.push("rollback"); }
      },
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
  });

  it("rolls back a failed target read and retains the original fault without replacing its failure", async () => {
    const events: string[] = [];
    const { dependencies } = createDependencies();
    const failure = new Error("snapshot source failed");
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy,
      readSnapshot: {
        beginDeferred: () => { events.push("begin"); },
        commit: () => { events.push("commit"); },
        rollback: () => { events.push("rollback"); }
      },
      conditionalFieldPort: { recall: async () => { throw failure; } }
    });
    await expect(service.recall({ taskSurface: createTaskSurface(),
      workspaceId: "workspace-1", strategy: "analyze" })).rejects.toBe(failure);
    expect(events).toEqual(["begin", "rollback"]);
  });
});
