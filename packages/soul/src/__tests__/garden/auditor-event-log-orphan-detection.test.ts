import { describe, expect, it, vi } from "vitest";
import {
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  GraphAuditorEventType,
  SoulGardenEventLogOrphanDetectedEventType,
  type EventLogEntry,
  type OrphanRadar,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { AUDITOR_CONSTANTS, Auditor, type AuditorDependencies } from "../../garden/auditor.js";

type AuditorEventLogPort = NonNullable<AuditorDependencies["eventLogRepo"]>;
type AuditorPointerHealPort = NonNullable<AuditorDependencies["pointerHealPort"]>;
type HealablePointerRecord = Awaited<
  ReturnType<AuditorPointerHealPort["findHealablePointers"]>
>[number];
type AuditorOrphanDetectionPort = NonNullable<AuditorDependencies["orphanDetectionPort"]>;
type EventLogOrphanRecord = Awaited<
  ReturnType<NonNullable<AuditorOrphanDetectionPort["findEventLogOrphans"]>>
>[number];

const randomUuidMock = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", () => ({
  randomUUID: randomUuidMock
}));

describe("Auditor 4B", () => {  it("persists orphan radar records through the configured port and emits the orphan reported event", async () => {
    randomUuidMock.mockReset();
    randomUuidMock.mockReturnValue("uuid-radar-real");
    const appendedEvents: unknown[] = [];
    const persistedRecords: Readonly<OrphanRadar>[] = [];

    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const eventLogRepo = createTransactionalEventLogRepo(appendedEvents);
    const orphanDetectionPort = {
      findOrphanedMemories: vi.fn(async () => [
        {
          memory_id: "memory-1",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface://gap"],
          orphan_confidence: 0.8
        }
      ]),
      createOrphanRadarRecord: async (record: Readonly<OrphanRadar>) => {
        persistedRecords.push(record);
      }
    };

    const auditor = new Auditor({
      evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      pointerHealPort: {
        findHealablePointers: vi.fn(async () => []),
        clearEvidenceRef: vi.fn(() => undefined),
        clearMemoryRef: vi.fn(() => undefined),
        clearSynthesisRef: vi.fn(() => undefined)
      },
      orphanDetectionPort,
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(async () => undefined),
        requestActiveVerification: vi.fn(async () => undefined),
        revokeGreen: vi.fn(() => ({ affected: 0 }))
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 10, claim_count: 10 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler,
      eventLogRepo,
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.ORPHAN_DETECTION }));

    expect(result.success).toBe(true);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
    expect(appendedEvents).toEqual([
      expect.objectContaining({
        event_type: GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED,
        entity_type: "orphan_radar",
        workspace_id: "workspace-1",
        payload_json: expect.objectContaining({
          target_memory_id: "memory-1",
          suggested_action: "re_anchor_candidate",
          confidence: 0.8
        })
      })
    ]);
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        radar_id: "uuid-radar-real",
        target_memory_id: "memory-1",
        workspace_id: "workspace-1",
        suspected_surface_gaps: ["surface://gap"],
        suggested_action: "re_anchor_candidate",
        confidence: 0.8,
        detected_at: "2026-03-28T10:00:00.000Z",
        expires_at: "2026-03-30T10:00:00.000Z",
        requires_review: true
      })
    ]);
  });


  it("detects EventLog orphans, writes orphan radar rows, and emits one event per orphan", async () => {
    randomUuidMock.mockReset();
    randomUuidMock.mockReturnValueOnce("uuid-event-radar-1").mockReturnValueOnce("uuid-event-radar-2");
    const appendedEvents: unknown[] = [];
    const persistedRecords: unknown[] = [];

    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const eventLogRepo = createTransactionalEventLogRepo(appendedEvents, "2026-05-01T10:00:00.000Z");
    const orphanDetectionPort = {
      findOrphanedMemories: vi.fn(async () => []),
      createOrphanRadarRecord: vi.fn(() => undefined),
      findEventLogOrphans: vi.fn(async (): Promise<readonly EventLogOrphanRecord[]> => [
        {
          audit_event_id: "audit-delivery-1",
          event_type: "memory.delivered",
          expected_table: "trust_context_delivery",
          detected_at: "2026-05-01T09:00:00.000Z"
        },
        {
          audit_event_id: "audit-usage-1",
          event_type: "memory.usage_reported",
          expected_table: "trust_usage_proof",
          detected_at: "2026-05-01T09:01:00.000Z"
        }
      ]),
      createEventLogOrphanRadarRecord: vi.fn(async (record) => {
        persistedRecords.push(record);
      })
    };
    const auditor = new Auditor({
      evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      pointerHealPort: {
        findHealablePointers: vi.fn(async () => []),
        clearEvidenceRef: vi.fn(() => undefined),
        clearMemoryRef: vi.fn(() => undefined),
        clearSynthesisRef: vi.fn(() => undefined)
      },
      orphanDetectionPort,
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(async () => undefined),
        requestActiveVerification: vi.fn(async () => undefined),
        revokeGreen: vi.fn(() => ({ affected: 0 }))
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 10, claim_count: 10 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler,
      eventLogRepo,
      now: () => "2026-05-01T10:00:00.000Z"
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION }));

    expect(result.success).toBe(true);
    expect(result.objects_affected).toEqual(["uuid-event-radar-1", "uuid-event-radar-2"]);
    expect(orphanDetectionPort.findEventLogOrphans).toHaveBeenCalledWith("workspace-1");
    expect(appendedEvents).toEqual([
      expect.objectContaining({
        event_type: SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED,
        entity_id: "uuid-event-radar-1",
        payload_json: expect.objectContaining({
          audit_event_id: "audit-delivery-1",
          expected_table: "trust_context_delivery",
          detected_at: "2026-05-01T10:00:00.000Z"
        })
      }),
      expect.objectContaining({
        event_type: SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED,
        entity_id: "uuid-event-radar-2",
        payload_json: expect.objectContaining({
          audit_event_id: "audit-usage-1",
          expected_table: "trust_usage_proof",
          detected_at: "2026-05-01T10:00:00.000Z"
        })
      })
    ]);
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        radar_id: "uuid-event-radar-1",
        audit_event_id: "audit-delivery-1",
        event_type: "memory.delivered",
        expected_table: "trust_context_delivery",
        workspace_id: "workspace-1",
        detected_at: "2026-05-01T10:00:00.000Z",
        expires_at: "2026-05-03T10:00:00.000Z",
        requires_review: true
      }),
      expect.objectContaining({
        radar_id: "uuid-event-radar-2",
        audit_event_id: "audit-usage-1",
        event_type: "memory.usage_reported",
        expected_table: "trust_usage_proof",
        workspace_id: "workspace-1",
        detected_at: "2026-05-01T10:00:00.000Z",
        expires_at: "2026-05-03T10:00:00.000Z",
        requires_review: true
      })
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("rolls back the EventLog orphan audit event when radar persistence fails", async () => {
    randomUuidMock.mockReset();
    randomUuidMock.mockReturnValueOnce("uuid-event-radar-rollback");
    const appendedEvents: unknown[] = [];
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const eventLogRepo = createTransactionalEventLogRepo(appendedEvents, "2026-05-01T10:00:00.000Z");
    const orphanDetectionPort = {
      findOrphanedMemories: vi.fn(async () => []),
      createOrphanRadarRecord: vi.fn(async () => undefined),
      findEventLogOrphans: vi.fn(async (): Promise<readonly EventLogOrphanRecord[]> => [
        {
          audit_event_id: "audit-delivery-rollback",
          event_type: "memory.delivered",
          expected_table: "trust_context_delivery",
          detected_at: "2026-05-01T09:00:00.000Z"
        }
      ]),
      createEventLogOrphanRadarRecord: vi.fn(() => {
        throw new Error("radar insert failed");
      })
    };
    const auditor = new Auditor({
      evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      pointerHealPort: {
        findHealablePointers: vi.fn(async () => []),
        clearEvidenceRef: vi.fn(() => undefined),
        clearMemoryRef: vi.fn(() => undefined),
        clearSynthesisRef: vi.fn(() => undefined)
      },
      orphanDetectionPort,
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(async () => undefined),
        requestActiveVerification: vi.fn(async () => undefined),
        revokeGreen: vi.fn(() => ({ affected: 0 }))
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 10, claim_count: 10 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler,
      eventLogRepo,
      now: () => "2026-05-01T10:00:00.000Z"
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION }));

    expect(result.success).toBe(false);
    expect(appendedEvents).toEqual([]);
    expect(eventLogRepo.appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(orphanDetectionPort.createEventLogOrphanRadarRecord).toHaveBeenCalledTimes(1);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });
});

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.POINTER_HEALING,
    required_tier: GardenTier.TIER_1,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-03-28T10:00:00.000Z",
    ...overrides
  };
}

function createTransactionalEventLogRepo(
  appendedEvents: unknown[] = [],
  createdAt = "2026-03-28T10:00:00.000Z"
): AuditorEventLogPort {
  const append = vi.fn((entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
    const persisted = {
      event_id: `event-${entry.entity_id}`,
      created_at: createdAt,
      revision: 0,
      ...entry
    } as EventLogEntry;
    appendedEvents.push(persisted);
    return persisted;
  });

  const appendManyWithMutation: AuditorEventLogPort["appendManyWithMutation"] = vi.fn(
    async <T>(
      entries: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T> => {
        const startLength = appendedEvents.length;
        const persisted = entries.map((entry) => append(entry));
        try {
          const result = mutate(persisted);
          if (result instanceof Promise || typeof (result as { readonly then?: unknown })?.then === "function") {
            throw new Error("test appendManyWithMutation mutate callback must be synchronous");
          }
          return result;
        } catch (error) {
          appendedEvents.splice(startLength);
          throw error;
        }
      }
    ) as AuditorEventLogPort["appendManyWithMutation"];

  return {
    append,
    appendManyWithMutation
  };
}
