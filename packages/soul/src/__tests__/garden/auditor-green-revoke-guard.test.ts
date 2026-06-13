import { describe, expect, it, vi } from "vitest";
import {
  GardenTaskKind,
  HealthEventKind,
  type EventLogEntry,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { Auditor, GreenRevokeNoopError, type AuditorDependencies } from "../../garden/auditor.js";

type AuditorEventLogPort = NonNullable<AuditorDependencies["eventLogRepo"]>;
type AuditorHealthJournalPort = NonNullable<AuditorDependencies["healthJournal"]>;

// invariant: when revokeGreen affects zero rows the SOUL_GREEN_REVOKED
// EventLog row MUST roll back inside the same SQLite transaction so audit
// count tracks real revokes, not silent no-ops. The catching path records
// a green_revoke_noop health-journal entry instead.

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-revoke-guard",
    workspace_id: "workspace-1",
    run_id: "run-1",
    task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
    task_state: "ready",
    enqueued_at: "2026-05-16T00:00:00.000Z",
    not_before_at: "2026-05-16T00:00:00.000Z",
    payload_json: {},
    ...overrides
  } as GardenTaskDescriptor;
}

interface TransactionalEventLogRepoHarness {
  readonly repo: AuditorEventLogPort;
  readonly persistedEvents: EventLogEntry[];
}

function createTransactionalEventLogRepo(): TransactionalEventLogRepoHarness {
  const persistedEvents: EventLogEntry[] = [];
  let nextId = 1;
  const repo = {
    append: (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
      const built: EventLogEntry = {
        event_id: `evt_${nextId++}`,
        created_at: "2026-05-16T00:00:00.000Z",
        revision: 0,
        ...entry
      } as EventLogEntry;
      persistedEvents.push(built);
      return built;
    },
    appendManyWithMutation: vi.fn(
      async <T,>(
        eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
        mutate: (entries: readonly EventLogEntry[]) => T
      ): Promise<T> => {
        const stagedEvents: EventLogEntry[] = eventInputs.map((entry) => ({
          event_id: `evt_${nextId++}`,
          created_at: "2026-05-16T00:00:00.000Z",
          revision: 0,
          ...entry
        })) as EventLogEntry[];
        // mirrors better-sqlite3 transactional: on throw discard staged
        // event rows; on success commit them.
        const result = mutate(stagedEvents);
        for (const event of stagedEvents) {
          persistedEvents.push(event);
        }
        return result;
      }
    ) as AuditorEventLogPort["appendManyWithMutation"]
  };
  return { repo, persistedEvents };
}

describe("Auditor evidence check — GreenStatus revoke guard", () => {
  it("commits SOUL_GREEN_REVOKED EventLog AND records evidence_failure when revokeGreen affects rows", async () => {
    const { repo: eventLogRepo, persistedEvents } = createTransactionalEventLogRepo();
    const healthJournal = { record: vi.fn<AuditorHealthJournalPort["record"]>(async () => undefined) };
    const scheduler = { reportCompletion: vi.fn(async () => undefined) };
    const revokeGreen = vi.fn((_id, _reason, _taskId, _workspaceId) => ({ affected: 1 }));
    const auditor = new Auditor({
      evidenceCheckPort: {
        findMemoriesWithStaleEvidence: vi.fn(async () => [
          { memory_entry_id: "memory-real", stale_evidence_refs: ["evidence-1"] }
        ])
      },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      orphanDetectionPort: {
        findOrphanedMemories: vi.fn(async () => []),
        createOrphanRadarRecord: vi.fn(() => undefined)
      },
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(() => undefined),
        requestActiveVerification: vi.fn(() => undefined),
        revokeGreen
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 10, claim_count: 10 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "c1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler,
      eventLogRepo,
      healthJournal
    });

    await auditor.run(createTask());

    expect(revokeGreen).toHaveBeenCalledWith("memory-real", "verification_fail", "task-revoke-guard", "workspace-1");
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]?.event_type).toBe("soul.green.revoked");
    const recordCalls = healthJournal.record.mock.calls.map((call) => call[0]!.event_kind);
    expect(recordCalls).toContain(HealthEventKind.EVIDENCE_FAILURE);
    expect(recordCalls).not.toContain(HealthEventKind.GREEN_REVOKE_NOOP);
  });

  it("rolls back SOUL_GREEN_REVOKED AND records green_revoke_noop when revokeGreen affects zero rows", async () => {
    const { repo: eventLogRepo, persistedEvents } = createTransactionalEventLogRepo();
    const healthJournal = { record: vi.fn<AuditorHealthJournalPort["record"]>(async () => undefined) };
    const scheduler = { reportCompletion: vi.fn(async () => undefined) };
    const revokeGreen = vi.fn((_id, _reason, _taskId, _workspaceId) => ({ affected: 0 }));
    const auditor = new Auditor({
      evidenceCheckPort: {
        findMemoriesWithStaleEvidence: vi.fn(async () => [
          { memory_entry_id: "memory-stale", stale_evidence_refs: ["evidence-1"] },
          { memory_entry_id: "memory-stale-2", stale_evidence_refs: ["evidence-2"] }
        ])
      },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      orphanDetectionPort: {
        findOrphanedMemories: vi.fn(async () => []),
        createOrphanRadarRecord: vi.fn(() => undefined)
      },
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(() => undefined),
        requestActiveVerification: vi.fn(() => undefined),
        revokeGreen
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 10, claim_count: 10 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "c1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler,
      eventLogRepo,
      healthJournal
    });

    await auditor.run(createTask());

    expect(revokeGreen).toHaveBeenCalledTimes(2);
    // No SOUL_GREEN_REVOKED row persisted because both revokes were noops
    // (mutate threw GreenRevokeNoopError → tx rolled back).
    expect(persistedEvents.filter((event) => event.event_type === "soul.green.revoked")).toHaveLength(0);
    const recordedKinds = healthJournal.record.mock.calls.map((call) => call[0]!.event_kind);
    expect(recordedKinds).not.toContain(HealthEventKind.EVIDENCE_FAILURE);
    expect(recordedKinds).toContain(HealthEventKind.GREEN_REVOKE_NOOP);
    const noopEntry = healthJournal.record.mock.calls.find(
      (call) => call[0]!.event_kind === HealthEventKind.GREEN_REVOKE_NOOP
    );
    expect(noopEntry?.[0]!.detail_json).toMatchObject({
      affected_memory_ids: ["memory-stale", "memory-stale-2"]
    });
  });

  it("exports GreenRevokeNoopError so consumers can match by class", () => {
    const err = new GreenRevokeNoopError("memory-x", "workspace-y");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GreenRevokeNoopError");
    expect(err.memoryEntryId).toBe("memory-x");
    expect(err.workspaceId).toBe("workspace-y");
  });
});
