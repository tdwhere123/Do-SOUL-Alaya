import { describe, expect, it, vi } from "vitest";
import { createGardenTaskCompletionHandler } from
  "../../../mcp-memory/garden-task/garden-task-completion.js";
import { GardenTaskUnavailableError } from
  "../../../mcp-memory/garden-task/garden-task-handler-support.js";

describe("createGardenTaskCompletionHandler", () => {
  it("throws GardenTaskUnavailableError when the garden task repo is missing", async () => {
    const handler = createGardenTaskCompletionHandler({
      deps: {
        signalService: {
          receiveSignal: vi.fn(async (signal) => ({ signal }))
        }
      },
      now: () => "2026-08-18T00:00:00.000Z",
      warn: vi.fn(),
      generateId: () => "id-1"
    });

    await expect(handler.completeGardenTask(
      { task_id: "task-1", status: "completed" },
      { workspaceId: "workspace-1", runId: "run-1", agentTarget: "agent-1" }
    )).rejects.toBeInstanceOf(GardenTaskUnavailableError);
  });
});
