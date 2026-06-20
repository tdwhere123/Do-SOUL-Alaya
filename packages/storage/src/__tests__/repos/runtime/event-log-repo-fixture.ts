import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

export const trackedDatabases = new Set<ReturnType<typeof initDatabase>>();

export async function createEventLogRepos(): Promise<{
  database: ReturnType<typeof initDatabase>;
  workspaceRepo: SqliteWorkspaceRepo;
  runRepo: SqliteRunRepo;
  eventLogRepo: SqliteEventLogRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  trackedDatabases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);

  await workspaceRepo.create({
    workspace_id: "ws_events",
    name: "events",
    root_path: "/tmp/events",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run_order",
    workspace_id: "ws_events",
    title: "ordered run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return { database, workspaceRepo, runRepo, eventLogRepo };
}
