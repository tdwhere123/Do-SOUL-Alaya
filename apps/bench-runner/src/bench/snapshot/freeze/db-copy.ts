import { copyFileSync, constants, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  assertRelationProjectionCurrent,
  initDatabase
} from "@do-soul/alaya-storage";
import { assertRegularFileNoFollow } from "../bound-file.js";

export type CopyFileFn = (
  source: string,
  target: string,
  mode?: number
) => void;

const REFLINK_UNSUPPORTED = new Set([
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
  "ENOSYS",
  "ENOTTY",
  "EINVAL",
  "EPERM"
]);

export function checkpointAndCopyBenchDb(
  liveDbPath: string,
  snapshotDbPath: string
): void {
  const db = initDatabase({ filename: liveDbPath });
  assertRelationProjectionCurrent(db);
  const [checkpoint] = db.connection.pragma(
    "wal_checkpoint(TRUNCATE)"
  ) as Array<{
    readonly busy: number;
    readonly log: number;
    readonly checkpointed: number;
  }>;
  if (checkpoint === undefined || checkpoint.busy !== 0 ||
      checkpoint.log !== checkpoint.checkpointed) {
    const detail = checkpoint === undefined
      ? "missing checkpoint status"
      : `busy=${checkpoint.busy} log=${checkpoint.log} checkpointed=${checkpoint.checkpointed}`;
    throw new Error(`cannot freeze live bench DB: incomplete WAL checkpoint (${detail})`);
  }
  atomicCopy(liveDbPath, snapshotDbPath);
}

export function cloneOrCopyFile(
  fromPath: string,
  toPath: string,
  copyFile: CopyFileFn = copyFileSync
): void {
  try {
    // FORCE so missing reflink is a caught fallback, not a swallowed kernel copy.
    copyFile(fromPath, toPath, constants.COPYFILE_FICLONE_FORCE);
  } catch (error) {
    if (!isReflinkUnsupported(error)) throw error;
    copyFile(fromPath, toPath);
  }
}

export function atomicCopy(
  fromPath: string,
  toPath: string,
  copyFile: CopyFileFn = copyFileSync
): void {
  assertRegularFileNoFollow(fromPath);
  mkdirSync(dirname(toPath), { recursive: true });
  const tmpPath = `${toPath}.${randomUUID()}.tmp`;
  try {
    cloneOrCopyFile(fromPath, tmpPath, copyFile);
    renameSync(tmpPath, toPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function isReflinkUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && REFLINK_UNSUPPORTED.has(error.code);
}
