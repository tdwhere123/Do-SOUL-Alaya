import {
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";
import {
  assertRelationProjectionCurrent,
  closeCachedDatabase,
  initDatabase
} from "@do-soul/alaya-storage";
import { NO_FOLLOW_OPEN_FLAG } from "../../fs/open-flags.js";
import {
  assertOpenedFileIdentity,
  assertOpenedFilePath,
  openedFileDescriptorPath,
  openedRegularFileIdentity,
  hashRegularFileNoFollow,
  peekCachedFileSha256,
  rememberOpenedFileSha256,
  sealedDigestIdentityDrifted,
  withCachedRegularFileNoFollow,
  withRegularFileNoFollow,
  type OpenedFileIdentity
} from "../bound-file.js";

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
const DESTINATION_SQLITE_SIDECARS = ["-wal", "-shm"] as const;

export function checkpointAndCopyBenchDb(
  liveDbPath: string,
  snapshotDbPath: string,
  options?: Readonly<{ keepLiveConnection?: boolean }>
): void {
  const db = initDatabase({ filename: liveDbPath });
  try {
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
  } finally {
    // A quiescent setup may immediately consume the sealed generation with the same provider/client.
    // Its daemon remains the connection/shutdown owner; the default still closes standalone freezes.
    if (options?.keepLiveConnection !== true) closeCachedDatabase(liveDbPath);
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
  assertDistinctCopyDestination(fromPath, toPath);
  copyOpenedSourceAtomically(
    (copy) => withRegularFileNoFollow(fromPath, copy),
    toPath,
    copyFile,
    undefined
  );
}

function copyOpenedSourceAtomically(
  withSource: (copy: (openedPath: string) => void) => void,
  toPath: string,
  copyFile: CopyFileFn,
  expectedSha256: string | undefined
): void {
  mkdirSync(dirname(toPath), { recursive: true });
  prepareOwnedCopyDestination(toPath);
  const tmpPath = `${toPath}.${randomUUID()}.tmp`;
  let target: number | undefined;
  try {
    target = openSync(tmpPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_OPEN_FLAG,
      0o600);
    withSource((openedPath) => cloneOrCopyFile(
      openedPath,
      openedFileDescriptorPath(target!, tmpPath),
      copyFile
    ));
    fsyncSync(target);
    const targetIdentity = openedRegularFileIdentity(target);
    assertOpenedFileIdentity({ filePath: tmpPath, descriptor: target,
      expectedIdentity: targetIdentity });
    renameSync(tmpPath, toPath);
    const publishedIdentity = assertOpenedFilePath(toPath, target);
    if (!sameCopiedFileIdentity(targetIdentity, publishedIdentity)) {
      throw new Error(`${toPath} changed while publishing copied bytes`);
    }
    if (expectedSha256 !== undefined) {
      rememberOpenedFileSha256({ filePath: toPath, descriptor: target,
        expectedIdentity: publishedIdentity, sha256: expectedSha256 });
    }
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  } finally {
    if (target !== undefined) closeSync(target);
  }
}

function sameCopiedFileIdentity(
  beforeRename: OpenedFileIdentity,
  afterRename: OpenedFileIdentity
): boolean {
  return beforeRename.dev === afterRename.dev && beforeRename.ino === afterRename.ino &&
    beforeRename.size === afterRename.size && beforeRename.mtimeMs === afterRename.mtimeMs;
}

export function cloneCachedSealedSnapshot(input: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly expectedSha256: string;
  readonly copyFile?: CopyFileFn;
}): void {
  // Pager recycle starts a new process; the in-memory digest cache does not
  // survive. Re-hash on a miss instead of treating absence as drift.
  if (sealedDigestIdentityDrifted(input.sourcePath)) {
    throw new Error("recall-eval snapshot DB SHA-256 mismatch");
  }
  const cached = peekCachedFileSha256(input.sourcePath)
    ?? hashRegularFileNoFollow(input.sourcePath);
  if (cached !== input.expectedSha256) {
    throw new Error("recall-eval snapshot DB SHA-256 mismatch");
  }
  assertDistinctCopyDestination(input.sourcePath, input.targetPath);
  copyOpenedSourceAtomically(
    (copy) => withCachedRegularFileNoFollow({
      filePath: input.sourcePath,
      expectedSha256: input.expectedSha256,
      operation: copy
    }),
    input.targetPath,
    input.copyFile ?? copyFileSync,
    input.expectedSha256
  );
}

function assertDistinctCopyDestination(fromPath: string, toPath: string): void {
  if (resolve(fromPath) === resolve(toPath) ||
      (existsSync(toPath) && realpathSync(fromPath) === realpathSync(toPath))) {
    throw new AlayaError("VALIDATION_FAILED", `${toPath} copy destination must differ from its source`);
  }
}

function prepareOwnedCopyDestination(destinationPath: string): void {
  // Restore/install already close a cached dest then drop dest WAL/SHM. Do that
  // here so freeze hashing cannot seal a replaced main beside leftover dest WAL.
  // Source sidecars stay untouched; a live dest handle must be released first.
  closeCachedDatabase(destinationPath);
  for (const suffix of DESTINATION_SQLITE_SIDECARS) {
    rmSync(`${destinationPath}${suffix}`, { force: true });
  }
}

function isReflinkUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && REFLINK_UNSUPPORTED.has(error.code);
}
