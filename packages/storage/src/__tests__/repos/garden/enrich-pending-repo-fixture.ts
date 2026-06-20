import { DYNAMICS_CONSTANTS, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";
import { SqliteEnrichPendingRepo } from "../../../repos/garden/enrich-pending-repo.js";

export const MAX_ATTEMPTS = DYNAMICS_CONSTANTS.enrich.max_attempts;

// Claim against the production attempt cap unless a test pins a smaller cap to
// drive the dead-letter boundary.
export function claim(
  repo: SqliteEnrichPendingRepo,
  workspaceId: string,
  limit: number,
  claimedAt: string,
  maxAttempts: number = MAX_ATTEMPTS
): readonly { readonly memoryId: string }[] {
  return repo.claimBatch(workspaceId, limit, claimedAt, maxAttempts);
}

export const trackedDatabases = new Set<StorageDatabase>();
export const tempDirs = new Set<string>();

export function openMemoryDb(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  trackedDatabases.add(database);
  seedWorkspaces(database);
  return database;
}

export function openFileDb(filename: string): StorageDatabase {
  const database = initDatabase({ filename });
  trackedDatabases.add(database);
  return database;
}

export function seedWorkspaces(database: StorageDatabase): void {
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  for (const workspaceId of ["workspace-1", "workspace-2"]) {
    workspaceRepo.create({
      workspace_id: workspaceId,
      name: workspaceId,
      root_path: `/tmp/${workspaceId}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
  }
}
