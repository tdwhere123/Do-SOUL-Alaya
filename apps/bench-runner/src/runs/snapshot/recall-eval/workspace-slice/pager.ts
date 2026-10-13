import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  workspaceSliceDbPath,
  type ExplodedWorkspaceSlices
} from "./explode.js";
import type { WorkspaceSliceProgress } from "./stream-copy.js";
import {
  installWorkspaceSlice,
  packedWorkingDbPath,
  workingAlayaDbPath
} from "./install.js";
import {
  isSealedSliceRestore,
  isSliceReuseRequired,
  isWorkspaceSliceSkipped,
  WORKSPACE_SLICE_DIRNAME
} from "./names.js";
import { listWorkspaceIds } from "./complete-slices.js";
import {
  resolvePackedWorkingCopy,
  reuseOrExplodeSealedSlices,
  reuseSealedSlicesWithoutPackedCopy
} from "./sealed-cache.js";
import { readValidWorkspaceSliceSnapshotReceipt } from "./slice-snapshot.js";

export async function explodeRecallEvalWorkingCopyIfNeeded(input: {
  readonly dataDirRoot: string;
  readonly snapshotDbPath?: string;
  readonly requireReuse?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (progress: WorkspaceSliceProgress) => void;
}): Promise<ExplodedWorkspaceSlices | null> {
  const env = input.env ?? process.env;
  if (isWorkspaceSliceSkipped(env)) return null;
  if (isSealedSliceRestore(env)) {
    return restoreSealedSlicesForWorker(input);
  }
  const source = existsSync(packedWorkingDbPath(input.dataDirRoot))
    ? packedWorkingDbPath(input.dataDirRoot)
    : workingAlayaDbPath(input.dataDirRoot);
  if (!existsSync(source)) return null;
  const workspaceIds = listWorkspaceIds(source);
  if (workspaceIds.length < 2) return null;
  const packedDbPath = resolvePackedWorkingCopy(input.dataDirRoot);
  const requireReuse = input.requireReuse === true || isSliceReuseRequired(env);
  if (input.snapshotDbPath !== undefined) {
    return await reuseOrExplodeSealedSlices({
      snapshotDbPath: input.snapshotDbPath,
      packedDbPath,
      workspaceIds,
      requireReuse,
      onProgress: input.onProgress
    });
  }
  return await reuseOrExplodeSealedSlices({
    snapshotDbPath: packedDbPath,
    packedDbPath,
    destDir: join(input.dataDirRoot, WORKSPACE_SLICE_DIRNAME),
    rebuildDrifted: true,
    workspaceIds,
    requireReuse,
    onProgress: input.onProgress
  });
}

export function installRecallEvalWorkspaceSlice(input: {
  readonly dataDirRoot: string;
  readonly workspaceId: string;
  readonly slices: ExplodedWorkspaceSlices;
}): void {
  const sliceDbPath = input.slices.sliceDbPaths[input.workspaceId]
    ?? workspaceSliceDbPath(input.slices.destDir, input.workspaceId);
  const expectedSha256 = input.slices.sliceMainFileSha256s[input.workspaceId];
  if (!existsSync(sliceDbPath)) {
    throw new Error(`workspace slice is missing for ${input.workspaceId}`);
  }
  if (expectedSha256 === undefined) {
    throw new Error(`workspace slice digest is missing for ${input.workspaceId}`);
  }
  const receipt = readValidWorkspaceSliceSnapshotReceipt({
    workspaceId: input.workspaceId,
    dbPath: sliceDbPath
  });
  if (receipt === null || receipt.sqlite_main_file_sha256 !== expectedSha256) {
    throw new Error(`workspace slice changed after verification for ${input.workspaceId}`);
  }
  installWorkspaceSlice({
    dataDir: input.dataDirRoot,
    sliceDbPath,
    expectedSha256
  });
}

async function restoreSealedSlicesForWorker(input: {
  readonly snapshotDbPath?: string;
}): Promise<ExplodedWorkspaceSlices> {
  if (input.snapshotDbPath === undefined) {
    throw new Error("recall-eval sealed slice restore requires --snapshot");
  }
  const reused = await reuseSealedSlicesWithoutPackedCopy({
    snapshotDbPath: input.snapshotDbPath,
    requireReuse: true
  });
  if (reused === null) {
    throw new Error(
      "[recall-eval] sealed workspace-slice reuse is required and the cache is missing or drifted"
    );
  }
  return reused;
}
