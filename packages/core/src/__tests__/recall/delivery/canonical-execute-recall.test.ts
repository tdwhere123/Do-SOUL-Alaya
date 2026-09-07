import { describe, expect, it } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import { createDependencies, createMemoryEntry, createTaskSurface } from "../recall-service-test-fixtures.js";

describe("ordinary Recall snapshot lifecycle", () => {
  it("commits the read snapshot without writing EventLog state", async () => {
    const events: string[] = [];
    const memory = createMemoryEntry({
      object_id: "memory-snapshot",
      content: "I take yoga classes at Serenity Yoga."
    });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy,
      readSnapshot: {
        beginDeferred: () => { events.push("begin"); },
        commit: () => { events.push("commit"); },
        rollback: () => { events.push("rollback"); }
      },
      eventLogRepo: {
        ...dependencies.eventLogRepo,
        append: async (...args) => {
          events.push("side-effect");
          return await dependencies.eventLogRepo.append(...args);
        }
      }
    });

    await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(events.indexOf("begin")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("commit")).toBeGreaterThan(events.indexOf("begin"));
    expect(events).not.toContain("side-effect");
    expect(events).not.toContain("rollback");
  });

});
