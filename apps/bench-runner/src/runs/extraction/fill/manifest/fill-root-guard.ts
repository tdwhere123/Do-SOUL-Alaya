import { closeSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { acquireKernelWriteLease, type KernelWriteLease } from "./kernel-write-lease.js";
import {
  boundDirectoryAnchor,
  isBoundDirectoryAnchor,
  openExistingCacheRoot,
  openOrCreateCacheRoot,
  type DirectoryIdentity
} from "./root-directory-binding.js";
import {
  EXTRACTION_FILL_LOCK_DIR,
  asError,
  assertHeldWriterLockOwner,
  assertNamedLeaseRootIdentity,
  prepareWriterLockDirectory,
  publishWriterLock,
  readProcessStartIdentity,
  removeOwnedWriterLockDirectory,
  runCleanupActions,
  throwWithCleanupFailures,
  type LeaseOwnerBinding,
  type WriterLockHold
} from "./writer-lock.js";
export type { DirectoryIdentity };

export interface ExtractionCacheWriteLease {
  readonly cacheRoot: string;
  /** A unique writer generation; reservations from older generations are recoverable. */
  readonly generation: string;
  /** Bound root path for child operations. Linux stays on the directory fd if the name is renamed. */
  readonly stableRootPath: string;
  readonly rootIdentity: DirectoryIdentity;
  assertOwned(): void;
  assertRoot(candidate: string): void;
  release(): void;
}

export function isStableLeasePath(path: string): boolean {
  return isBoundDirectoryAnchor(path);
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
  const boundRoot = openOrCreateCacheRoot(cacheRoot);
  const absoluteRoot = boundRoot.path;
  const rootFd = boundRoot.descriptor;
  const stableRootPath = boundDirectoryAnchor(rootFd, absoluteRoot);
  const stableLockPath = join(stableRootPath, EXTRACTION_FILL_LOCK_DIR);
  const rootIdentity = boundRoot.identity;
  let kernelLease: KernelWriteLease | undefined;
  let publishedBinding: WriterLockHold | undefined;
  try {
    const token = randomUUID();
    const processStartIdentity = readProcessStartIdentity(process.pid);
    kernelLease = acquireKernelWriteLease({ ...rootIdentity, displayPath: absoluteRoot });
    prepareWriterLockDirectory(stableLockPath, rootFd);
    const lockIdentity = publishWriterLock({
      stableLockPath, rootFd, token, processStartIdentity
    });
    publishedBinding = {
      rootFd, stableLockPath, token, rootIdentity, lockIdentity,
      kernelLease, processStartIdentity
    };
    const binding: LeaseOwnerBinding = {
      ...publishedBinding, cacheRoot: absoluteRoot, stableRootPath
    };
    assertExtractionCacheWriteLeaseOwner(binding);
    return createWriteLease(binding);
  } catch (cause) {
    const acquiredKernelLease = kernelLease;
    const acquiredPublishedBinding = publishedBinding;
    const cleanupFailures = runCleanupActions([
      ...(acquiredPublishedBinding === undefined
        ? []
        : [() => removeOwnedWriterLockDirectory(acquiredPublishedBinding)]),
      () => closeSync(rootFd),
      ...(acquiredKernelLease === undefined ? [] : [() => acquiredKernelLease.release()])
    ]);
    const primary = cause instanceof ExtractionCacheInvariantError
      ? cause
      : new ExtractionCacheInvariantError(String(cause), { cause });
    throwWithCleanupFailures(primary, cleanupFailures, "writer lease acquisition");
  }
}

function createWriteLease(binding: LeaseOwnerBinding): ExtractionCacheWriteLease {
  let released = false;
  return {
    cacheRoot: binding.cacheRoot,
    generation: binding.token,
    stableRootPath: binding.stableRootPath,
    rootIdentity: binding.rootIdentity,
    assertOwned: () => assertExtractionCacheWriteLeaseOwner(binding),
    assertRoot: (candidate) => assertLeaseRootAlias(binding, candidate),
    release: () => {
      if (released) throw new Error("extraction cache writer lease was already released");
      released = true;
      releaseExtractionCacheWriteLease(binding);
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
  const root = openExistingCacheRoot(cacheRoot);
  closeSync(root.descriptor);
  return root.path;
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
function releaseExtractionCacheWriteLease(binding: LeaseOwnerBinding): void {
  const failures: Error[] = [];
  let heldOwnershipVerified = false;
  try {
    assertHeldWriterLockOwner(binding);
    heldOwnershipVerified = true;
  } catch (cause) {
    failures.push(asError(cause));
  }
  if (heldOwnershipVerified) {
    try {
      removeOwnedWriterLockDirectory(binding);
    } catch (cause) {
      failures.push(asError(cause));
    }
  }
  try {
    assertNamedLeaseRootIdentity(binding);
  } catch (cause) {
    failures.push(asError(cause));
  }
  failures.push(...runCleanupActions([
    () => closeSync(binding.rootFd),
    () => binding.kernelLease.release()
  ]));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "extraction cache writer lease cleanup failed");
  }
}

function assertLeaseRootAlias(binding: LeaseOwnerBinding, candidate: string): void {
  const opened = openExistingCacheRoot(candidate);
  try {
    if (opened.identity.device !== binding.rootIdentity.device ||
        opened.identity.inode !== binding.rootIdentity.inode) {
      throw new ExtractionCacheInvariantError("semantic fill root is not bound to its write lease");
    }
  } finally {
    closeSync(opened.descriptor);
  }
}

function assertExtractionCacheWriteLeaseOwner(binding: LeaseOwnerBinding): void {
  assertHeldWriterLockOwner(binding);
  assertNamedLeaseRootIdentity(binding);
}
