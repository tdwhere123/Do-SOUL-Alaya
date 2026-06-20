import { describe, expect, it, vi } from "vitest";
import {
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  GraphAuditorEventType,
  type EventLogEntry,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { AUDITOR_CONSTANTS, Auditor, type AuditorDependencies } from "../../garden/auditor.js";

type AuditorEventLogPort = NonNullable<AuditorDependencies["eventLogRepo"]>;
type AuditorPointerHealPort = NonNullable<AuditorDependencies["pointerHealPort"]>;
type HealablePointerRecord = Awaited<
  ReturnType<AuditorPointerHealPort["findHealablePointers"]>
>[number];

const randomUuidMock = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", () => ({
  randomUUID: randomUuidMock
}));

describe("Auditor 4B", () => {  it("dispatches pointer_healing and clears each supported ref kind", async () => {
    const pointerHealPort = {
      findHealablePointers: vi.fn(
        async (): Promise<readonly HealablePointerRecord[]> => [
          {
            source_object_id: "memory-1",
            source_object_kind: "memory_entry",
            broken_ref: "evidence-missing",
            ref_kind: "evidence_ref"
          },
          {
            source_object_id: "synthesis-1",
            source_object_kind: "synthesis_capsule",
            broken_ref: "memory-missing",
            ref_kind: "memory_ref"
          },
          {
            source_object_id: "claim-1",
            source_object_kind: "claim_form",
            broken_ref: "synthesis-missing",
            ref_kind: "synthesis_ref"
          }
        ]
      ),
      clearEvidenceRef: vi.fn(() => undefined),
      clearMemoryRef: vi.fn(() => undefined),
      clearSynthesisRef: vi.fn(() => undefined)
    };
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const healthJournal = {
      record: vi.fn(async () => undefined)
    };
    const eventLogRepo = createTransactionalEventLogRepo();
    const auditor = new Auditor({
      evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      pointerHealPort,
      orphanDetectionPort: {
        findOrphanedMemories: vi.fn(async () => []),
        createOrphanRadarRecord: vi.fn(async () => undefined)
      },
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
      healthJournal,
      eventLogRepo,
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.POINTER_HEALING }));

    expect(pointerHealPort.clearEvidenceRef).toHaveBeenCalledWith("memory-1", "evidence-missing", "task-1");
    expect(pointerHealPort.clearMemoryRef).toHaveBeenCalledWith("synthesis-1", "memory-missing", "task-1");
    expect(pointerHealPort.clearSynthesisRef).toHaveBeenCalledWith("claim-1", "synthesis-missing", "task-1");
    expect(eventLogRepo.appendManyWithMutation).toHaveBeenCalledTimes(3);
    expect(eventLogRepo.append).toHaveBeenCalledTimes(3);
    expect(eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED,
        payload_json: expect.objectContaining({
          source_object_id: "memory-1",
          source_object_kind: "memory_entry",
          ref_kind: "evidence_ref",
          cleared_ref: "evidence-missing",
          task_id: "task-1"
        })
      })
    );
    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.POINTER_REPAIR
      })
    );
    expect(result.success).toBe(true);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("creates orphan radar records with unique ids, a 48 hour TTL, and confidence-thresholded actions", async () => {
    randomUuidMock.mockReset();
    randomUuidMock
      .mockReturnValueOnce("uuid-radar-1")
      .mockReturnValueOnce("uuid-radar-2")
      .mockReturnValueOnce("uuid-radar-3");
    const orphanDetectionPort = {
      findOrphanedMemories: vi.fn(async () => [
        {
          memory_id: "memory-1",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface://gap"],
          orphan_confidence: 0.8
        },
        {
          memory_id: "memory-2",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface://gap-2"],
          orphan_confidence: 0.2
        },
        {
          memory_id: "memory-3",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface://gap-3"],
          orphan_confidence: 0.5
        }
      ]),
      createOrphanRadarRecord: vi.fn(async () => undefined)
    };
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
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
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.ORPHAN_DETECTION }));

    expect(orphanDetectionPort.createOrphanRadarRecord).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        radar_id: "uuid-radar-1",
        target_memory_id: "memory-1",
        suggested_action: "re_anchor_candidate",
        requires_review: true,
        detected_at: "2026-03-28T10:00:00.000Z",
        expires_at: "2026-03-30T10:00:00.000Z"
      })
    );
    expect(orphanDetectionPort.createOrphanRadarRecord).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        radar_id: "uuid-radar-2",
        target_memory_id: "memory-2",
        suggested_action: "no_action",
        requires_review: true,
        detected_at: "2026-03-28T10:00:00.000Z",
        expires_at: "2026-03-30T10:00:00.000Z"
      })
    );
    expect(orphanDetectionPort.createOrphanRadarRecord).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        radar_id: "uuid-radar-3",
        target_memory_id: "memory-3",
        suggested_action: "archive_candidate",
        requires_review: true,
        detected_at: "2026-03-28T10:00:00.000Z",
        expires_at: "2026-03-30T10:00:00.000Z"
      })
    );
    expect(result.success).toBe(true);
  });


  it("soft-skips orphan detection when the optional orphan port is not configured", async () => {
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const eventLogRepo = createTransactionalEventLogRepo();
    const auditor = new Auditor({
      evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      pointerHealPort: {
        findHealablePointers: vi.fn(async () => []),
        clearEvidenceRef: vi.fn(() => undefined),
        clearMemoryRef: vi.fn(() => undefined),
        clearSynthesisRef: vi.fn(() => undefined)
      },
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
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries).toEqual(["orphan_detection: skipped because orphan detection port is not configured"]);
    expect(eventLogRepo.append).not.toHaveBeenCalled();
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("processes only BATCH_SIZE orphan candidates per pass", async () => {
    randomUuidMock.mockReset();
    randomUuidMock.mockImplementation(() => `uuid-radar-${randomUuidMock.mock.calls.length}`);
    const orphanDetectionPort = {
      findOrphanedMemories: vi.fn(async () =>
        Array.from({ length: AUDITOR_CONSTANTS.BATCH_SIZE + 1 }, (_, index) => ({
          memory_id: `memory-${index + 1}`,
          workspace_id: "workspace-1",
          suspected_surface_gaps: [`surface://gap-${index + 1}`],
          orphan_confidence: 0.8
        }))
      ),
      createOrphanRadarRecord: vi.fn(async () => undefined)
    };
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const eventLogRepo = createTransactionalEventLogRepo();
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
    expect(orphanDetectionPort.createOrphanRadarRecord).toHaveBeenCalledTimes(AUDITOR_CONSTANTS.BATCH_SIZE);
    expect(eventLogRepo.append).toHaveBeenCalledTimes(AUDITOR_CONSTANTS.BATCH_SIZE);
    expect(result.objects_affected).toHaveLength(AUDITOR_CONSTANTS.BATCH_SIZE);
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
