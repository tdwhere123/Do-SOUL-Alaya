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
import {
  acquireKernelWriteLease,
  isKernelWriteLeaseActive,
  type KernelWriteLease
} from "./kernel-write-lease.js";

const EXTRACTION_FILL_LOCK_DIR = ".extraction-fill.lock";
const MAX_EXTRACTION_FILL_OWNER_BYTES = 16 * 1024;
const EXTRACTION_FILL_OWNER_SCHEMA_VERSION = 2;

interface DirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

interface BoundCacheRoot {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: DirectoryIdentity;
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

export function inspectExtractionCacheWriterLock(
  cacheRoot: string
): "absent" | "present" {
  let boundRoot: BoundCacheRoot;
  try {
    boundRoot = openExistingCacheRoot(cacheRoot);
  } catch {
    return "present";
  }
  const lockPath = join(boundRoot.path, EXTRACTION_FILL_LOCK_DIR);
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (cause) {
    closeSync(boundRoot.descriptor);
    return hasErrorCode(cause, "ENOENT") ? "absent" : "present";
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    closeSync(boundRoot.descriptor);
    return "present";
  }
  try {
    const owner = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: join(lockPath, "owner.json"),
      maxBytes: MAX_EXTRACTION_FILL_OWNER_BYTES,
      label: "extraction cache writer lock owner"
    })) as { readonly schema_version?: unknown };
    if (owner.schema_version !== EXTRACTION_FILL_OWNER_SCHEMA_VERSION) return "present";
    return isKernelWriteLeaseActive({
      ...boundRoot.identity,
      displayPath: boundRoot.path
    }) ? "present" : "absent";
  } catch {
    return "present";
  } finally {
    closeSync(boundRoot.descriptor);
  }
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
  const stableRootPath = `/proc/self/fd/${rootFd}`;
  const lockPath = join(absoluteRoot, EXTRACTION_FILL_LOCK_DIR);
  const token = randomUUID();
  const rootIdentity = boundRoot.identity;
  let kernelLease: KernelWriteLease | undefined;
  let metadataCreated = false;
  try {
    kernelLease = acquireKernelWriteLease({ ...rootIdentity, displayPath: absoluteRoot });
    prepareWriterLockDirectory(lockPath);
    publishWriterLock(lockPath, token);
    metadataCreated = true;
    const lockIdentity = readDirectoryIdentity(lockPath, "extraction cache writer lock");
    return createWriteLease({
      cacheRoot: absoluteRoot, stableRootPath, rootFd, lockPath, token,
      rootIdentity, lockIdentity, kernelLease
    });
  } catch (cause) {
    const acquiredKernelLease = kernelLease;
    const cleanupFailures = runCleanupActions([
      ...(metadataCreated
        ? [() => rmSync(lockPath, { recursive: true, force: true })]
        : []),
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
    stableRootPath: binding.stableRootPath,
    assertOwned: () => assertExtractionCacheWriteLeaseOwner(binding),
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

interface LeaseOwnerBinding {
  readonly cacheRoot: string;
  readonly stableRootPath: string;
  readonly rootFd: number;
  readonly lockPath: string;
  readonly token: string;
  readonly rootIdentity: DirectoryIdentity;
  readonly lockIdentity: DirectoryIdentity;
  readonly kernelLease: KernelWriteLease;
}

function releaseExtractionCacheWriteLease(binding: LeaseOwnerBinding): void {
  const failures: Error[] = [];
  try {
    assertExtractionCacheWriteLeaseOwner(binding);
    rmSync(binding.lockPath, { recursive: true, force: true });
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

function assertExtractionCacheWriteLeaseOwner(binding: LeaseOwnerBinding): void {
  binding.kernelLease.assertOwned();
  let currentToken: unknown;
  let schemaVersion: unknown;
  try {
    assertBoundDirectoryIdentity(binding.rootFd, binding.rootIdentity, "extraction cache root");
    assertDirectoryIdentity(binding.cacheRoot, binding.rootIdentity, "extraction cache root");
    assertDirectoryIdentity(binding.lockPath, binding.lockIdentity, "extraction cache writer lock");
    const owner = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: join(binding.lockPath, "owner.json"),
      maxBytes: MAX_EXTRACTION_FILL_OWNER_BYTES,
      label: "extraction cache writer lock owner"
    })) as {
      readonly schema_version?: unknown;
      readonly token?: unknown;
    };
    schemaVersion = owner.schema_version;
    currentToken = owner.token;
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `cannot verify extraction cache writer lock owner: ${String(cause)}`
    );
  }
  if (schemaVersion !== EXTRACTION_FILL_OWNER_SCHEMA_VERSION ||
      currentToken !== binding.token) {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer lock ownership changed before release"
    );
  }
}

function prepareWriterLockDirectory(lockPath: string): void {
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (cause) {
    if (hasErrorCode(cause, "ENOENT")) return;
    throw cause;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExtractionCacheInvariantError("extraction cache writer lock is not a real directory");
  }
  let schemaVersion: unknown;
  try {
    schemaVersion = (JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: join(lockPath, "owner.json"),
      maxBytes: MAX_EXTRACTION_FILL_OWNER_BYTES,
      label: "extraction cache writer lock owner"
    })) as { readonly schema_version?: unknown }).schema_version;
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `extraction cache writer lock ${lockPath} metadata is unreadable; ` +
        "manual removal requires independent proof that the prior writer stopped",
      { cause }
    );
  }
  if (schemaVersion !== EXTRACTION_FILL_OWNER_SCHEMA_VERSION) {
    throw new ExtractionCacheInvariantError(
      `extraction cache has an unverifiable legacy writer lock at ${lockPath}; ` +
        "manual removal requires independent proof that the prior writer stopped"
    );
  }
  rmSync(lockPath, { recursive: true, force: true });
}

function publishWriterLock(lockPath: string, token: string): void {
  try {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      schema_version: EXTRACTION_FILL_OWNER_SCHEMA_VERSION,
      pid: process.pid,
      token,
      started_at: new Date().toISOString()
    })}\n`, "utf8");
  } catch (cause) {
    throwWithCleanupFailures(cause, runCleanupActions([
      () => rmSync(lockPath, { recursive: true, force: true })
    ]), "writer lock publication");
  }
}

function openOrCreateCacheRoot(cacheRoot: string): BoundCacheRoot {
  mkdirSync(resolve(cacheRoot), { recursive: true });
  return openExistingCacheRoot(cacheRoot);
}

function openExistingCacheRoot(cacheRoot: string): BoundCacheRoot {
  const path = realpathSync(resolve(cacheRoot));
  const descriptor = openBoundDirectory(path);
  try {
    const identity = readBoundDirectoryIdentity(descriptor, "extraction cache root");
    assertDirectoryIdentity(path, identity, "extraction cache root");
    return Object.freeze({ path, descriptor, identity });
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
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

function readBoundDirectoryIdentity(descriptor: number, label: string): DirectoryIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isDirectory()) {
    throw new ExtractionCacheInvariantError(`${label} descriptor is not a directory`);
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

function runCleanupActions(actions: readonly (() => void)[]): Error[] {
  const failures: Error[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (cause) {
      failures.push(asError(cause));
    }
  }
  return failures;
}

function throwWithCleanupFailures(
  primary: unknown,
  cleanupFailures: readonly Error[],
  operation: string
): never {
  if (cleanupFailures.length === 0) throw primary;
  throw new AggregateError(
    [asError(primary), ...cleanupFailures],
    `extraction cache ${operation} failed and cleanup was incomplete`
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
