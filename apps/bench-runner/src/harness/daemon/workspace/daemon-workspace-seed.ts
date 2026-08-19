import { join } from "node:path";
import {
  RunMode,
  RunState
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteRunRepo } from "@do-soul/alaya-storage";

export interface BenchWorkspaceEnsurePort {
  ensureLocalWorkspace(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly rootPath: string;
    readonly repoPath?: string | null;
  }): Promise<unknown>;
}

export async function prepareBenchWorkspaceBinding(input: {
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly workspaceService: BenchWorkspaceEnsurePort;
}): Promise<void> {
  await input.workspaceService.ensureLocalWorkspace({
    workspaceId: input.workspaceId,
    name: input.workspaceId,
    rootPath: input.workspaceRoot
  });
  await seedBenchRunIfAbsent(input.dataDir, input.workspaceId, input.runId);
}

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
