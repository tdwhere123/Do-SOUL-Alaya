import { describe, expect, it } from "vitest";
import { EventTypeSchema, ProjectMappingState } from "../index.js";

const validTimestamp = "2026-03-29T00:00:00.000Z";

describe("Phase 4C event schemas", () => {
  it("parses all phase-4c payloads and adds them to the global event union", async () => {
    const protocol = (await import("../" + "index.js")) as Record<string, unknown>;
    const Phase4CEventType = protocol.Phase4CEventType as Record<string, string>;
    const Phase4CEventTypeSchema = protocol.Phase4CEventTypeSchema as {
      options: readonly string[];
      parse: (value: unknown) => unknown;
    };
    const Phase4CEventUnionSchema = protocol.Phase4CEventUnionSchema as { parse: (value: unknown) => unknown };
    const parsePhase4CEventPayload = protocol.parsePhase4CEventPayload as (
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
    expect(parsePhase4CEventPayload(Phase4CEventType.PROJECT_MAPPING_SUGGESTED, suggestedPayload)).toEqual(
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
    expect(parsePhase4CEventPayload(Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED, stateChangedPayload)).toEqual(
      stateChangedPayload
    );

    expect(Phase4CEventTypeSchema.options).toEqual([
      Phase4CEventType.PROJECT_MAPPING_SUGGESTED,
      Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED
    ]);

    expect(
      Phase4CEventUnionSchema.parse({
        type: Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED,
        payload: stateChangedPayload
      })
    ).toEqual({
      type: Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED,
      payload: stateChangedPayload
    });

    expect(EventTypeSchema.parse(Phase4CEventType.PROJECT_MAPPING_SUGGESTED)).toBe(
      Phase4CEventType.PROJECT_MAPPING_SUGGESTED
    );
    expect(EventTypeSchema.parse(Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED)).toBe(
      Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED
    );
  });

  it("rejects invalid phase-4c payloads", async () => {
    const protocol = (await import("../" + "index.js")) as Record<string, unknown>;
    const Phase4CEventType = protocol.Phase4CEventType as Record<string, string>;
    const parsePhase4CEventPayload = protocol.parsePhase4CEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;

    expect(() =>
      parsePhase4CEventPayload(Phase4CEventType.PROJECT_MAPPING_SUGGESTED, {
        mapping_id: "mapping-1",
        global_object_id: "memory-1",
        workspace_id: "workspace-1",
        suggested_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      parsePhase4CEventPayload(Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED, {
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
