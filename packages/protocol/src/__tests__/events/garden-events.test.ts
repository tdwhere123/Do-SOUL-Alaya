import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../../events/event-log.js";
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
  GardenEventType,
  GardenEventTypeSchema,
  GardenEventUnionSchema,
  parseGardenEventPayload
} from "../../index.js";

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

  it("parses all garden payloads", () => {
    const dispatchedPayload = {
      task_id: "task-1",
      task_kind: GardenTaskKind.TTL_CLEANUP,
      role: GardenRole.JANITOR,
      tier: GardenTier.TIER_0,
      workspace_id: "workspace-1",
      run_id: "run-1",
      occurred_at: validTimestamp
    } as const;
    expect(parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED, dispatchedPayload)).toEqual(
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
    expect(parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, completedPayload)).toEqual(
      completedPayload
    );

    const reclaimedPayload = {
      task_id: "task-claim-stale",
      task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2,
      workspace_id: "workspace-1",
      run_id: "run-1",
      previous_claimed_by: "abandoned-agent",
      claimed_at: validTimestamp,
      stale_after_ms: 600_000,
      occurred_at: "2026-03-27T00:10:00.000Z"
    } as const;
    expect(
      parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED, reclaimedPayload)
    ).toEqual(reclaimedPayload);

    const rejectedPayload = {
      task_id: "task-3",
      task_kind: GardenTaskKind.MERGE_PROPOSAL,
      required_tier: GardenTier.TIER_2,
      role_tier: GardenTier.TIER_1,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED, rejectedPayload)
    ).toEqual(rejectedPayload);

    const enrichAbandonedPayload = {
      workspace_id: "workspace-1",
      memory_id: "memory-poison",
      source_signal_id: "signal-poison",
      run_id: "run-1",
      attempt_count: 5,
      last_failure_kind: "transient path-mint failure",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGardenEventPayload(GardenEventType.SOUL_ENRICH_ABANDONED, enrichAbandonedPayload)
    ).toEqual(enrichAbandonedPayload);

    // The owed work may be edge-production / conflict-detection only (no signal
    // ref); source_signal_id is nullable and run_id is nullable.
    const enrichAbandonedNoSignalPayload = {
      workspace_id: "workspace-1",
      memory_id: "memory-poison-2",
      source_signal_id: null,
      run_id: null,
      attempt_count: 5,
      last_failure_kind: "conflict repo lookup failed",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGardenEventPayload(GardenEventType.SOUL_ENRICH_ABANDONED, enrichAbandonedNoSignalPayload)
    ).toEqual(enrichAbandonedNoSignalPayload);

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
    expect(parseGardenEventPayload(GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED, recordedPayload)).toEqual(
      recordedPayload
    );

    const gardenComputeRecordedPayload = {
      entry_id: "entry-2",
      event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp,
      change_summary: {
        fields_changed: ["provider_url", "model_id", "secret_ref"],
        secret_ref_kind: "env",
        provider_url: "https://garden.example.test/v1",
        model_id: "gpt-4.1-mini"
      }
    } as const;
    expect(
      parseGardenEventPayload(GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED, gardenComputeRecordedPayload)
    ).toEqual(gardenComputeRecordedPayload);

    const keychainRecordedPayload = {
      entry_id: "entry-keychain",
      event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp,
      change_summary: {
        fields_changed: ["secret_ref"],
        secret_ref_kind: "keychain"
      }
    } as const;
    expect(parseGardenEventPayload(GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED, keychainRecordedPayload)).toEqual(
      keychainRecordedPayload
    );

    const clearedProviderUrlPayload = {
      entry_id: "entry-3",
      event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp,
      change_summary: {
        fields_changed: ["provider_url"],
        provider_url: null
      }
    } as const;
    expect(
      parseGardenEventPayload(GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED, clearedProviderUrlPayload)
    ).toEqual(clearedProviderUrlPayload);
  });

  it("rejects health journal change summaries that expose secret values", () => {
    expect(() =>
      parseGardenEventPayload(GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED, {
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

  it("keeps GardenEventTypeSchema aligned with the exported event constants", () => {
    expect(GardenEventTypeSchema.options).toEqual([
      GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
      GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED,
      GardenEventType.SOUL_GARDEN_TASK_EXPIRED,
      GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
      GardenEventType.SOUL_ENRICH_ABANDONED,
      GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED
    ]);
  });

  it("rejects unknown garden event types", () => {
    expect(() =>
      parseGardenEventPayload("soul.garden.unknown" as never, {
        occurred_at: validTimestamp
      })
    ).toThrow();
    expect(() => GardenEventTypeSchema.parse("soul.garden.unknown")).toThrow();
  });

  it("rejects malformed tier-violation payloads", () => {
    expect(() =>
      parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED, {
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
      type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      payload: {
        entry_id: "entry-1",
        event_kind: HealthEventKind.ARBITRATION,
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      }
    } as const;

    expect(GardenEventUnionSchema.parse(event)).toEqual(event);
  });

  it("accepts garden event types in the global EventType union", () => {
    expect(EventTypeSchema.parse(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED)).toBe(
      GardenEventType.SOUL_GARDEN_TASK_DISPATCHED
    );
    expect(EventTypeSchema.parse(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)).toBe(
      GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED
    );
    expect(EventTypeSchema.parse(GardenEventType.SOUL_ENRICH_ABANDONED)).toBe(
      GardenEventType.SOUL_ENRICH_ABANDONED
    );
    expect(EventTypeSchema.parse(GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED)).toBe(
      GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED
    );
  });

  it("parses additive completion truncation metadata and rejects an invalid digest", () => {
    const payload = {
      task_id: "task-2",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      role: GardenRole.AUDITOR,
      tier: GardenTier.TIER_1,
      success: true,
      objects_affected: ["green-1"],
      objects_affected_total_count: 600,
      objects_affected_sha256: "e2607f053c56cc67422d3a5dffbbfd997b811024ffea9bc85046d13b8557ca94",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;

    expect(parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, payload)).toEqual(
      payload
    );
    expect(() =>
      parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
        ...payload,
        objects_affected_sha256: "not-a-sha256"
      })
    ).toThrow();
    expect(() =>
      parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
        ...payload,
        objects_affected_sha256: undefined
      })
    ).toThrow();
    expect(() =>
      parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
        ...payload,
        objects_affected_total_count: payload.objects_affected.length
      })
    ).toThrow();
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
