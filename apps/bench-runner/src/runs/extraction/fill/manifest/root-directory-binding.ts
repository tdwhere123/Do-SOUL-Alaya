import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";

export interface DirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface BoundCacheRoot {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: DirectoryIdentity;
}

export function openOrCreateCacheRoot(cacheRoot: string): BoundCacheRoot {
  return openCacheRootChain(cacheRoot, true);
}

export function openExistingCacheRoot(cacheRoot: string): BoundCacheRoot {
  return openCacheRootChain(cacheRoot, false);
}

function openCacheRootChain(cacheRoot: string, create: boolean): BoundCacheRoot {
  const absolute = resolve(cacheRoot);
  if (/^\/proc\/self\/fd\/\d+$/u.test(absolute)) {
    const descriptor = openBoundDirectory(absolute, false);
    return Object.freeze({
      path: absolute,
      descriptor,
      identity: readBoundDirectoryIdentity(descriptor, "extraction cache root")
    });
  }
  if (!isAbsolute(absolute)) {
    throw new ExtractionCacheInvariantError("extraction cache root must be absolute");
  }
  const segments = absolute.split(sep).filter(Boolean);
  let descriptor = openBoundDirectory(sep, false);
  try {
    for (const segment of segments) {
      const anchored = `/proc/self/fd/${descriptor}/${segment}`;
      if (create) {
        try {
          mkdirSync(anchored, { mode: 0o700 });
        } catch (cause) {
          if (!hasErrorCode(cause, "EEXIST")) throw cause;
        }
      }
      const child = openBoundDirectory(anchored, true);
      closeSync(descriptor);
      descriptor = child;
    }
    const identity = readBoundDirectoryIdentity(descriptor, "extraction cache root");
    assertDirectoryIdentity(absolute, identity, "extraction cache root");
    return Object.freeze({ path: absolute, descriptor, identity });
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}

function openBoundDirectory(path: string, noFollow: boolean): number {
  const directoryFlag = constants.O_DIRECTORY;
  const noFollowFlag = constants.O_NOFOLLOW;
  if (typeof directoryFlag !== "number" || typeof noFollowFlag !== "number") {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer leases require directory descriptor support"
    );
  }
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag |
    (noFollow ? noFollowFlag : 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!opened.isDirectory() || (noFollow && named.isSymbolicLink()) ||
        (!named.isSymbolicLink() &&
          (opened.dev !== named.dev || opened.ino !== named.ino))) {
      throw new ExtractionCacheInvariantError("extraction cache root is not a stable real directory");
    }
    return descriptor;
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}

export function readDirectoryIdentity(path: string, label: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExtractionCacheInvariantError(`${label} is not a real directory`);
  }
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() });
}

export function readBoundDirectoryIdentity(descriptor: number, label: string): DirectoryIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isDirectory()) {
    throw new ExtractionCacheInvariantError(`${label} descriptor is not a directory`);
  }
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() });
}

export function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  label: string
): void {
  const current = readDirectoryIdentity(path, label);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new ExtractionCacheInvariantError(`${label} identity changed while leased`);
  }
}

export function assertBoundDirectoryIdentity(
  descriptor: number,
  expected: DirectoryIdentity,
  label: string
): void {
  const current = fstatSync(descriptor, { bigint: true });
  if (!current.isDirectory() || current.dev.toString() !== expected.device ||
      current.ino.toString() !== expected.inode) {
    throw new ExtractionCacheInvariantError(`${label} descriptor identity changed while leased`);
  }
}

export function unlinkBoundChildDirectory(input: {
  readonly parentFd: number;
  readonly childName: string;
  readonly identity: DirectoryIdentity;
  readonly tombstoneName: string;
  readonly assertOpened?: (stableChildPath: string) => void;
}): void {
  const childPath = `/proc/self/fd/${input.parentFd}/${input.childName}`;
  const childFd = openBoundDirectory(childPath, true);
  try {
    assertBoundDirectoryIdentity(childFd, input.identity, "bound child directory");
    input.assertOpened?.(`/proc/self/fd/${childFd}`);
    const named = readDirectoryIdentity(childPath, "bound child directory");
    if (named.device !== input.identity.device || named.inode !== input.identity.inode) {
      throw new ExtractionCacheInvariantError("bound child directory identity changed while leased");
    }
    const tombstonePath = `/proc/self/fd/${input.parentFd}/${input.tombstoneName}`;
    renameSync(childPath, tombstonePath);
    const relocated = readDirectoryIdentity(tombstonePath, "bound child directory");
    if (relocated.device !== input.identity.device || relocated.inode !== input.identity.inode) {
      try {
        renameSync(tombstonePath, childPath);
      } catch {
        // Restoring a foreign name must not hide the identity failure.
      }
      throw new ExtractionCacheInvariantError("bound child directory identity changed while leased");
    }
    const stableChild = `/proc/self/fd/${childFd}`;
    for (const child of readdirSync(stableChild)) {
      rmSync(`${stableChild}/${child}`, { recursive: true, force: true });
    }
    rmdirSync(tombstonePath);
  } finally {
    try {
      closeSync(childFd);
    } catch {
      // The directory descriptor may already be unlinked.
    }
  }
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null &&
    "code" in cause && cause.code === code;
}
