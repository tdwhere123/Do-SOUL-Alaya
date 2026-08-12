import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";

const EXTRACTION_FILL_LOCK_DIR = ".extraction-fill.lock";
const MAX_EXTRACTION_FILL_OWNER_BYTES = 16 * 1024;

interface DirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface ExtractionCacheWriteLease {
  readonly cacheRoot: string;
  /** Path through the retained directory descriptor; it remains bound if the name is renamed. */
  readonly stableRootPath: string;
  assertOwned(): void;
  release(): void;
}

export function isStableLeasePath(path: string): boolean {
  return /^\/proc\/self\/fd\/\d+(?:\/|$)/u.test(path);
}

export interface ExtractionCacheWriteLeaseSet {
  readonly leases: readonly ExtractionCacheWriteLease[];
  leaseFor(cacheRoot: string): ExtractionCacheWriteLease;
  assertOwned(): void;
  release(): void;
}

export function acquireExtractionCacheWriteLease(
  cacheRoot: string
): ExtractionCacheWriteLease {
  const absoluteRoot = resolve(cacheRoot);
  mkdirSync(absoluteRoot, { recursive: true });
  const rootFd = openBoundDirectory(absoluteRoot);
  const stableRootPath = `/proc/self/fd/${rootFd}`;
  const lockPath = join(absoluteRoot, EXTRACTION_FILL_LOCK_DIR);
  const token = randomUUID();
  try {
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() })}\n`,
      "utf8"
    );
  } catch (cause) {
    if (hasErrorCode(cause, "EEXIST")) {
      closeSync(rootFd);
      throw new ExtractionCacheInvariantError(
        `extraction cache root ${absoluteRoot} already has a writer lock; ` +
          `remove ${lockPath} only after verifying its owner process is stopped`
      );
    }
    rmSync(lockPath, { recursive: true, force: true });
    closeSync(rootFd);
    throw cause;
  }
  const rootIdentity = readDirectoryIdentity(absoluteRoot, "extraction cache root");
  const lockIdentity = readDirectoryIdentity(lockPath, "extraction cache writer lock");
  let released = false;
  return {
    cacheRoot: absoluteRoot,
    stableRootPath,
    assertOwned: () => assertExtractionCacheWriteLeaseOwner({
      cacheRoot: absoluteRoot, stableRootPath, rootFd, lockPath, token,
      rootIdentity, lockIdentity
    }),
    release: () => {
      if (released) throw new Error("extraction cache writer lease was already released");
      released = true;
      releaseExtractionCacheWriteLease({
        cacheRoot: absoluteRoot, stableRootPath, rootFd, lockPath, token,
        rootIdentity, lockIdentity
      });
    }
  };
}

export function acquireOrderedExtractionCacheWriteLeases(
  cacheRoots: readonly string[]
): ExtractionCacheWriteLeaseSet {
  const roots = cacheRoots.map(canonicalLeaseRoot)
    .sort((left, right) => left.localeCompare(right));
  if (new Set(roots).size !== roots.length) {
    throw new ExtractionCacheInvariantError(
      "ordered extraction cache leases require distinct canonical roots"
    );
  }
  const leases: ExtractionCacheWriteLease[] = [];
  try {
    for (const root of roots) leases.push(acquireExtractionCacheWriteLease(root));
  } catch (cause) {
    const releaseErrors = releaseLeases(leases);
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [cause, ...releaseErrors],
        "ordered extraction cache lease acquisition failed and rollback was incomplete"
      );
    }
    throw cause;
  }
  return leaseSet(leases);
}

function leaseSet(leases: readonly ExtractionCacheWriteLease[]): ExtractionCacheWriteLeaseSet {
  let released = false;
  return Object.freeze({
    leases: Object.freeze([...leases]),
    leaseFor(cacheRoot: string): ExtractionCacheWriteLease {
      const canonical = canonicalLeaseRoot(cacheRoot);
      const lease = leases.find((candidate) => candidate.cacheRoot === canonical);
      if (lease === undefined) throw new Error("extraction cache lease set does not own root");
      return lease;
    },
    assertOwned(): void {
      if (released) throw new Error("extraction cache lease set was already released");
      for (const lease of leases) lease.assertOwned();
    },
    release(): void {
      if (released) throw new Error("extraction cache lease set was already released");
      const errors = releaseLeases(leases);
      released = true;
      if (errors.length > 0) throw new AggregateError(errors, "extraction cache leases failed to release");
    }
  });
}

function releaseLeases(leases: readonly ExtractionCacheWriteLease[]): Error[] {
  const errors: Error[] = [];
  for (const lease of [...leases].reverse()) {
    try {
      lease.release();
    } catch (cause) {
      errors.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }
  return errors;
}

function canonicalLeaseRoot(cacheRoot: string): string {
  const absolute = resolve(cacheRoot);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new ExtractionCacheInvariantError(
      "ordered extraction cache leases require canonical non-symlink roots"
    );
  }
  return absolute;
}

export async function withExtractionCacheWriteLease<T>(
  lease: ExtractionCacheWriteLease,
  task: () => Promise<T>
): Promise<T> {
  let failed = false;
  let failure: unknown;
  try {
    return await task();
  } catch (cause) {
    failed = true;
    failure = cause;
    throw cause;
  } finally {
    try {
      lease.release();
    } catch (releaseFailure) {
      if (failed) {
        throw new AggregateError(
          [failure, releaseFailure],
          "extraction failed and its cache writer lock could not be released"
        );
      }
      throw releaseFailure;
    }
  }
}

export function assertManifestlessCacheIsEmpty(cacheRoot: string): void {
  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `extraction-fill: cannot inspect manifest-less cache root ${cacheRoot}: ${String(cause)}`
    );
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{2}$/u.test(entry.name)) continue;
    assertEmptyShardPrefix(cacheRoot, entry);
  }
}

function assertEmptyShardPrefix(
  cacheRoot: string,
  entry: { readonly name: string; isDirectory(): boolean; isSymbolicLink(): boolean }
): void {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill: manifest-less cache has a suspicious shard prefix"
    );
  }
  let children: string[];
  try {
    children = readdirSync(join(cacheRoot, entry.name));
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `extraction-fill: cannot inspect shard prefix ${entry.name}: ${String(cause)}`
    );
  }
  if (children.length > 0) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill: cache identity is not initialized but shard files already exist"
    );
  }
}

interface LeaseOwnerBinding {
  readonly cacheRoot: string;
  readonly stableRootPath: string;
  readonly rootFd: number;
  readonly lockPath: string;
  readonly token: string;
  readonly rootIdentity: DirectoryIdentity;
  readonly lockIdentity: DirectoryIdentity;
}

function releaseExtractionCacheWriteLease(binding: LeaseOwnerBinding): void {
  try {
    assertExtractionCacheWriteLeaseOwner(binding);
    rmSync(binding.lockPath, { recursive: true, force: true });
  } finally {
    closeSync(binding.rootFd);
  }
}

function assertExtractionCacheWriteLeaseOwner(binding: LeaseOwnerBinding): void {
  let currentToken: unknown;
  try {
    assertBoundDirectoryIdentity(binding.rootFd, binding.rootIdentity, "extraction cache root");
    assertDirectoryIdentity(binding.cacheRoot, binding.rootIdentity, "extraction cache root");
    assertDirectoryIdentity(binding.lockPath, binding.lockIdentity, "extraction cache writer lock");
    const owner = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: join(binding.lockPath, "owner.json"),
      maxBytes: MAX_EXTRACTION_FILL_OWNER_BYTES,
      label: "extraction cache writer lock owner"
    })) as {
      readonly token?: unknown;
    };
    currentToken = owner.token;
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `cannot verify extraction cache writer lock owner: ${String(cause)}`
    );
  }
  if (currentToken !== binding.token) {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer lock ownership changed before release"
    );
  }
}

function openBoundDirectory(path: string): number {
  const directoryFlag = constants.O_DIRECTORY;
  const noFollowFlag = constants.O_NOFOLLOW;
  if (typeof directoryFlag !== "number" || typeof noFollowFlag !== "number") {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer leases require directory descriptor support"
    );
  }
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag | noFollowFlag);
  const stat = fstatSync(descriptor);
  if (!stat.isDirectory()) {
    closeSync(descriptor);
    throw new ExtractionCacheInvariantError("extraction cache root is not a directory");
  }
  return descriptor;
}

function readDirectoryIdentity(path: string, label: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExtractionCacheInvariantError(`${label} is not a real directory`);
  }
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() });
}

function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  label: string
): void {
  const current = readDirectoryIdentity(path, label);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new ExtractionCacheInvariantError(`${label} identity changed while leased`);
  }
}

function assertBoundDirectoryIdentity(
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

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null &&
    "code" in cause && cause.code === code;
}
