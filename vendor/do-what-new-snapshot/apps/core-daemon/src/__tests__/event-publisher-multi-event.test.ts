import { describe, expect, it, vi } from "vitest";
import {
  Phase0EventType,
  WorkspaceDefaultEngineClassUpdatedPayloadSchema,
  WorkspaceEngineBindingUpdatedPayloadSchema,
  type EventLogEntry
} from "@do-what/protocol";
import { EventPublisher } from "@do-what/core";

describe("EventPublisher multi-event mutation", () => {
  it("appends all events before mutate, then propagates in order", async () => {
    const recorded: string[] = [];
    const bindingUpdatedInput = {
      event_type: Phase0EventType.WORKSPACE_ENGINE_BINDING_UPDATED,
      entity_type: "workspace",
      entity_id: "ws-1",
      workspace_id: "ws-1",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: WorkspaceEngineBindingUpdatedPayloadSchema.parse({
        workspace_id: "ws-1",
        binding_id: "binding-1",
        provider_type: "custom",
        model: "proxy-model",
        base_url: "https://proxy.example/v1"
      })
    } as const;
    const classUpdatedInput = {
      event_type: Phase0EventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED,
      entity_type: "workspace",
      entity_id: "ws-1",
      workspace_id: "ws-1",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: WorkspaceDefaultEngineClassUpdatedPayloadSchema.parse({
        workspace_id: "ws-1",
        default_engine_class: "conversation_engine"
      })
    } as const;
    const appendedEntries: EventLogEntry[] = [
      {
        ...bindingUpdatedInput,
        event_id: "evt_binding",
        created_at: "2026-04-15T00:00:00.000Z"
      },
      {
        ...classUpdatedInput,
        event_id: "evt_class",
        created_at: "2026-04-15T00:00:00.001Z"
      }
    ];
    const append = vi.fn(async () => {
      const next = appendedEntries[recorded.filter((step) => step.startsWith("append")).length];
      recorded.push(`append:${next.event_type}`);
      return next;
    });
    const publisher = new EventPublisher({
      eventLogRepo: {
        append,
        deleteById: vi.fn()
      },
      runHotStateService: {
        apply: vi.fn(async (event) => {
          recorded.push(`apply:${event.event_type}`);
        })
      } as any,
      sseBroadcaster: {
        broadcast: vi.fn(),
        broadcastEntry: vi.fn(async (entry) => {
          recorded.push(`broadcast:${entry.event_type}`);
        })
      }
    });

    const result = await publisher.publishManyWithMutation(
      [bindingUpdatedInput, classUpdatedInput],
      async () => {
        recorded.push("mutate");
        return "ok";
      }
    );

    expect(result).toBe("ok");
    expect(recorded).toEqual([
      "append:workspace.engine_binding.updated",
      "append:workspace.default_engine_class.updated",
      "mutate",
      "apply:workspace.engine_binding.updated",
      "broadcast:workspace.engine_binding.updated",
      "apply:workspace.default_engine_class.updated",
      "broadcast:workspace.default_engine_class.updated"
    ]);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("deletes all unbroadcast entries when mutate fails", async () => {
    const recorded: string[] = [];
    const bindingUpdatedInput = {
      event_type: Phase0EventType.WORKSPACE_ENGINE_BINDING_UPDATED,
      entity_type: "workspace",
      entity_id: "ws-1",
      workspace_id: "ws-1",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: WorkspaceEngineBindingUpdatedPayloadSchema.parse({
        workspace_id: "ws-1",
        binding_id: "binding-1",
        provider_type: "custom",
        model: "proxy-model",
        base_url: "https://proxy.example/v1"
      })
    } as const;
    const classUpdatedInput = {
      event_type: Phase0EventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED,
      entity_type: "workspace",
      entity_id: "ws-1",
      workspace_id: "ws-1",
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: WorkspaceDefaultEngineClassUpdatedPayloadSchema.parse({
        workspace_id: "ws-1",
        default_engine_class: "conversation_engine"
      })
    } as const;
    const appendedEntries: EventLogEntry[] = [
      {
        ...bindingUpdatedInput,
        event_id: "evt_binding",
        created_at: "2026-04-15T00:00:00.000Z"
      },
      {
        ...classUpdatedInput,
        event_id: "evt_class",
        created_at: "2026-04-15T00:00:00.001Z"
      }
    ];
    const deleteById = vi.fn(async (eventId: string) => {
      recorded.push(`delete:${eventId}`);
    });
    const append = vi.fn(async () => {
      const next = appendedEntries[recorded.filter((step) => step.startsWith("append")).length];
      recorded.push(`append:${next.event_type}`);
      return next;
    });
    const publisher = new EventPublisher({
      eventLogRepo: {
        append,
        deleteById
      },
      runHotStateService: {
        apply: vi.fn(async () => {
          recorded.push("apply");
        })
      } as any,
      sseBroadcaster: {
        broadcast: vi.fn(),
        broadcastEntry: vi.fn(async () => {
          recorded.push("broadcast");
        })
      }
    });

    await expect(
      publisher.publishManyWithMutation(
        [bindingUpdatedInput, classUpdatedInput],
        async () => {
          recorded.push("mutate");
          throw new Error("atomic write failed");
        }
      )
    ).rejects.toThrow("atomic write failed");

    expect(recorded).toEqual([
      "append:workspace.engine_binding.updated",
      "append:workspace.default_engine_class.updated",
      "mutate",
      "delete:evt_binding",
      "delete:evt_class"
    ]);
    expect(deleteById).toHaveBeenNthCalledWith(1, "evt_binding");
    expect(deleteById).toHaveBeenNthCalledWith(2, "evt_class");
  });
});
