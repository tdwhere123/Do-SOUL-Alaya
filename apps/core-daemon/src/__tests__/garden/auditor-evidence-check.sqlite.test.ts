import { afterEach, describe, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  GardenTaskKind, GardenTier, HealthEventKind,
  type EventLogEntry, type GardenTaskDescriptor, type HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import { Auditor, type AuditorDependencies } from "@do-soul/alaya-soul";
import {
  createGardenBackgroundDataPorts, SqliteEventLogRepo, SqliteGreenStatusRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createGardenRuntimeEventLogPort } from "../../garden/runtime/runtime-composition.js";
import { createRecallRealStorage } from "../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createGreenStatus, createMemoryEntry } from "../../../../../packages/storage/src/__tests__/repos/proposal/proposal-repo-fixture.js";

const databases = new Set<StorageDatabase>();
const NOW = "2026-11-16T00:00:00.000Z";
const FIRST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SECOND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function fixture() {
  const storage = await createRecallRealStorage(db => databases.add(db));
  const eventLogRepo = new SqliteEventLogRepo(storage.database);
  const ports = createGardenBackgroundDataPorts(storage.database, { now: () => NOW });
  const statusRepo = new SqliteGreenStatusRepo(storage.database);
  const scheduler = { reportCompletion: vi.fn(async () => undefined) };
  const healthJournal = { record: vi.fn<HealthJournalRecordPort["record"]>(async () => undefined) };
  const notificationCommitChecks: boolean[] = [];
  const notifyEntry = vi.fn((event: EventLogEntry) => {
    const stored = storage.database.connection.prepare("SELECT event_id FROM event_log WHERE event_id = ?").get(event.event_id);
    notificationCommitChecks.push(
      !storage.database.connection.inTransaction && stored !== undefined &&
      statusRepo.findByTargetObjectIdSync(event.entity_id)?.green_state === "revoked"
    );
  });
  const eventPublisher = new EventPublisher({
    eventLogRepo, runtimeNotifier: { notifyEntry, notify: () => undefined },
    runHotStateService: { apply: () => undefined }
  });
  const auditor = (overrides: Partial<AuditorDependencies> = {}) => new Auditor({
    evidenceCheckPort: ports.evidenceCheckPort, pointerHealthPort: ports.pointerHealthPort,
    greenMaintenancePort: ports.greenMaintenancePort, bootstrappingPort: ports.bootstrappingPort,
    eventLogRepo: createGardenRuntimeEventLogPort(eventPublisher), scheduler, healthJournal,
    now: () => NOW, ...overrides
  });
  return { ...storage, eventLogRepo, ports, statusRepo, scheduler, healthJournal, auditor, notifyEntry, notificationCommitChecks };
}

function task(): GardenTaskDescriptor {
  return {
    task_id: "task-evidence-check", task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
    required_tier: GardenTier.TIER_1, workspace_id: "workspace-1", run_id: "run-1",
    target_object_refs: [], priority: 10, created_at: NOW
  };
}

async function addGreenMemory(f: Awaited<ReturnType<typeof fixture>>, memoryId: string, statusId: string) {
  await f.memoryEntryRepo.create(createMemoryEntry({ object_id: memoryId, evidence_refs: ["missing-evidence"] }));
  f.statusRepo.upsert(createGreenStatus({ object_id: statusId, target_object_id: memoryId }));
}

describe("Auditor evidence-check SQLite effects and completion", () => {
  it("rolls back a stale snapshot's no-op audit and continues revocation before publishing batch health", async () => {
    const f = await fixture();
    await addGreenMemory(f, FIRST, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1");
    await addGreenMemory(f, SECOND, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2");
    const auditor = f.auditor({ evidenceCheckPort: {
      findMemoriesWithStaleEvidence: async workspaceId => {
        const snapshot = await f.ports.evidenceCheckPort.findMemoriesWithStaleEvidence(workspaceId);
        // Simulate another pass revoking the first target after selection.
        f.ports.greenMaintenancePort.revokeGreen(FIRST, "verification_fail", "other-task", workspaceId);
        return snapshot;
      }
    } });
    f.healthJournal.record.mockImplementation(async () => {
      expect((await f.eventLogRepo.queryByTypeAll("soul.green.revoked")).map(event => event.entity_id)).toEqual([SECOND]);
      expect(f.statusRepo.findByTargetObjectIdSync(SECOND)?.green_state).toBe("revoked");
      expect(f.scheduler.reportCompletion).not.toHaveBeenCalled();
    });

    const result = await auditor.run(task());

    expect(result).toMatchObject({ success: true, outcome: "completed", objects_affected: [SECOND],
      audit_entries: ["evidence_staleness_check: revoked green for 1 entries (noop: 1)"] });
    expect(f.healthJournal.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event_kind: HealthEventKind.EVIDENCE_FAILURE,
      detail_json: { affected_memory_ids: [SECOND], total_stale_refs: 2 }
    }));
    expect(f.healthJournal.record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event_kind: HealthEventKind.GREEN_REVOKE_NOOP,
      detail_json: { affected_memory_ids: [FIRST], task_id: result.task_id }
    }));
    expect(f.notifyEntry).toHaveBeenCalledTimes(1);
    expect(f.notificationCommitChecks).toEqual([true]);
    expect(f.scheduler.reportCompletion).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("retains an earlier revoke on a later SQLite fault and retries only the uncommitted target", async () => {
    const f = await fixture();
    await addGreenMemory(f, FIRST, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1");
    await addGreenMemory(f, SECOND, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2");
    f.database.connection.exec(`CREATE TRIGGER reject_green_update BEFORE UPDATE ON green_statuses
      WHEN OLD.target_object_id = '${SECOND}' BEGIN SELECT RAISE(ABORT, 'green write blocked'); END;`);
    const auditor = f.auditor();

    const failed = await auditor.run(task());

    expect(failed).toMatchObject({ success: false, outcome: "failed", objects_affected: [], audit_entries: [] });
    expect(failed.error_message).toContain("green write blocked");
    expect(f.statusRepo.findByTargetObjectIdSync(FIRST)?.green_state).toBe("revoked");
    expect(f.statusRepo.findByTargetObjectIdSync(SECOND)?.green_state).toBe("eligible");
    expect((await f.eventLogRepo.queryByTypeAll("soul.green.revoked")).map(event => event.entity_id)).toEqual([FIRST]);
    expect(f.healthJournal.record).not.toHaveBeenCalled();
    expect(f.notifyEntry).toHaveBeenCalledTimes(1);
    expect(f.scheduler.reportCompletion).toHaveBeenCalledExactlyOnceWith(failed);

    f.database.connection.exec("DROP TRIGGER reject_green_update");
    const retried = await auditor.run(task());
    expect(retried).toMatchObject({ success: true, objects_affected: [SECOND] });
    expect((await f.eventLogRepo.queryByTypeAll("soul.green.revoked")).map(event => event.entity_id)).toEqual([FIRST, SECOND]);
    expect(f.notifyEntry).toHaveBeenCalledTimes(2);
    expect(f.notificationCommitChecks).toEqual([true, true]);
  });
});
