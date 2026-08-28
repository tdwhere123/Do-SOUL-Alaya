import { existsSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import { atomicCopy, cloneCachedSealedSnapshot } from "../../freeze/db-copy.js";
import { BENCH_DAEMON_DB_FILENAME } from "../../materialize.js";
import { reloadBenchWorkingDatabase } from "../../../../harness/daemon/runtime/daemon-db-pragmas.js";
import { loadSliceIntoOpenDatabase } from "./load-open.js";
import { PACKED_WORKING_DB_FILENAME } from "./names.js";

export function packedWorkingDbPath(dataDir: string): string {
  return resolve(dataDir, PACKED_WORKING_DB_FILENAME);
}

export function workingAlayaDbPath(dataDir: string): string {
  return resolve(dataDir, BENCH_DAEMON_DB_FILENAME);
}

export function preservePackedWorkingCopy(dataDir: string): string {
  const working = workingAlayaDbPath(dataDir);
  const packed = packedWorkingDbPath(dataDir);
  if (existsSync(packed)) return packed;
  if (!existsSync(working)) {
    throw new Error("recall-eval packed working copy is missing");
  }
  const live = initDatabase({ filename: working });
  live.connection.pragma("wal_checkpoint(TRUNCATE)");
  live.close();
  renameSync(working, packed);
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${working}${suffix}`, { force: true });
    rmSync(`${packed}${suffix}`, { force: true });
  }
  return packed;
}

export function installWorkspaceSlice(input: {
  readonly dataDir: string;
  readonly sliceDbPath: string;
  readonly expectedSha256?: string;
}): void {
  const working = workingAlayaDbPath(input.dataDir);
  if (!existsSync(working)) {
    copySlice(input, working);
    reloadBenchWorkingDatabase(input.dataDir);
    return;
  }
  // Replacing the inode would leave the long-lived pager's prepared statements
  // bound to the previous file.
  const staged = `${working}.${randomUUID()}.slice`;
  try {
    copySlice(input, staged);
    const live = initDatabase({ filename: working });
    loadSliceIntoOpenDatabase(live, staged);
    // Load-open already ANALYZE main; skip a second planner pass.
    reloadBenchWorkingDatabase(input.dataDir, { analyze: false });
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${staged}${suffix}`, { force: true });
  }
}

function copySlice(
  input: { readonly sliceDbPath: string; readonly expectedSha256?: string },
  targetPath: string
): void {
  if (input.expectedSha256 === undefined) {
    atomicCopy(input.sliceDbPath, targetPath);
    return;
  }
  cloneCachedSealedSnapshot({
    sourcePath: input.sliceDbPath,
    targetPath,
    expectedSha256: input.expectedSha256
  });
}
