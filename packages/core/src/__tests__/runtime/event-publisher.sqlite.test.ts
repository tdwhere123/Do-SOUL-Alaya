import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunCreatedPayloadSchema,
  RuntimeGovernanceEventType,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceRunEventType,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EventPublisher } from "../../runtime/event-publisher.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("EventPublisher + SqliteEventLogRepo", () => {
  it("returns the committed mutation and records notification failure without inviting a write retry", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const publisher = new EventPublisher({ eventLogRepo,
      runHotStateService: { apply: () => undefined },
      runtimeNotifier: { notify: () => undefined, notifyEntry: () => { throw new Error("listener offline"); } }
    });
    const committed = await publisher.appendManyWithMutation([{
      event_type: WorkspaceRunEventType.RUN_CREATED, entity_type: "run", entity_id: "run-notify-fail",
      workspace_id: "ws_publisher", run_id: "run-notify-fail", caused_by: "user_action",
      payload_json: RunCreatedPayloadSchema.parse({ run_id: "run-notify-fail", workspace_id: "ws_publisher",
        run_mode: RunMode.CHAT, title: "notify failure" })
    }], entries => entries[0]!);
    const rows = await eventLogRepo.queryByRun("run-notify-fail");
    expect(rows.filter(row => row.event_type === WorkspaceRunEventType.RUN_CREATED)).toEqual([committed]);
    expect(rows.some(row => row.event_type === RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED)).toBe(true);
  });
  it("persists a published Phase 0 event and applies run hot state", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);

    await workspaceRepo.create({
      workspace_id: "ws_publisher",
      name: "publisher",
      root_path: "/tmp/publisher",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runRepo.create({
      run_id: "run_publisher",
      workspace_id: "ws_publisher",
      title: "publisher run",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });

    const apply = vi.fn();
    const notifyEntry = vi.fn();
    const publisher = new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply },
      runtimeNotifier: { notify: vi.fn(), notifyEntry }
    });

    const published = await publisher.publish({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: "run_publisher",
      workspace_id: "ws_publisher",
      run_id: "run_publisher",
      caused_by: "user_action",
      payload_json: RunCreatedPayloadSchema.parse({
        run_id: "run_publisher",
        workspace_id: "ws_publisher",
        run_mode: RunMode.CHAT,
        title: "publisher run"
      })
    });

    const stored = await eventLogRepo.queryByRun("run_publisher");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event_id).toBe(published.event_id);
    expect(stored[0]?.event_type).toBe(WorkspaceRunEventType.RUN_CREATED);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: WorkspaceRunEventType.RUN_CREATED,
        run_id: "run_publisher",
        event_id: published.event_id
      })
    );
    expect(notifyEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: published.event_id })
    );

    database.close();
    databases.delete(database);
  });

  it("rolls back the EventLog row when apply throws", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const publisher = new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: () => undefined },
      runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
    });

    await expect(
      publisher.appendManyWithMutation(
        [
          {
            event_type: WorkspaceRunEventType.RUN_CREATED,
            entity_type: "run",
            entity_id: "run_apply_throw",
            workspace_id: "ws_publisher",
            run_id: "run_apply_throw",
            caused_by: "user_action",
            payload_json: RunCreatedPayloadSchema.parse({
              run_id: "run_apply_throw",
              workspace_id: "ws_publisher",
              run_mode: RunMode.CHAT,
              title: "apply throw"
            })
          }
        ],
        () => {
          throw new Error("apply failed");
        }
      )
    ).rejects.toThrow("apply failed");

    expect(await eventLogRepo.queryByEntity("run", "run_apply_throw")).toEqual([]);

    database.close();
    databases.delete(database);
  });
});
