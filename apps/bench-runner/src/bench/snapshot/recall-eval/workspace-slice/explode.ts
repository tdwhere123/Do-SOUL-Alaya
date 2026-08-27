import { join } from "node:path";
import {
  EventPublisher,
  RelationAssertionService
} from "@do-soul/alaya-core";
import {
  SqliteEventLogRepo,
  SqliteRelationAssertionRepo
} from "@do-soul/alaya-storage";
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
import { sealFinalizedWorkspaceSlice } from "./slice-snapshot.js";
import {
  applyGlobalTablePolicies,
  copyWorkspaceTablesOnce,
  type CopyConnection,
  type WorkspaceSliceProgress
} from "./stream-copy.js";

export interface ExplodePackedWorkingCopyInput {
  readonly packedDbPath: string;
  readonly destDir: string;
  readonly workspaceIds?: readonly string[];
  readonly onProgress?: (progress: WorkspaceSliceProgress) => void;
}

export interface ExplodedWorkspaceSlices {
  readonly packedDbPath: string;
  readonly destDir: string;
  readonly workspaceIds: readonly string[];
  readonly sliceDbPaths: Readonly<Record<string, string>>;
  readonly sliceSnapshotDigests: Readonly<Record<string, string>>;
}

export function workspaceSliceDbPath(destDir: string, workspaceId: string): string {
  return join(destDir, encodeURIComponent(workspaceId), WORKSPACE_SLICE_DB_FILENAME);
}

export async function explodePackedWorkingCopy(
  input: ExplodePackedWorkingCopyInput
): Promise<ExplodedWorkspaceSlices> {
  const packed = new BetterSqlite3(input.packedDbPath, {
    readonly: true,
    fileMustExist: true
  });
  const dests: PreparedSliceDest[] = [];
  let sliceSnapshotDigests: Readonly<Record<string, string>> = Object.freeze({});
  try {
    const workspaceIds = resolveWorkspaceIds(packed, input.workspaceIds);
    const catalog = classifyPackedTables(createSqliteCatalogReader(packed));
    for (const [index, workspaceId] of workspaceIds.entries()) {
      dests.push(createSliceDest(workspaceId, workspaceSliceDbPath(input.destDir, workspaceId)));
      reportProgress(input.onProgress, "prepare_slices", index, workspaceIds.length);
    }
    copyIntoDests(packed, dests, catalog, input.onProgress);
    await rebuildTemporalOperators(dests, input.onProgress);
    sliceSnapshotDigests = finalizeDests(dests, catalog.ftsVirtual, input.onProgress);
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
    sliceDbPaths: Object.freeze(sliceDbPaths),
    sliceSnapshotDigests
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
  catalog: ReturnType<typeof classifyPackedTables>,
  onProgress?: (progress: WorkspaceSliceProgress) => void
): void {
  const destByWorkspace = new Map(
    dests.map((dest) => [dest.workspaceId, dest.database.connection])
  );
  for (const dest of dests) dest.database.connection.exec("BEGIN");
  try {
    copyWorkspaceTablesOnce({ packed, destByWorkspace, catalog, onProgress });
    applyGlobalTablePolicies({ packed, destByWorkspace, catalog, onProgress });
    for (const [index, dest] of dests.entries()) {
      rebindTemporalProjectionIdentity(dest.database.connection);
      reportProgress(onProgress, "rebind_slices", index, dests.length);
    }
    for (const [index, dest] of dests.entries()) {
      dest.database.connection.exec("COMMIT");
      reportProgress(onProgress, "commit_slices", index, dests.length);
    }
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

async function rebuildTemporalOperators(
  dests: readonly PreparedSliceDest[],
  onProgress?: (progress: WorkspaceSliceProgress) => void
): Promise<void> {
  for (const [index, dest] of dests.entries()) {
    const eventLogRepo = new SqliteEventLogRepo(dest.database);
    const repo = new SqliteRelationAssertionRepo(dest.database);
    const service = new RelationAssertionService({
      repo,
      eventHistory: eventLogRepo,
      eventPublisher: new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: () => undefined },
        runtimeNotifier: {
          notify: () => undefined,
          notifyEntry: () => undefined
        }
      }),
      now: () => readActiveAsOf(dest)
    });
    await service.verifyAndRebuild();
    reportProgress(onProgress, "rebuild_temporal_slices", index, dests.length);
  }
}

function readActiveAsOf(dest: PreparedSliceDest): string {
  const row = dest.database.connection.prepare(`
    SELECT active_as_of
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get() as Readonly<{ active_as_of: string }> | undefined;
  if (row === undefined || row.active_as_of.length === 0) {
    throw new Error("workspace slice temporal operator is missing active_as_of");
  }
  return row.active_as_of;
}

function finalizeDests(
  dests: readonly PreparedSliceDest[],
  ftsVirtual: readonly string[],
  onProgress?: (progress: WorkspaceSliceProgress) => void
): Readonly<Record<string, string>> {
  const sliceSnapshotDigests: Record<string, string> = {};
  for (const [index, dest] of dests.entries()) {
    rebuildWorkspaceFts(dest.database.connection, ftsVirtual);
    finalizeSliceDest(dest);
    sliceSnapshotDigests[dest.workspaceId] = sealFinalizedWorkspaceSlice(dest);
    reportProgress(onProgress, "finalize_slices", index, dests.length);
  }
  return Object.freeze(sliceSnapshotDigests);
}

function reportProgress(
  onProgress: ((progress: WorkspaceSliceProgress) => void) | undefined,
  stage: WorkspaceSliceProgress["stage"],
  index: number,
  total: number
): void {
  if (total > 0) onProgress?.({ stage, completed: index + 1, total });
}
