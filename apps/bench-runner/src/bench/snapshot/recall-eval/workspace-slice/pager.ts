import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  explodePackedWorkingCopy,
  workspaceSliceDbPath,
  type ExplodedWorkspaceSlices
} from "./explode.js";
import {
  installWorkspaceSlice,
  packedWorkingDbPath,
  preservePackedWorkingCopy,
  workingAlayaDbPath
} from "./install.js";
import { isWorkspaceSliceSkipped, WORKSPACE_SLICE_DIRNAME } from "./names.js";

export function explodeRecallEvalWorkingCopyIfNeeded(input: {
  readonly dataDirRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ExplodedWorkspaceSlices | null {
  if (isWorkspaceSliceSkipped(input.env ?? process.env)) return null;
  const packed = packedWorkingDbPath(input.dataDirRoot);
  const working = workingAlayaDbPath(input.dataDirRoot);
  // After Q1, alaya.db is a one-workspace slice; the corpus stays in packed.alaya.db.
  const source = existsSync(packed) ? packed : working;
  if (!existsSync(source)) return null;
  const workspaceIds = listWorkspaceIds(source);
  if (workspaceIds.length < 2) return null;
  const destDir = join(input.dataDirRoot, WORKSPACE_SLICE_DIRNAME);
  const reused = completeSlicesOrNull(source, destDir, workspaceIds);
  if (reused !== null) return reused;
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  const packedDbPath = existsSync(packed) ? packed : preservePackedWorkingCopy(input.dataDirRoot);
  return explodePackedWorkingCopy({
    packedDbPath,
    destDir,
    workspaceIds
  });
}

export function installRecallEvalWorkspaceSlice(input: {
  readonly dataDirRoot: string;
  readonly workspaceId: string;
  readonly slices: ExplodedWorkspaceSlices;
}): void {
  const sliceDbPath = input.slices.sliceDbPaths[input.workspaceId]
    ?? workspaceSliceDbPath(input.slices.destDir, input.workspaceId);
  if (!existsSync(sliceDbPath)) {
    throw new Error(`workspace slice is missing for ${input.workspaceId}`);
  }
  installWorkspaceSlice({
    dataDir: input.dataDirRoot,
    sliceDbPath
  });
}

function completeSlicesOrNull(
  packedDbPath: string,
  destDir: string,
  workspaceIds: readonly string[]
): ExplodedWorkspaceSlices | null {
  const sliceDbPaths: Record<string, string> = {};
  for (const workspaceId of workspaceIds) {
    const sliceDbPath = workspaceSliceDbPath(destDir, workspaceId);
    if (!existsSync(sliceDbPath)) return null;
    sliceDbPaths[workspaceId] = sliceDbPath;
  }
  return Object.freeze({
    packedDbPath,
    destDir,
    workspaceIds,
    sliceDbPaths: Object.freeze(sliceDbPaths)
  });
}

function listWorkspaceIds(dbPath: string): readonly string[] {
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
