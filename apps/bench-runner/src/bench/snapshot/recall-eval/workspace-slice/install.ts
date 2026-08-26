import { existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import { atomicCopy } from "../../freeze/db-copy.js";
import { BENCH_DAEMON_DB_FILENAME } from "../../materialize.js";
import {
  applyBenchFastPragmaIfRequested,
  optimizeBenchDb
} from "../../../../harness/daemon/runtime/daemon-db-pragmas.js";
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
}): void {
  const working = workingAlayaDbPath(input.dataDir);
  if (!existsSync(working)) {
    atomicCopy(input.sliceDbPath, working);
    finishWorkingCopy(input.dataDir, working);
    return;
  }
  // Replacing the inode would leave the long-lived pager's prepared statements
  // bound to the previous file.
  const live = initDatabase({ filename: working });
  loadSliceIntoOpenDatabase(live, input.sliceDbPath);
  applyBenchFastPragmaIfRequested(input.dataDir);
  optimizeBenchDb(input.dataDir);
}

function finishWorkingCopy(dataDir: string, working: string): void {
  applyBenchFastPragmaIfRequested(dataDir);
  optimizeBenchDb(dataDir);
  initDatabase({ filename: working }).connection.exec("ANALYZE");
}
