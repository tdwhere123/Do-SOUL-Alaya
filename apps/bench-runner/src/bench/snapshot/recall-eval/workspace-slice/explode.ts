import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqliteCatalogReader } from "./catalog-reader.js";
import { classifyPackedTables } from "./classify-tables.js";
import {
  closeSliceDest,
  createSliceDest,
  finalizeSliceDest,
  type PreparedSliceDest
} from "./dest-schema.js";
import { WORKSPACE_SLICE_DB_FILENAME } from "./names.js";
import { replicateEmbeddingOverlayBind } from "./overlay-replicate.js";
import { rebuildWorkspaceFts } from "./rebuild-fts.js";
import { rebindTemporalProjectionIdentity } from "./rebind-temporal.js";
import {
  applyGlobalTablePolicies,
  copyWorkspaceTablesOnce,
  type CopyConnection
} from "./stream-copy.js";

export interface ExplodePackedWorkingCopyInput {
  readonly packedDbPath: string;
  readonly destDir: string;
  readonly workspaceIds?: readonly string[];
}

export interface ExplodedWorkspaceSlices {
  readonly packedDbPath: string;
  readonly destDir: string;
  readonly workspaceIds: readonly string[];
  readonly sliceDbPaths: Readonly<Record<string, string>>;
}

export function workspaceSliceDbPath(destDir: string, workspaceId: string): string {
  return join(destDir, encodeURIComponent(workspaceId), WORKSPACE_SLICE_DB_FILENAME);
}

export function explodePackedWorkingCopy(
  input: ExplodePackedWorkingCopyInput
): ExplodedWorkspaceSlices {
  const packed = new BetterSqlite3(input.packedDbPath, {
    readonly: true,
    fileMustExist: true
  });
  const dests: PreparedSliceDest[] = [];
  try {
    const workspaceIds = resolveWorkspaceIds(packed, input.workspaceIds);
    const catalog = classifyPackedTables(createSqliteCatalogReader(packed));
    for (const workspaceId of workspaceIds) {
      dests.push(createSliceDest(workspaceId, workspaceSliceDbPath(input.destDir, workspaceId)));
    }
    copyIntoDests(packed, dests, catalog);
    finalizeDests(dests, catalog.ftsVirtual);
  } catch (error) {
    for (const dest of dests) closeSliceDest(dest);
    throw error;
  } finally {
    packed.close();
  }
  const sliceDbPaths = Object.fromEntries(dests.map((dest) => [dest.workspaceId, dest.dbPath]));
  replicateEmbeddingOverlayBind({
    packedDbPath: input.packedDbPath,
    sliceDbPaths: dests.map((dest) => dest.dbPath)
  });
  return Object.freeze({
    packedDbPath: input.packedDbPath,
    destDir: input.destDir,
    workspaceIds: Object.freeze(dests.map((dest) => dest.workspaceId)),
    sliceDbPaths: Object.freeze(sliceDbPaths)
  });
}

function resolveWorkspaceIds(
  packed: { prepare(sql: string): { all(): unknown[] } },
  requested: readonly string[] | undefined
): readonly string[] {
  const present = packed.prepare(
    "SELECT workspace_id FROM workspaces ORDER BY workspace_id"
  ).all() as ReadonlyArray<{ readonly workspace_id: string }>;
  const ids = present.map((row) => row.workspace_id);
  if (requested === undefined) return ids;
  const missing = requested.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    throw new Error(`packed working copy is missing workspace ${missing[0]}`);
  }
  return requested;
}

function copyIntoDests(
  packed: CopyConnection,
  dests: readonly PreparedSliceDest[],
  catalog: ReturnType<typeof classifyPackedTables>
): void {
  const destByWorkspace = new Map(
    dests.map((dest) => [dest.workspaceId, dest.database.connection])
  );
  for (const dest of dests) dest.database.connection.exec("BEGIN");
  try {
    copyWorkspaceTablesOnce({ packed, destByWorkspace, catalog });
    applyGlobalTablePolicies({ packed, destByWorkspace, catalog });
    for (const dest of dests) rebindTemporalProjectionIdentity(dest.database.connection);
    for (const dest of dests) dest.database.connection.exec("COMMIT");
  } catch (error) {
    for (const dest of dests) {
      try {
        dest.database.connection.exec("ROLLBACK");
      } catch {
        // dest may already be rolled back
      }
    }
    throw error;
  }
}

function finalizeDests(
  dests: readonly PreparedSliceDest[],
  ftsVirtual: readonly string[]
): void {
  for (const dest of dests) {
    rebuildWorkspaceFts(dest.database.connection, ftsVirtual);
    finalizeSliceDest(dest);
    dest.database.close();
  }
}
