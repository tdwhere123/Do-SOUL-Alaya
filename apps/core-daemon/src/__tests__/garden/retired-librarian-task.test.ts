import { afterEach, describe, expect, it, vi } from "vitest";
import { createEdgeProposalMaintenance } from "../../garden/scheduler/scheduler-edge-proposals.js";
import type { CreateGardenSchedulerRuntimeSupportInput } from "../../garden/scheduler/scheduler-runtime-types.js";
import {
  createGardenEdgeProposalReconcileDeferralPort,
  deferGardenBootstrapPathReconciliation
} from "../../runtime/garden-wiring/garden-legacy-path-admission.js";
import { EventPublisher } from "@do-soul/alaya-core";
import { GardenEventType, GardenRole, GardenTaskKind, GardenTier, type EventType, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import { createGardenBackgroundDataPorts, initDatabase, SqliteEventLogRepo, SqliteGardenTaskRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { GardenScheduler, Librarian } from "@do-soul/alaya-soul";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

it.each([
  [GardenTaskKind.MERGE_PROPOSAL, "merge"],
  [GardenTaskKind.TEMPLATE_CANDIDATE, "template"],
  [GardenTaskKind.PATH_COMPRESSION, "compression"]
])("drains persisted historical %s as a terminal audited failure", async (taskKind, label) => {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo, runHotStateService: { apply: () => {} },
    runtimeNotifier: { notify: () => {}, notifyEntry: () => {} }
  });
  const taskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  const now = () => "2026-05-07T00:00:00.000Z";
  const scheduler = new GardenScheduler({ append: async entry => {
    await eventPublisher.publish({
      event_type: entry.event_type as EventType, entity_type: entry.entity_type,
      entity_id: entry.entity_id, workspace_id: entry.workspace_id, run_id: entry.run_id,
      caused_by: "garden-scheduler", payload_json: entry.payload
    });
  } }, { now }, null, taskRepo);
  const ports = createGardenBackgroundDataPorts(database);
  const librarian = new Librarian({
    neighborPort: ports.neighborPort, synthesisPort: ports.synthesisPort, scheduler, now
  });
  const task: GardenTaskDescriptor = {
    task_id: "historical-task", task_kind: taskKind,
    required_tier: GardenTier.TIER_2, workspace_id: "workspace-1", run_id: null,
    target_object_refs: [], priority: 10, created_at: now()
  };
  taskRepo.enqueue({ id: task.task_id, workspace_id: task.workspace_id, role: GardenRole.LIBRARIAN,
    kind: task.task_kind, payload: task, created_at: task.created_at });
  const dispatched = await scheduler.dispatchNext(GardenRole.LIBRARIAN);
  expect(dispatched).toEqual(task);
  expect(await librarian.run(dispatched!)).toMatchObject({
    success: false, objects_affected: [], error_message: expect.stringContaining(`${label} proposals are retired`)
  });
  expect(taskRepo.findById(task.task_id)).toMatchObject({
    status: "failed", last_error_text: expect.stringContaining(`${label} proposals are retired`)
  });
  expect(await scheduler.dispatchNext(GardenRole.LIBRARIAN)).toBeNull();
  expect(database.connection.prepare("SELECT count(*) AS count FROM proposals").get()).toEqual({ count: 0 });
  const completion = database.connection.prepare(
    "SELECT payload_json FROM event_log WHERE entity_id = ? AND event_type = ?"
  ).get(task.task_id, GardenEventType.SOUL_GARDEN_TASK_COMPLETED) as { payload_json: string } | undefined;
  expect(completion).toBeDefined();
  expect(JSON.parse(completion!.payload_json)).toMatchObject({ success: false });
});

describe("Garden legacy path admission fences", () => {
  it("runs the formal edge-proposal scheduler seam without invoking accepted-proposal legacy minting", async () => {
    const legacyReconcileStuckAccepts = vi.fn(async () => ({
      scanned: 1,
      reminted: 1,
      already_present: 0,
      rejected: 0,
      transient_failed: 0
    }));
    const sweepExpired = vi.fn(async () => ({ scanned: 0, expired: 0, skipped: 0 }));
    const warn = vi.fn();
    const legacyEdgeProposalService = {
      reconcileStuckAccepts: legacyReconcileStuckAccepts,
      sweepExpired
    };
    const edgeProposalReconcile = createGardenEdgeProposalReconcileDeferralPort(
      legacyEdgeProposalService,
      warn
    );
    const maintenance = createEdgeProposalMaintenance({
      edgeProposalReconcile,
      workspaceRepo: { list: vi.fn(async () => [{ workspace_id: "workspace-1" }]) },
      warn
    } as unknown as CreateGardenSchedulerRuntimeSupportInput);

    await maintenance.reconcileStuckEdgeProposalAccepts();

    expect(legacyReconcileStuckAccepts).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "garden edge proposal accept-to-mint reconciliation deferred without temporal assertion provenance",
      { workspace_id: "workspace-1", limit: 32 }
    );
  });

  it("keeps expiry sweeping available while accept-to-mint recovery stays deferred", async () => {
    const sweepExpired = vi.fn(async () => ({ scanned: 1, expired: 1, skipped: 0 }));
    const warn = vi.fn();
    const edgeProposalReconcile = createGardenEdgeProposalReconcileDeferralPort(
      { sweepExpired },
      warn
    );
    const maintenance = createEdgeProposalMaintenance({
      edgeProposalReconcile,
      workspaceRepo: { list: vi.fn(async () => [{ workspace_id: "workspace-1" }]) },
      warn
    } as unknown as CreateGardenSchedulerRuntimeSupportInput);

    await maintenance.sweepExpiredEdgeProposals();

    expect(sweepExpired).toHaveBeenCalledWith({ workspaceId: "workspace-1", limit: 64 });
    expect(warn).toHaveBeenCalledWith(
      "edge proposal TTL sweep expired past-TTL pending proposals",
      { workspace_id: "workspace-1", scanned: 1, expired: 1, skipped: 0 }
    );
  });

  it("defers startup bootstrap reconciliation only for active workspaces", async () => {
    const warn = vi.fn();

    await deferGardenBootstrapPathReconciliation(
      {
        list: vi.fn(async () => [
          { workspace_id: "workspace-active", workspace_state: "active" },
          { workspace_id: "workspace-archived", workspace_state: "archived" }
        ])
      },
      warn
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "garden bootstrap path reconciliation deferred without temporal assertion provenance",
      { workspace_id: "workspace-active" }
    );
  });
});
