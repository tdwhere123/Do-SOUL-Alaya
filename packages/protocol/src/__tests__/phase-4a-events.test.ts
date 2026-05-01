import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../event-log.js";
import {
  GARDEN_ROLE_TIER_MAP,
  GardenPermissionSchema,
  GardenRole,
  GardenTaskDescriptorSchema,
  GardenTaskKind,
  GardenTaskResultSchema,
  GardenTier,
  HealthEventKind,
  HealthEventKindSchema,
  HealthJournalEntrySchema,
  Phase4AEventType,
  Phase4AEventTypeSchema,
  Phase4AEventUnionSchema,
  parsePhase4AEventPayload
} from "../index.js";

const validTimestamp = "2026-03-27T00:00:00.000Z";

describe("Phase 4A protocol schemas", () => {
  it("parses a valid GardenTaskDescriptor", () => {
    const descriptor = {
      task_id: "task-1",
      task_kind: GardenTaskKind.POINTER_HEALTH_CHECK,
      required_tier: GardenTier.TIER_1,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_refs: ["memory-1", "evidence-1"],
      priority: 30,
      created_at: validTimestamp
    } as const;

    expect(GardenTaskDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it("rejects invalid descriptor tiers and out-of-range priorities", () => {
    expect(() =>
      GardenTaskDescriptorSchema.parse({
        task_id: "task-1",
        task_kind: GardenTaskKind.POINTER_HEALTH_CHECK,
        required_tier: "tier_9",
        workspace_id: "workspace-1",
        run_id: null,
        target_object_refs: ["memory-1"],
        priority: 30,
        created_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      GardenTaskDescriptorSchema.parse({
        task_id: "task-2",
        task_kind: GardenTaskKind.POINTER_HEALTH_CHECK,
        required_tier: GardenTier.TIER_1,
        workspace_id: "workspace-1",
        run_id: null,
        target_object_refs: ["memory-1"],
        priority: 101,
        created_at: validTimestamp
      })
    ).toThrow();
  });

  it("parses a valid health journal entry with null run_id", () => {
    const entry = {
      entry_id: "entry-1",
      event_kind: HealthEventKind.POINTER_FAILURE,
      workspace_id: "workspace-1",
      run_id: null,
      summary: "Pointer health check detected a broken reference",
      detail_json: {
        source_object_id: "memory-1",
        ref_kind: "evidence_ref",
        broken_ref: "evidence-1"
      },
      created_at: validTimestamp
    } as const;

    expect(HealthJournalEntrySchema.parse(entry)).toEqual(entry);
  });

  it("accepts pointer_failure and pointer_repair as health event kinds", () => {
    expect(HealthEventKindSchema.parse("pointer_failure")).toBe("pointer_failure");
    expect(HealthEventKind.POINTER_FAILURE).toBe("pointer_failure");
    expect(HealthEventKindSchema.parse("pointer_repair")).toBe("pointer_repair");
    expect(HealthEventKind.POINTER_REPAIR).toBe("pointer_repair");
  });

  it("rejects invalid health event kinds", () => {
    expect(() =>
      HealthJournalEntrySchema.parse({
        entry_id: "entry-1",
        event_kind: "garden_backlog_warning",
        workspace_id: "workspace-1",
        run_id: null,
        summary: "Garden queue depth exceeded threshold",
        detail_json: {},
        created_at: validTimestamp
      })
    ).toThrow();
    expect(() => HealthEventKindSchema.parse("garden_backlog_warning")).toThrow();
  });

  it("parses all phase-4a payloads", () => {
    const dispatchedPayload = {
      task_id: "task-1",
      task_kind: GardenTaskKind.TTL_CLEANUP,
      role: GardenRole.JANITOR,
      tier: GardenTier.TIER_0,
      workspace_id: "workspace-1",
      run_id: "run-1",
      occurred_at: validTimestamp
    } as const;
    expect(parsePhase4AEventPayload(Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED, dispatchedPayload)).toEqual(
      dispatchedPayload
    );

    const completedPayload = {
      task_id: "task-2",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      role: GardenRole.AUDITOR,
      tier: GardenTier.TIER_1,
      success: false,
      objects_affected: ["green-1", "memory-1"],
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(parsePhase4AEventPayload(Phase4AEventType.SOUL_GARDEN_TASK_COMPLETED, completedPayload)).toEqual(
      completedPayload
    );

    const rejectedPayload = {
      task_id: "task-3",
      task_kind: GardenTaskKind.MERGE_PROPOSAL,
      required_tier: GardenTier.TIER_2,
      role_tier: GardenTier.TIER_1,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parsePhase4AEventPayload(Phase4AEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED, rejectedPayload)
    ).toEqual(rejectedPayload);

    const recordedPayload = {
      entry_id: "entry-1",
      event_kind: HealthEventKind.EVIDENCE_FAILURE,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp,
      change_summary: {
        fields_changed: ["embedding_enabled", "secret_ref"],
        secret_ref_kind: "file"
      }
    } as const;
    expect(parsePhase4AEventPayload(Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED, recordedPayload)).toEqual(
      recordedPayload
    );
  });

  it("rejects health journal change summaries that expose secret values", () => {
    expect(() =>
      parsePhase4AEventPayload(Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED, {
        entry_id: "entry-1",
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        workspace_id: "workspace-1",
        occurred_at: validTimestamp,
        change_summary: {
          fields_changed: ["secret_ref"],
          secret_ref_kind: "sk-test-plaintext-secret"
        }
      })
    ).toThrow();
  });

  it("keeps Phase4AEventTypeSchema aligned with the exported event constants", () => {
    expect(Phase4AEventTypeSchema.options).toEqual([
      Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED,
      Phase4AEventType.SOUL_GARDEN_TASK_COMPLETED,
      Phase4AEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
      Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED
    ]);
  });

  it("rejects unknown phase-4a event types", () => {
    expect(() =>
      parsePhase4AEventPayload("soul.garden.unknown" as never, {
        occurred_at: validTimestamp
      })
    ).toThrow();
    expect(() => Phase4AEventTypeSchema.parse("soul.garden.unknown")).toThrow();
  });

  it("rejects malformed tier-violation payloads", () => {
    expect(() =>
      parsePhase4AEventPayload(Phase4AEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED, {
        task_id: "task-1",
        task_kind: GardenTaskKind.MERGE_PROPOSAL,
        role_tier: GardenTier.TIER_0,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-1",
        occurred_at: "not-a-date"
      })
    ).toThrow();
  });

  it("discriminates correctly on type", () => {
    const event = {
      type: Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      payload: {
        entry_id: "entry-1",
        event_kind: HealthEventKind.ARBITRATION,
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      }
    } as const;

    expect(Phase4AEventUnionSchema.parse(event)).toEqual(event);
  });

  it("accepts phase-4a event types in the global EventType union", () => {
    expect(EventTypeSchema.parse(Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED)).toBe(
      Phase4AEventType.SOUL_GARDEN_TASK_DISPATCHED
    );
    expect(EventTypeSchema.parse(Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED)).toBe(
      Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED
    );
  });

  it("parses GardenTaskResult without run_id", () => {
    const result = {
      task_id: "task-2",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      role: GardenRole.AUDITOR,
      tier: GardenTier.TIER_1,
      workspace_id: "workspace-1",
      success: true,
      objects_affected: ["green-1"],
      audit_entries: ["Auto-renewed non-hazard green status"],
      error_message: null,
      completed_at: validTimestamp
    } as const;

    expect(GardenTaskResultSchema.parse(result)).toEqual(result);
    expect(
      GardenTaskResultSchema.safeParse({
        ...result,
        run_id: "run-1"
      }).success
    ).toBe(false);
  });

  it("keeps GardenPermission locked to the per-role shape", () => {
    const permission = {
      role: GardenRole.AUDITOR,
      tier: GardenTier.TIER_1,
      allowed_task_kinds: [GardenTaskKind.EVIDENCE_STALENESS_CHECK, GardenTaskKind.GREEN_MAINTENANCE]
    } as const;

    expect(GardenPermissionSchema.parse(permission)).toEqual(permission);
    expect(() => GardenPermissionSchema.parse({ ...permission, task_kinds: [] })).toThrow();
    expect(GARDEN_ROLE_TIER_MAP[GardenRole.LIBRARIAN]).toBe(GardenTier.TIER_2);
  });
});
