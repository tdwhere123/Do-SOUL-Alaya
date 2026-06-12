import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRunEventType, RunMode, RunState, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteEventLogRepo } from "../../repos/event-log-repo.js";
import { SqliteRunRepo } from "../../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("storage integration flow", () => {
  it("creates a workspace, creates a run, appends an event, and queries it back", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);

    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);

    const workspace = await workspaceRepo.create({
      workspace_id: "ws_flow",
      name: "flow",
      root_path: "/tmp/flow",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    const run = await runRepo.create({
      run_id: "run_flow",
      workspace_id: workspace.workspace_id,
      title: "flow run",
      goal: "exercise storage",
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await eventLogRepo.append({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_type: "run",
      entity_id: run.run_id,
      workspace_id: workspace.workspace_id,
      run_id: run.run_id,
      caused_by: "user_action",
      payload_json: {
        run_id: run.run_id,
        workspace_id: workspace.workspace_id,
        run_mode: run.run_mode,
        title: run.title
      }
    });

    await expect(workspaceRepo.getById("ws_flow")).resolves.toMatchObject({
      workspace_id: "ws_flow"
    });
    await expect(runRepo.getById("run_flow")).resolves.toMatchObject({
      run_id: "run_flow",
      workspace_id: "ws_flow"
    });

    const events = await eventLogRepo.queryByRun("run_flow");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: WorkspaceRunEventType.RUN_CREATED,
      entity_id: "run_flow",
      workspace_id: "ws_flow"
    });
  });
});
