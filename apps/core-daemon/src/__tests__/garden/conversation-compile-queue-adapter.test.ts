import { afterEach, describe, expect, it } from "vitest";
import { GardenRole, GardenTaskKind } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteGardenTaskRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createMessage } from "../../../../../packages/core/src/__tests__/conversation/conversation-service.test-support.js";
import { createConversationGardenCompileQueue } from "../../garden/conversation-compile-queue-adapter.js";
import { enqueuePostTurnExtractTask } from "../../mcp-memory/garden-task/post-turn-extract-queue.js";
import { createDeliveryRecord } from "../mcp-memory/garden/post-turn-extract-task-record-fixture.js";
import { parsePostTurnExtractTaskPayload } from "../../garden/post-turn-extract/task-payload.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function createRepo(): SqliteGardenTaskRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return new SqliteGardenTaskRepo(database.connection, {
    appendManyWithMutation: async (_events, mutate) => mutate([])
  });
}

describe("conversation garden compile queue", () => {
  it("persists a POST_TURN_EXTRACT task and treats a second enqueue as duplicate", () => {
    const gardenTaskRepo = createRepo();
    const queue = createConversationGardenCompileQueue({
      gardenTaskRepo,
      now: () => "2026-09-16T00:00:00.000Z"
    });
    const input = {
      workspaceId: "workspace-1",
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "Alice uses tools."),
      assistantMessage: createMessage("msg-assistant", "assistant", "Noted.")
    };

    expect(queue.enqueue(input)).toEqual({ status: "enqueued" });
    expect(queue.enqueue(input)).toEqual({ status: "duplicate" });

    const pending = gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe(GardenTaskKind.POST_TURN_EXTRACT);
    const payload = parsePostTurnExtractTaskPayload(pending[0]!.payload);
    expect(payload.turn_digest.last_messages).toEqual([
      expect.objectContaining({
        role: "user",
        content_excerpt: "Alice uses tools.",
        message_id: "msg-user"
      }),
      expect.objectContaining({
        role: "assistant",
        content_excerpt: "Noted.",
        message_id: "msg-assistant"
      })
    ]);
  });

  it("does not collide with a report_context_usage turn_index 0 task", () => {
    const gardenTaskRepo = createRepo();
    enqueuePostTurnExtractTask(
      { deps: { gardenTaskRepo }, now: () => "2026-09-16T00:00:00.000Z" },
      {
        delivery_id: "delivery-1",
        usage_state: "used",
        turn_index: 0,
        turn_digest: { last_messages: [{ role: "user", content_excerpt: "usage report" }] }
      },
      { workspaceId: "workspace-1", runId: "run-1", agentTarget: "codex", sessionId: "session-1" },
      createDeliveryRecord({ delivered_at: "2026-09-16T00:00:00.000Z" })
    );
    const queue = createConversationGardenCompileQueue({
      gardenTaskRepo,
      now: () => "2026-09-16T00:00:00.000Z"
    });

    expect(queue.enqueue({
      workspaceId: "workspace-1",
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "conversation turn"),
      assistantMessage: createMessage("msg-assistant", "assistant", "ok")
    })).toEqual({ status: "enqueued" });

    expect(gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 10)).toHaveLength(2);
  });

  it("does not persist a task when the repo throws", () => {
    const inner = createRepo();
    const gardenTaskRepo = {
      enqueue: () => {
        throw new Error("SQLITE_BUSY");
      },
      findById: (taskId: string) => inner.findById(taskId)
    };
    const queue = createConversationGardenCompileQueue({
      gardenTaskRepo,
      now: () => "2026-09-16T00:00:00.000Z"
    });

    expect(() =>
      queue.enqueue({
        workspaceId: "workspace-1",
        runId: "run-1",
        userMessage: createMessage("msg-user", "user", "remember this"),
        assistantMessage: createMessage("msg-assistant", "assistant", "noted")
      })
    ).toThrow("SQLITE_BUSY");
    expect(inner.peekPending(GardenRole.LIBRARIAN, "workspace-1", 10)).toEqual([]);
  });
});
