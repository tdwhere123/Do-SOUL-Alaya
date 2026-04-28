import { describe, expect, it, vi } from "vitest";
import { Phase3AEventType, RunMode, type EventLogEntry } from "@do-what/protocol";
import { STRATEGY_RECALL_DEFAULTS, TaskSurfaceBuilder } from "../task-surface-builder.js";

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at">): EventLogEntry {
  return {
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-23T00:00:00.000Z",
    ...event
  };
}

describe("TaskSurfaceBuilder", () => {
  it("build returns valid TaskObjectSurface and emits event", async () => {
    const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => createEventLogEntry(event));
    const builder = new TaskSurfaceBuilder({
      now: () => "2026-03-23T00:00:00.000Z",
      generateRuntimeId: () => "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      eventLogRepo: {
        append: appendSpy,
        queryByEntity: vi.fn(async () => [])
      },
      surfaceRepo: {
        findBySurfaceId: vi.fn(async () => ({
          object_id: "11111111-1111-4111-8111-111111111111",
          object_kind: "surface_identity",
          schema_version: 1,
          lifecycle_state: "active",
          created_at: "2026-03-22T00:00:00.000Z",
          updated_at: "2026-03-22T00:00:00.000Z",
          created_by: "system",
          surface_id: "surface://code-editor",
          surface_kind: "code-editor",
          surface_status: "active",
          workspace_id: "workspace-1"
        } as const))
      }
    });

    const taskSurface = await builder.build({
      run: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: RunMode.CHAT,
        title: "Implement recall"
      },
      surfaceId: "surface://code-editor",
      contextRefs: ["context-1"]
    });

    expect(taskSurface.object_kind).toBe("task_object_surface");
    expect(taskSurface.surface_kind).toBe("code-editor");
    expect(taskSurface.display_name).toBe("Implement recall");
    expect(taskSurface.retention_policy).toBe("session_only");
    expect(taskSurface.expires_at).toBe("2026-03-23T00:30:00.000Z");
    expect(taskSurface.context_refs).toEqual(["context-1"]);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase3AEventType.SOUL_TASK_SURFACE_CREATED,
        entity_type: "task_object_surface",
        entity_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        revision: 0
      })
    );
  });

  it("falls back to run_mode strategy when surface is missing", async () => {
    const builder = new TaskSurfaceBuilder({
      now: () => "2026-03-23T00:00:00.000Z",
      generateRuntimeId: () => "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      eventLogRepo: {
        append: vi.fn(async (event) => createEventLogEntry(event)),
        queryByEntity: vi.fn(async () => [])
      },
      surfaceRepo: {
        findBySurfaceId: vi.fn(async () => null)
      }
    });

    const taskSurface = await builder.build({
      run: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: RunMode.BUILD,
        title: "Build mode run"
      },
      surfaceId: "surface://missing"
    });

    expect(taskSurface.surface_kind).toBe("build");
  });
  it("strategy defaults keep the keyword supplement enabled with a capped supplement budget", () => {
    expect(STRATEGY_RECALL_DEFAULTS.chat.coarse.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
    expect(STRATEGY_RECALL_DEFAULTS.analyze.coarse.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
    expect(STRATEGY_RECALL_DEFAULTS.build.coarse.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
    expect(STRATEGY_RECALL_DEFAULTS.govern.coarse.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
  });

  it("resolves build strategy from code-editor surface kind", () => {
    const builder = new TaskSurfaceBuilder({
      eventLogRepo: {
        append: vi.fn(async (event) => createEventLogEntry(event)),
        queryByEntity: vi.fn(async () => [])
      }
    });

    expect(builder.resolveStrategy("code-editor")).toBe("build");
    expect(builder.resolveStrategy("analyze-me")).toBe("analyze");
    expect(builder.resolveStrategy("governance")).toBe("govern");
    expect(builder.resolveStrategy("general-chat")).toBe("chat");
    expect(builder.resolveStrategy("")).toBe("chat");
    expect(builder.resolveStrategy("unknown-xyz")).toBe("chat");
  });
});
