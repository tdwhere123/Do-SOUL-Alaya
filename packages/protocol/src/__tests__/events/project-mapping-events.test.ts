import { describe, expect, it } from "vitest";
import { EventTypeSchema, ProjectMappingState } from "../../index.js";

const validTimestamp = "2026-03-29T00:00:00.000Z";

describe("Phase 4C event schemas", () => {
  it("parses all project-mapping payloads and adds them to the global event union", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const ProjectMappingEventType = protocol.ProjectMappingEventType as Record<string, string>;
    const ProjectMappingEventTypeSchema = protocol.ProjectMappingEventTypeSchema as {
      options: readonly string[];
      parse: (value: unknown) => unknown;
    };
    const ProjectMappingEventUnionSchema = protocol.ProjectMappingEventUnionSchema as { parse: (value: unknown) => unknown };
    const parseProjectMappingEventPayload = protocol.parseProjectMappingEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;

    const suggestedPayload = {
      mapping_id: "mapping-1",
      global_object_id: "memory-1",
      workspace_id: "workspace-1",
      initial_state: ProjectMappingState.SUGGESTED,
      suggested_at: validTimestamp
    } as const;
    expect(parseProjectMappingEventPayload(ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED!, suggestedPayload)).toEqual(
      suggestedPayload
    );

    const stateChangedPayload = {
      mapping_id: "mapping-1",
      global_object_id: "memory-1",
      workspace_id: "workspace-1",
      from_state: ProjectMappingState.SUGGESTED,
      to_state: ProjectMappingState.ACCEPTED,
      accepted_by: "user",
      transitioned_at: validTimestamp
    } as const;
    expect(parseProjectMappingEventPayload(ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED!, stateChangedPayload)).toEqual(
      stateChangedPayload
    );

    expect(ProjectMappingEventTypeSchema.options).toEqual([
      ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED!,
      ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED!
    ]);

    expect(
      ProjectMappingEventUnionSchema.parse({
        type: ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED!,
        payload: stateChangedPayload
      })
    ).toEqual({
      type: ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED!,
      payload: stateChangedPayload
    });

    expect(EventTypeSchema.parse(ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED!)).toBe(
      ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED!
    );
    expect(EventTypeSchema.parse(ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED!)).toBe(
      ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED!
    );
  });

  it("rejects invalid project-mapping payloads", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const ProjectMappingEventType = protocol.ProjectMappingEventType as Record<string, string>;
    const parseProjectMappingEventPayload = protocol.parseProjectMappingEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;

    expect(() =>
      parseProjectMappingEventPayload(ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED!, {
        mapping_id: "mapping-1",
        global_object_id: "memory-1",
        workspace_id: "workspace-1",
        suggested_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      parseProjectMappingEventPayload(ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED!, {
        mapping_id: "mapping-1",
        global_object_id: "memory-1",
        workspace_id: "workspace-1",
        from_state: ProjectMappingState.SUGGESTED,
        to_state: ProjectMappingState.ACCEPTED,
        accepted_by: "invalid",
        transitioned_at: validTimestamp
      })
    ).toThrow();
  });
});
