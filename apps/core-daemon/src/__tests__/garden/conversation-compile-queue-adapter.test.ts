import { afterEach, describe, expect, it } from "vitest";
import { GardenRole, GardenTaskKind } from "@do-soul/alaya-protocol";
import { createInMemoryFieldStores, createSourceAdmissionPort, fieldContractSha256 } from "@do-soul/alaya-core";
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
  it("dates each retained message with its own observation time", async () => {
    const stores = createInMemoryFieldStores();
    const queue = createConversationGardenCompileQueue({ gardenTaskRepo: createRepo(),
      now: () => "2026-09-16T01:00:00.000Z", sourceAdmission: createSourceAdmissionPort({ stores, sha256: fieldContractSha256,
        audit: async () => undefined,
        hostCaptureBinding: request => ({ namespace: "alaya", workspace_id: request.workspace_id,
          producer: "post-turn", basis: "reported_excerpt" }) }) });
    const userAt = "2026-09-16T00:00:00.000Z", assistantAt = "2026-09-16T00:00:10.000Z";
    await queue.enqueue({ workspaceId: "workspace-1", runId: "run-1",
      userMessage: { ...createMessage("msg-user", "user", "  Question?\r\n"), created_at: userAt },
      assistantMessage: { ...createMessage("msg-assistant", "assistant", "  Answer.\n"), created_at: assistantAt } });
    const sources = stores.listStoredRecords("workspace-1");
    expect(sources.find(row => row.record.source_representation?.kind === "retained_excerpt" && row.record.speaker === "user"))
      .toMatchObject({ content_bytes: "  Question?\r\n", record: { event_time: userAt } });
    expect(sources.find(row => row.record.source_representation?.kind === "retained_excerpt" && row.record.speaker === "assistant"))
      .toMatchObject({ content_bytes: "  Answer.\n", record: { event_time: assistantAt } });
    expect(sources.find(row => row.record.source_representation?.kind === "canonical_projection")?.record.event_time).toBe(userAt);
  });

  it("persists a POST_TURN_EXTRACT task and treats a second enqueue as duplicate", async () => {
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

    expect(await queue.enqueue(input)).toEqual({ status: "enqueued" });
    expect(await queue.enqueue(input)).toEqual({ status: "duplicate" });

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

  it("does not collide with a report_context_usage turn_index 0 task", async () => {
    const gardenTaskRepo = createRepo();
    await enqueuePostTurnExtractTask(
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

    expect(await queue.enqueue({
      workspaceId: "workspace-1",
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "conversation turn"),
      assistantMessage: createMessage("msg-assistant", "assistant", "ok")
    })).toEqual({ status: "enqueued" });

    expect(gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 10)).toHaveLength(2);
  });

  it("does not persist a task when the repo throws", async () => {
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

    await expect(
      queue.enqueue({
        workspaceId: "workspace-1",
        runId: "run-1",
        userMessage: createMessage("msg-user", "user", "remember this"),
        assistantMessage: createMessage("msg-assistant", "assistant", "noted")
      })
    ).rejects.toThrow("SQLITE_BUSY");
    expect(inner.peekPending(GardenRole.LIBRARIAN, "workspace-1", 10)).toEqual([]);
  });
});
