import { afterEach, describe, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  FileApprovalEventType,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { createSoulApprovalService } from "../../services/soul/soul-approval-service.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createSqliteApprovalFixture() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const notifyEntry = vi.fn();
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => undefined },
    runtimeNotifier: { notify: () => undefined, notifyEntry }
  });

  for (const workspaceId of ["ws-a", "ws-b"]) {
    workspaceRepo.create({
      workspace_id: workspaceId,
      name: workspaceId,
      root_path: `/tmp/${workspaceId}`,
      workspace_kind: WorkspaceKind.DOCS_ONLY,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
  }

  for (const [runId, workspaceId] of [
    ["run-a1", "ws-a"],
    ["run-a2", "ws-a"],
    ["run-b1", "ws-b"]
  ] as const) {
    runRepo.create({
      run_id: runId,
      workspace_id: workspaceId,
      title: runId,
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.ACTIVE,
      current_surface_id: null
    });
  }

  const service = createSoulApprovalService({
    eventLogRepo,
    eventPublisher,
    runLookup: async (runId) => {
      const run = await runRepo.getById(runId);
      if (run === null) {
        throw new Error(`Unexpected missing run ${runId}`);
      }
      return run;
    },
    now: () => "2026-04-01T00:00:00.000Z"
  });

  return { eventLogRepo, notifyEntry, service };
}

function seedApprovalRequest(
  eventLogRepo: SqliteEventLogRepo,
  input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly approvalId: string;
    readonly description?: string;
  }
) {
  return eventLogRepo.append({
    event_type: FileApprovalEventType.SOUL_APPROVAL_REQUESTED,
    entity_type: "approval",
    entity_id: input.approvalId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    caused_by: "system",
    payload_json: {
      message_id: `msg-${input.workspaceId}-${input.runId}-${input.approvalId}`,
      approval_id: input.approvalId,
      description: input.description ?? "Approval requested",
      run_id: input.runId
    }
  });
}

describe("SoulApprovalService atomic SQLite binding", () => {
  it("rejects same-workspace wrong-run and cross-workspace attempts without locking out the real target", async () => {
    const { eventLogRepo, notifyEntry, service } = createSqliteApprovalFixture();
    seedApprovalRequest(eventLogRepo, {
      workspaceId: "ws-a",
      runId: "run-a1",
      approvalId: "approval-1",
      description: "Legitimate approval"
    });

    await expect(
      service.approve({
        approvalId: "approval-1",
        runId: "run-a2",
        workspaceId: "ws-a",
        causedBy: "user_action"
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Pending approval not found for run"
    });

    await expect(
      service.approve({
        approvalId: "approval-1",
        runId: "run-b1",
        workspaceId: "ws-b",
        causedBy: "user_action"
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Pending approval not found for run"
    });

    await expect(
      service.approve({
        approvalId: "approval-1",
        runId: "run-a1",
        workspaceId: "ws-a",
        causedBy: "user_action"
      })
    ).resolves.toEqual({
      approval_id: "approval-1",
      result: "approved",
      resolved_at: "2026-04-01T00:00:00.000Z"
    });

    expect(notifyEntry).toHaveBeenCalledTimes(1);
    const events = await eventLogRepo.queryByEntityAll("approval", "approval-1");
    expect(events.filter((e) => e.event_type === FileApprovalEventType.SOUL_APPROVAL_RESOLVED)).toHaveLength(1);
  });

  it("isolates identical approval_id across workspaces without false CONFLICT lockouts", async () => {
    const { eventLogRepo, service } = createSqliteApprovalFixture();
    seedApprovalRequest(eventLogRepo, {
      workspaceId: "ws-a",
      runId: "run-a1",
      approvalId: "shared-approval",
      description: "Workspace A approval"
    });
    seedApprovalRequest(eventLogRepo, {
      workspaceId: "ws-b",
      runId: "run-b1",
      approvalId: "shared-approval",
      description: "Workspace B approval"
    });

    await expect(
      service.approve({
        approvalId: "shared-approval",
        runId: "run-a1",
        workspaceId: "ws-a",
        causedBy: "user_action"
      })
    ).resolves.toMatchObject({ approval_id: "shared-approval", result: "approved" });

    await expect(
      service.reject({
        approvalId: "shared-approval",
        runId: "run-b1",
        workspaceId: "ws-b",
        causedBy: "user_action"
      })
    ).resolves.toMatchObject({ approval_id: "shared-approval", result: "rejected" });
  });

  it("guards concurrent/duplicate resolution so only one resolution commits", async () => {
    const { eventLogRepo, notifyEntry, service } = createSqliteApprovalFixture();
    seedApprovalRequest(eventLogRepo, {
      workspaceId: "ws-a",
      runId: "run-a1",
      approvalId: "approval-race"
    });

    const results = await Promise.allSettled([
      service.approve({
        approvalId: "approval-race",
        runId: "run-a1",
        workspaceId: "ws-a",
        causedBy: "user_action"
      }),
      service.reject({
        approvalId: "approval-race",
        runId: "run-a1",
        workspaceId: "ws-a",
        causedBy: "user_action"
      })
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      message: "Approval has already been resolved"
    });
    expect(notifyEntry).toHaveBeenCalledTimes(1);
    const events = await eventLogRepo.queryByEntityAll("approval", "approval-race");
    expect(events.filter((e) => e.event_type === FileApprovalEventType.SOUL_APPROVAL_RESOLVED)).toHaveLength(1);
  });
});
