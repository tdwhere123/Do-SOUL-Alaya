import { describe, expect, it } from "vitest";
import { EventLogEntrySchema, EventTypeSchema } from "../event-log.js";
import {
  GARDEN_ROLE_PERMISSIONS,
  GardenTaskKind,
  GardenTaskKindSchema,
  GardenRole,
  HealthEventKind,
  HealthEventKindSchema,
  ComputeRecallGardenEventType,
  ComputeRecallGardenEventTypeSchema,
  ComputeRecallGardenEventUnionSchema,
  parseComputeRecallGardenEventPayload
} from "../index.js";

const validTimestamp = "2026-04-23T08:00:00.000Z";

describe("Phase C extension protocol schemas", () => {
  it("pins the exact C-23 enum delta and garden permission wiring", () => {
    expect(Object.values(GardenTaskKind)).toEqual([
      "ttl_cleanup",
      "hot_index_demotion",
      "dormant_demotion",
      "tombstone_gc",
      "evidence_staleness_check",
      "pointer_health_check",
      "green_maintenance",
      "bootstrapping_scan",
      "crystallization_scan",
      "pointer_healing",
      "orphan_detection",
      "event_log_orphan_detection",
      "merge_proposal",
      "path_graph_snapshot",
      "subject_neighbor_detect",
      "path_compression",
      "template_candidate",
      "synthesis_review",
      "embedding_backfill",
      "path_plasticity_update",
      "post_turn_extract"
    ]);
    expect(GardenTaskKindSchema.parse("embedding_backfill")).toBe("embedding_backfill");
    expect(GardenTaskKind.EMBEDDING_BACKFILL).toBe("embedding_backfill");
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.LIBRARIAN].allowed_task_kinds
    ).toContain(GardenTaskKind.EMBEDDING_BACKFILL);
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.AUDITOR].allowed_task_kinds
    ).not.toContain(GardenTaskKind.EMBEDDING_BACKFILL);
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.JANITOR].allowed_task_kinds
    ).not.toContain(GardenTaskKind.EMBEDDING_BACKFILL);

    // Gate-5F 5F-D: path_plasticity_update belongs to the TIER_2 Librarian,
    // not the Auditor or Janitor.
    expect(GardenTaskKindSchema.parse("path_plasticity_update")).toBe("path_plasticity_update");
    expect(GardenTaskKind.PATH_PLASTICITY_UPDATE).toBe("path_plasticity_update");
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.AUDITOR].allowed_task_kinds
    ).not.toContain(GardenTaskKind.PATH_PLASTICITY_UPDATE);
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.LIBRARIAN].allowed_task_kinds
    ).toContain(GardenTaskKind.PATH_PLASTICITY_UPDATE);
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.JANITOR].allowed_task_kinds
    ).not.toContain(GardenTaskKind.PATH_PLASTICITY_UPDATE);

    expect(GardenTaskKindSchema.parse("post_turn_extract")).toBe("post_turn_extract");
    expect(GardenTaskKind.POST_TURN_EXTRACT).toBe("post_turn_extract");
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.AUDITOR].allowed_task_kinds
    ).not.toContain(GardenTaskKind.POST_TURN_EXTRACT);
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.LIBRARIAN].allowed_task_kinds
    ).not.toContain(GardenTaskKind.POST_TURN_EXTRACT);
    expect(
      GARDEN_ROLE_PERMISSIONS[GardenRole.JANITOR].allowed_task_kinds
    ).not.toContain(GardenTaskKind.POST_TURN_EXTRACT);

    expect(Object.values(HealthEventKind)).toEqual([
      "bankruptcy",
      "arbitration",
      "garden_backlog",
      "evidence_failure",
      "pointer_failure",
      "pointer_repair",
      "correction_chains",
      "green_piercing_distribution",
      "provider_call",
      "embedding_supplement",
      "recall_tuning"
    ]);
    expect(HealthEventKindSchema.parse("provider_call")).toBe("provider_call");
    expect(HealthEventKind.PROVIDER_CALL).toBe("provider_call");
    expect(HealthEventKindSchema.parse("embedding_supplement")).toBe("embedding_supplement");
    expect(HealthEventKind.EMBEDDING_SUPPLEMENT).toBe("embedding_supplement");
    expect(HealthEventKindSchema.parse("recall_tuning")).toBe("recall_tuning");
    expect(HealthEventKind.RECALL_TUNING).toBe("recall_tuning");
  });

  it("registers and parses all C-23 extension event payloads", () => {
    const expectedEventTypes = [
      "compute.provider.call_started",
      "compute.provider.call_completed",
      "compute.provider.call_failed",
      "recall.embedding.supplement_queried",
      "recall.embedding.supplement_merged",
      "recall.embedding.supplement_degraded",
      "garden.backlog.telemetry_snapshot",
      "garden.backlog.warning"
    ] as const;

    const callStartedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      provider_kind: "official_api",
      model_id: "gpt-4.1-mini",
      operation: "compile",
      call_id: "call-1",
      started_at: validTimestamp
    } as const;
    const callCompletedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      provider_kind: "official_api",
      model_id: "gpt-4.1-mini",
      operation: "compile",
      call_id: "call-1",
      latency_ms: 187,
      completed_at: validTimestamp
    } as const;
    const callFailedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      provider_kind: "official_api",
      model_id: "gpt-4.1-mini",
      operation: "compile",
      call_id: "call-1",
      latency_ms: 187,
      error_kind: "timeout",
      error_message: "request timed out",
      failed_at: validTimestamp
    } as const;
    const queriedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      query_id: "query-1",
      requested_limit: 8,
      returned_candidate_count: 3,
      latency_ms: 42,
      queried_at: validTimestamp
    } as const;
    const mergedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      query_id: "query-1",
      base_candidate_count: 5,
      supplement_candidate_count: 3,
      merged_candidate_count: 6,
      merged_at: validTimestamp
    } as const;
    const degradedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      query_id: "query-1",
      degradation_reason: "provider_unavailable",
      base_candidate_count: 5,
      fallback_candidate_count: 5,
      degraded_at: validTimestamp
    } as const;
    const telemetrySnapshotPayload = {
      workspace_id: "workspace-1",
      run_id: null,
      queue_depth_total: 12,
      queue_depth_by_tier: {
        tier_0: 3,
        tier_1: 4,
        tier_2: 5
      },
      in_flight_total: 0,
      warning_active: true,
      observed_at: validTimestamp
    } as const;
    const backlogWarningPayload = {
      workspace_id: "workspace-1",
      run_id: null,
      queue_depth_total: 12,
      queue_depth_by_tier: {
        tier_0: 3,
        tier_1: 4,
        tier_2: 5
      },
      in_flight_total: 0,
      warning_queue_depth: 10,
      warning_rearm_depth: 7,
      warning_active: true,
      transition: "arm",
      observed_at: validTimestamp
    } as const;

    expect(Object.values(ComputeRecallGardenEventType)).toEqual(expectedEventTypes);
    expect(ComputeRecallGardenEventTypeSchema.options).toEqual(expectedEventTypes);

    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_STARTED,
        callStartedPayload
      )
    ).toEqual(callStartedPayload);
    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_COMPLETED,
        callCompletedPayload
      )
    ).toEqual(callCompletedPayload);
    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_FAILED,
        callFailedPayload
      )
    ).toEqual(callFailedPayload);
    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        queriedPayload
      )
    ).toEqual(queriedPayload);
    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_MERGED,
        mergedPayload
      )
    ).toEqual(mergedPayload);
    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_DEGRADED,
        degradedPayload
      )
    ).toEqual(degradedPayload);
    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT,
        telemetrySnapshotPayload
      )
    ).toEqual(telemetrySnapshotPayload);
    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
        backlogWarningPayload
      )
    ).toEqual(backlogWarningPayload);

    expect(
      ComputeRecallGardenEventUnionSchema.parse({
        type: ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
        payload: backlogWarningPayload
      })
    ).toEqual({
      type: ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
      payload: backlogWarningPayload
    });

    for (const eventType of expectedEventTypes) {
      expect(EventTypeSchema.parse(eventType)).toBe(eventType);
    }

    expect(
      EventLogEntrySchema.parse({
        event_id: "event-1",
        event_type: ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_STARTED,
        entity_type: "compute_provider_call",
        entity_id: "call-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "system",
        revision: 0,
        payload_json: callStartedPayload,
        created_at: validTimestamp
      })
    ).toMatchObject({
      event_type: ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_STARTED,
      payload_json: callStartedPayload
    });

    expect(
      EventLogEntrySchema.parse({
        event_id: "event-2",
        event_type: ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
        entity_type: "garden_backlog",
        entity_id: "warning-1",
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "system",
        revision: 0,
        payload_json: backlogWarningPayload,
        created_at: validTimestamp
      })
    ).toMatchObject({
      event_type: ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
      payload_json: backlogWarningPayload
    });
  });

  it("rejects unknown extension names and malformed extension payloads", () => {
    expect(() => ComputeRecallGardenEventTypeSchema.parse("compute.provider.call_unknown")).toThrow();
    expect(() => EventTypeSchema.parse("garden.backlog.telemetry")).toThrow();

    expect(() =>
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_STARTED,
        {
          run_id: "run-1",
          provider_kind: "official_api",
          model_id: "gpt-4.1-mini",
          operation: "compile",
          call_id: "call-1",
          started_at: validTimestamp
        }
      )
    ).toThrow();

    expect(() =>
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.COMPUTE_PROVIDER_CALL_COMPLETED,
        {
          workspace_id: "workspace-1",
          run_id: "run-1",
          provider_kind: "official_api",
          model_id: "gpt-4.1-mini",
          operation: "compile",
          call_id: "call-1",
          latency_ms: -1,
          completed_at: validTimestamp
        }
      )
    ).toThrow();

    expect(() =>
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        {
          workspace_id: "workspace-1",
          query_id: "query-1",
          requested_limit: 8,
          returned_candidate_count: 3,
          latency_ms: 42,
          queried_at: validTimestamp
        }
      )
    ).toThrow();

    expect(
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        {
          workspace_id: "workspace-1",
          run_id: null,
          query_id: "query-1",
          requested_limit: 8,
          returned_candidate_count: 3,
          latency_ms: 42,
          queried_at: validTimestamp
        }
      )
    ).toEqual({
      workspace_id: "workspace-1",
      run_id: null,
      query_id: "query-1",
      requested_limit: 8,
      returned_candidate_count: 3,
      latency_ms: 42,
      queried_at: validTimestamp
    });

    expect(() =>
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT,
        {
          workspace_id: null,
          run_id: null,
          queue_depth_total: 12,
          queue_depth_by_tier: {
            tier_0: 3,
            tier_1: 4,
            tier_2: 5
          },
          in_flight_total: 0,
          warning_active: true,
          observed_at: validTimestamp
        }
      )
    ).toThrow();

    expect(() =>
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
        {
          workspace_id: null,
          run_id: null,
          queue_depth_total: 12,
          queue_depth_by_tier: {
            tier_0: 3,
            tier_1: 4,
            tier_2: 5
          },
          in_flight_total: 0,
          warning_queue_depth: 10,
          warning_rearm_depth: 7,
          warning_active: true,
          transition: "none",
          observed_at: validTimestamp
        }
      )
    ).toThrow();

    expect(() =>
      parseComputeRecallGardenEventPayload(
        ComputeRecallGardenEventType.GARDEN_BACKLOG_WARNING,
        {
          run_id: null,
          queue_depth_total: 12,
          queue_depth_by_tier: {
            tier_0: 3,
            tier_1: 4,
            tier_2: 5
          },
          in_flight_total: 0,
          warning_queue_depth: 10,
          warning_rearm_depth: 7,
          warning_active: true,
          transition: "arm",
          observed_at: validTimestamp
        }
      )
    ).toThrow();
  });
});
