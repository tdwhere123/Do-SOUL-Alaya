import { existsSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { workspaceSliceDbPath, type ExplodedWorkspaceSlices } from "./explode.js";
import { readValidWorkspaceSliceSnapshotDigest } from "./slice-snapshot.js";

export function listWorkspaceIds(dbPath: string): readonly string[] {
  const database = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare(
      "SELECT workspace_id FROM workspaces ORDER BY workspace_id"
    ).all() as ReadonlyArray<{ readonly workspace_id: string }>;
    return rows.map((row) => row.workspace_id);
  } finally {
    database.close();
  }
}

export function completeSlicesOrNull(
  packedDbPath: string,
  destDir: string,
  workspaceIds: readonly string[]
): ExplodedWorkspaceSlices | null {
  const sliceDbPaths: Record<string, string> = {};
  const sliceSnapshotDigests: Record<string, string> = {};
  for (const workspaceId of workspaceIds) {
    const sliceDbPath = workspaceSliceDbPath(destDir, workspaceId);
    if (!existsSync(sliceDbPath) || !sliceContainsOnlyWorkspace(sliceDbPath, workspaceId)) {
      return null;
    }
    const snapshotDigest = readValidWorkspaceSliceSnapshotDigest({
      workspaceId,
      dbPath: sliceDbPath
    });
    if (snapshotDigest === null) return null;
    sliceDbPaths[workspaceId] = sliceDbPath;
    sliceSnapshotDigests[workspaceId] = snapshotDigest;
  }
  return Object.freeze({
    packedDbPath,
    destDir,
    workspaceIds,
    sliceDbPaths: Object.freeze(sliceDbPaths),
    sliceSnapshotDigests: Object.freeze(sliceSnapshotDigests)
  });
}

function sliceContainsOnlyWorkspace(dbPath: string, workspaceId: string): boolean {
  const database = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    return !hasForeignWorkspaceRow(database, "relation_assertions", workspaceId) &&
      !hasForeignWorkspaceRow(database, "relation_path_projections", workspaceId);
  } catch {
    return false;
  } finally {
    database.close();
  }
}

function hasForeignWorkspaceRow(
  database: BetterSqlite3.Database,
  table: string,
  workspaceId: string
): boolean {
  return database.prepare(
    `SELECT 1 FROM "${table}" WHERE workspace_id <> ? LIMIT 1`
  ).get(workspaceId) !== undefined;
}
