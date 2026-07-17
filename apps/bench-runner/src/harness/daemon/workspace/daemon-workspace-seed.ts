import { join } from "node:path";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteRunRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";

export async function seedBenchWorkspaceAndRun(
  dataDir: string,
  workspaceId: string,
  runId: string,
  workspaceRoot: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const workspaceRepo = new SqliteWorkspaceRepo(db);
  const runRepo = new SqliteRunRepo(db);
  workspaceRepo.create({
    workspace_id: workspaceId,
    name: workspaceId,
    root_path: workspaceRoot,
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title: `bench run ${runId}`,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

// @anchor seedBenchWorkspaceIfAbsent — first-attach seed that tolerates a
// workspace row already present in a restored recall-eval snapshot DB. Probes
// the workspace by id: absent -> create workspace + run (normal first attach);
// present -> seed only the run, idempotently, since the snapshot already holds
// the materialized workspace. see also: seedBenchWorkspaceAndRun, seedBenchRunOnly
export async function seedBenchWorkspaceIfAbsent(
  dataDir: string,
  workspaceId: string,
  runId: string,
  workspaceRoot: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const workspaceRepo = new SqliteWorkspaceRepo(db);
  const existing = await workspaceRepo.getById(workspaceId);
  if (existing === null) {
    await seedBenchWorkspaceAndRun(dataDir, workspaceId, runId, workspaceRoot);
    return;
  }
  await seedBenchRunIfAbsent(dataDir, workspaceId, runId);
}

// @anchor seedBenchRunOnly — extend an already-created workspace with a
// fresh run row; bench attachWorkspace path when the workspaceId is reused
// across rebinds. see also: seedBenchWorkspaceAndRun
export async function seedBenchRunOnly(
  dataDir: string,
  workspaceId: string,
  runId: string
): Promise<void> {
  await seedBenchRunIfAbsent(dataDir, workspaceId, runId);
}

// Idempotent run seed: a restored snapshot already carries the run row keyed by
// the same runId the sidecar persisted, so a duplicate create would violate the
// runs.run_id constraint. Skip when the run already exists.
async function seedBenchRunIfAbsent(
  dataDir: string,
  workspaceId: string,
  runId: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const runRepo = new SqliteRunRepo(db);
  const existing = await runRepo.getById(runId);
  if (existing !== null) {
    return;
  }
  runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title: `bench run ${runId}`,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

