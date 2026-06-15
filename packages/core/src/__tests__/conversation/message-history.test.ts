import { describe, expect, it } from "vitest";
import {
  StreamingEventType,
  WorkspaceRunEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  rebuildConversationMessages,
  rebuildMessageHistory
} from "../../conversation/message-history.js";

describe("message history rebuild", () => {
  it("returns empty histories when no message-bearing events are present", () => {
    const events = [
      createEvent({
        event_type: WorkspaceRunEventType.RUN_CREATED,
        entity_type: "run",
        entity_id: "run-1",
        payload_json: {
          run_id: "run-1",
          workspace_id: "workspace-1",
          run_mode: "chat",
          title: "No messages yet"
        }
      })
    ];

    expect(rebuildConversationMessages([])).toEqual([]);
    expect(rebuildMessageHistory(events)).toEqual([]);
  });

  it("rebuilds user, non-streaming assistant, and streaming assistant messages in event order", () => {
    const events = [
      createEvent({
        event_id: "evt-user",
        event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
        entity_type: "message",
        entity_id: "msg-user",
        created_at: "2026-06-01T00:00:01.000Z",
        payload_json: {
          run_id: "run-1",
          role: "user",
          content: "Summarize the memory plane.",
          message_id: "msg-user",
          file_ids: ["file-1", "file-2"]
        }
      }),
      createEvent({
        event_id: "evt-engine",
        event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
        entity_type: "message",
        entity_id: "msg-engine",
        created_at: "2026-06-01T00:00:02.000Z",
        caused_by: "engine",
        payload_json: {
          run_id: "run-1",
          message_id: "msg-engine",
          content: "Memory objects are ontology.",
          finish_reason: "stop"
        }
      }),
      createEvent({
        event_id: "evt-stream",
        event_type: StreamingEventType.MESSAGE_COMPLETED,
        entity_type: "message",
        entity_id: "msg-stream",
        created_at: "2026-06-01T00:00:03.000Z",
        caused_by: "engine",
        payload_json: {
          type: "message.completed",
          runId: "run-1",
          messageId: "msg-stream",
          content: "Surfaces route truth; they are not truth.",
          finishReason: "stop",
          timestamp: "2026-06-01T00:00:03.000Z"
        }
      })
    ];

    expect(rebuildConversationMessages(events)).toEqual([
      {
        message_id: "msg-user",
        role: "user",
        content: "Summarize the memory plane.",
        file_ids: ["file-1", "file-2"]
      },
      {
        message_id: "msg-engine",
        role: "assistant",
        content: "Memory objects are ontology."
      },
      {
        message_id: "msg-stream",
        role: "assistant",
        content: "Surfaces route truth; they are not truth."
      }
    ]);
    expect(rebuildMessageHistory(events)).toEqual([
      {
        role: "user",
        content: "Summarize the memory plane."
      },
      {
        role: "assistant",
        content: "Memory objects are ontology."
      },
      {
        role: "assistant",
        content: "Surfaces route truth; they are not truth."
      }
    ]);
  });

  it("preserves duplicate message events and large histories for the caller-owned budget layer", () => {
    const duplicate = createEvent({
      event_id: "evt-duplicate-1",
      event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
      entity_type: "message",
      entity_id: "msg-duplicate",
      payload_json: {
        run_id: "run-1",
        role: "user",
        content: "Repeatable input",
        message_id: "msg-duplicate"
      }
    });
    const largeHistory = Array.from({ length: 64 }, (_, index) =>
      createEvent({
        event_id: `evt-large-${index}`,
        event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
        entity_type: "message",
        entity_id: `msg-large-${index}`,
        created_at: `2026-06-01T00:${String(1 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        payload_json: {
          run_id: "run-1",
          role: "user",
          content: `message ${index}`,
          message_id: `msg-large-${index}`
        }
      })
    );

    const messages = rebuildConversationMessages([duplicate, duplicate, ...largeHistory]);

    expect(messages).toHaveLength(66);
    expect(messages.slice(0, 2)).toEqual([
      {
        message_id: "msg-duplicate",
        role: "user",
        content: "Repeatable input"
      },
      {
        message_id: "msg-duplicate",
        role: "user",
        content: "Repeatable input"
      }
    ]);
    expect(messages.at(-1)).toEqual({
      message_id: "msg-large-63",
      role: "user",
      content: "message 63"
    });
  });
});

function createEvent(
  overrides: Partial<EventLogEntry> & Pick<EventLogEntry, "event_type" | "entity_type" | "entity_id">
): EventLogEntry {
  return {
    event_id: overrides.event_id ?? `${overrides.event_type}-${overrides.entity_id}`,
    created_at: overrides.created_at ?? "2026-06-01T00:00:00.000Z",
    event_type: overrides.event_type,
    entity_type: overrides.entity_type,
    entity_id: overrides.entity_id,
    workspace_id: overrides.workspace_id ?? "workspace-1",
    run_id: overrides.run_id ?? "run-1",
    caused_by: overrides.caused_by ?? "system",
    revision: overrides.revision ?? 0,
    payload_json: overrides.payload_json ?? {}
  };
}
