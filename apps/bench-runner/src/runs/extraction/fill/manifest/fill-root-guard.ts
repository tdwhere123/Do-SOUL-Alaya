import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import {
  acquireKernelWriteLease,
  isKernelWriteLeaseActive,
  type KernelWriteLease
} from "./kernel-write-lease.js";
import {
  assertBoundDirectoryIdentity,
  assertDirectoryIdentity,
  openExistingCacheRoot,
  openOrCreateCacheRoot,
  readDirectoryIdentity,
  unlinkBoundChildDirectory,
  type BoundCacheRoot,
  type DirectoryIdentity
} from "./root-directory-binding.js";
export type { DirectoryIdentity };

const EXTRACTION_FILL_LOCK_DIR = ".extraction-fill.lock";
const MAX_EXTRACTION_FILL_OWNER_BYTES = 16 * 1024;
const EXTRACTION_FILL_OWNER_SCHEMA_VERSION = 3;

interface CurrentWriterLockOwner {
  readonly schema_version: typeof EXTRACTION_FILL_OWNER_SCHEMA_VERSION;
  readonly pid: number;
  readonly process_start_identity: string;
  readonly token: string;
}

export interface ExtractionCacheWriteLease {
  readonly cacheRoot: string;
  /** A unique writer generation; reservations from older generations are recoverable. */
  readonly generation: string;
  /** Path through the retained directory descriptor; it remains bound if the name is renamed. */
  readonly stableRootPath: string;
  readonly rootIdentity: DirectoryIdentity;
  assertOwned(): void;
  assertRoot(candidate: string): void;
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
  const stableLockPath = join(
    `/proc/self/fd/${boundRoot.descriptor}`, EXTRACTION_FILL_LOCK_DIR
  );
  let result: "absent" | "present" = "present";
  try {
    const stat = lstatSync(stableLockPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      parseCurrentWriterLockOwner(readWriterLockOwner(stableLockPath));
      result = isKernelWriteLeaseActive({
        ...boundRoot.identity,
        displayPath: boundRoot.path
      }) ? "present" : "absent";
    }
  } catch (cause) {
    result = hasErrorCode(cause, "ENOENT") ? "absent" : "present";
  }
  try {
    assertDirectoryIdentity(boundRoot.path, boundRoot.identity, "extraction cache root");
  } catch {
    result = "present";
  }
  try {
    closeSync(boundRoot.descriptor);
  } catch {
    result = "present";
  }
  return result;
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
  const stableLockPath = join(stableRootPath, EXTRACTION_FILL_LOCK_DIR);
  const rootIdentity = boundRoot.identity;
  let kernelLease: KernelWriteLease | undefined;
  let publishedBinding: HeldLeaseOwnerBinding | undefined;
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

interface LeaseOwnerBinding {
  readonly cacheRoot: string;
  readonly stableRootPath: string;
  readonly rootFd: number;
  readonly stableLockPath: string;
  readonly token: string;
  readonly rootIdentity: DirectoryIdentity;
  readonly lockIdentity: DirectoryIdentity;
  readonly kernelLease: KernelWriteLease;
  readonly processStartIdentity: string;
}

type HeldLeaseOwnerBinding = Omit<LeaseOwnerBinding, "cacheRoot" | "stableRootPath">;

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

function assertHeldWriterLockOwner(binding: HeldLeaseOwnerBinding): void {
  let owner: CurrentWriterLockOwner;
  try {
    assertBoundDirectoryIdentity(binding.rootFd, binding.rootIdentity, "extraction cache root");
    binding.kernelLease.assertOwned();
    owner = readHeldWriterLockOwner(binding.stableLockPath, binding.lockIdentity);
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `cannot verify extraction cache writer lock owner; ownership changed or is unreadable: ${String(cause)}`,
      { cause }
    );
  }
  if (owner.token !== binding.token) {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer lock ownership changed before release"
    );
  }
  if (owner.pid !== process.pid || owner.process_start_identity !== binding.processStartIdentity ||
      readProcessStartIdentity(process.pid) !== binding.processStartIdentity) {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer lock process ownership changed before release"
    );
  }
}

function readHeldWriterLockOwner(
  stableLockPath: string,
  lockIdentity: DirectoryIdentity
): CurrentWriterLockOwner {
  const lockFd = openSync(
    stableLockPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    assertBoundDirectoryIdentity(lockFd, lockIdentity, "extraction cache writer lock");
    return parseCurrentWriterLockOwner(readWriterLockOwner(`/proc/self/fd/${lockFd}`));
  } finally {
    closeSync(lockFd);
  }
}

function assertNamedLeaseRootIdentity(binding: LeaseOwnerBinding): void {
  try {
    assertDirectoryIdentity(binding.cacheRoot, binding.rootIdentity, "extraction cache root");
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `cannot verify extraction cache root final identity: ${String(cause)}`,
      { cause }
    );
  }
}

function removeOwnedWriterLockDirectory(binding: HeldLeaseOwnerBinding): void {
  assertHeldWriterLockOwner(binding);
  unlinkBoundWriterLockDirectory({
    rootFd: binding.rootFd,
    lockIdentity: binding.lockIdentity,
    tombstoneToken: binding.token,
    expectedToken: binding.token
  });
}

function prepareWriterLockDirectory(
  stableLockPath: string,
  rootFd: number
): void {
  let stat;
  try {
    stat = lstatSync(stableLockPath);
  } catch (cause) {
    if (hasErrorCode(cause, "ENOENT")) return;
    throw cause;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExtractionCacheInvariantError("extraction cache writer lock is not a real directory");
  }
  const lockIdentity = readDirectoryIdentity(
    stableLockPath, "extraction cache writer lock"
  );
  let serializedOwner: string;
  let owner: unknown;
  try {
    serializedOwner = readWriterLockOwnerText(stableLockPath);
    owner = JSON.parse(serializedOwner) as unknown;
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `extraction cache writer lock metadata is unreadable: ${String(cause)}`,
      { cause }
    );
  }
  if (isCurrentWriterLockSchema(owner)) {
    const currentOwner = parseCurrentWriterLockOwner(owner);
    let currentStartIdentity: string;
    try {
      currentStartIdentity = readProcessStartIdentity(currentOwner.pid);
    } catch (cause) {
      if (hasErrorCode(cause, "ENOENT")) {
        removeStaleWriterLockDirectory(rootFd, lockIdentity, serializedOwner);
        return;
      }
      throw new ExtractionCacheInvariantError(
        `extraction cache writer lock liveness is unknown: ${String(cause)}`,
        { cause }
      );
    }
    if (currentStartIdentity === currentOwner.process_start_identity) {
      throw new ExtractionCacheInvariantError("extraction cache already has an active writer");
    }
    removeStaleWriterLockDirectory(rootFd, lockIdentity, serializedOwner);
    return;
  }
  const legacyPid = readLegacyWriterPid(owner);
  if (legacyPid === undefined) {
    throw new ExtractionCacheInvariantError(
      "extraction cache has an unverifiable legacy writer lock; " +
        "manual removal requires independent proof that the prior writer stopped"
    );
  }
  try {
    readProcessStartIdentity(legacyPid);
  } catch (cause) {
    if (hasErrorCode(cause, "ENOENT")) {
      removeStaleWriterLockDirectory(rootFd, lockIdentity, serializedOwner);
      return;
    }
    throw new ExtractionCacheInvariantError(
      `extraction cache legacy writer lock liveness is unknown: ${String(cause)}`,
      { cause }
    );
  }
  throw new ExtractionCacheInvariantError(
    "extraction cache has a possibly live legacy writer lock; " +
      "manual removal requires independent proof that the prior writer stopped"
  );
}

function publishWriterLock(input: {
  readonly stableLockPath: string;
  readonly rootFd: number;
  readonly token: string;
  readonly processStartIdentity: string;
}): DirectoryIdentity {
  let lockIdentity: DirectoryIdentity | undefined;
  let ownerPublished = false;
  try {
    mkdirSync(input.stableLockPath, { mode: 0o700 });
    lockIdentity = readDirectoryIdentity(
      input.stableLockPath, "extraction cache writer lock"
    );
    const temporary = join(input.stableLockPath, `.owner.${input.token}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(writerLockOwnerFor(input))}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600
    });
    renameSync(temporary, join(input.stableLockPath, "owner.json"));
    ownerPublished = true;
    assertDirectoryIdentity(
      input.stableLockPath, lockIdentity, "extraction cache writer lock"
    );
    assertPublishedWriterLockOwner(input);
    return lockIdentity;
  } catch (cause) {
    const createdLockIdentity = lockIdentity;
    throwWithCleanupFailures(cause, runCleanupActions([
      ...(createdLockIdentity === undefined
        ? []
        : [() => {
            unlinkBoundWriterLockDirectory({
              rootFd: input.rootFd,
              lockIdentity: createdLockIdentity,
              tombstoneToken: input.token,
              ...(ownerPublished
                ? { expectedToken: input.token }
                : {})
            });
          }])
    ]), "writer lock publication");
  }
}

function writerLockOwnerFor(input: {
  readonly token: string;
  readonly processStartIdentity: string;
}): CurrentWriterLockOwner {
  return {
    schema_version: EXTRACTION_FILL_OWNER_SCHEMA_VERSION,
    pid: process.pid,
    process_start_identity: input.processStartIdentity,
    token: input.token
  };
}

function assertPublishedWriterLockOwner(input: {
  readonly stableLockPath: string;
  readonly token: string;
  readonly processStartIdentity: string;
}): void {
  const owner = parseCurrentWriterLockOwner(readWriterLockOwner(input.stableLockPath));
  if (owner.token !== input.token || owner.pid !== process.pid ||
      owner.process_start_identity !== input.processStartIdentity) {
    throw new ExtractionCacheInvariantError("extraction cache writer lock publication was replaced");
  }
}

function removeStaleWriterLockDirectory(
  rootFd: number,
  lockIdentity: DirectoryIdentity,
  expectedSerializedOwner: string
): void {
  unlinkBoundWriterLockDirectory({
    rootFd,
    lockIdentity,
    tombstoneToken: randomUUID(),
    expectedOwnerText: expectedSerializedOwner
  });
}

function unlinkBoundWriterLockDirectory(
  binding: Pick<HeldLeaseOwnerBinding, "rootFd" | "lockIdentity"> & {
    readonly tombstoneToken: string;
    readonly expectedToken?: string;
    readonly expectedOwnerText?: string;
  }
): void {
  unlinkBoundChildDirectory({
    parentFd: binding.rootFd,
    childName: EXTRACTION_FILL_LOCK_DIR,
    identity: binding.lockIdentity,
    tombstoneName: `.extraction-fill.lock.dead.${binding.tombstoneToken}`,
    assertOpened(stableChildPath) {
      if (binding.expectedToken !== undefined) {
        const owner = parseCurrentWriterLockOwner(readWriterLockOwner(stableChildPath));
        if (owner.token !== binding.expectedToken) {
          throw new ExtractionCacheInvariantError(
            "extraction cache writer lock ownership changed before release"
          );
        }
      }
      if (binding.expectedOwnerText !== undefined &&
          readWriterLockOwnerText(stableChildPath) !== binding.expectedOwnerText) {
        throw new ExtractionCacheInvariantError(
          "extraction cache writer lock ownership changed during stale recovery"
        );
      }
    }
  });
}

function readWriterLockOwner(stableLockPath: string): unknown {
  return JSON.parse(readWriterLockOwnerText(stableLockPath)) as unknown;
}

function readWriterLockOwnerText(stableLockPath: string): string {
  return readBoundedCanonicalUtf8Artifact({
    path: join(stableLockPath, "owner.json"),
    maxBytes: MAX_EXTRACTION_FILL_OWNER_BYTES,
    label: "extraction cache writer lock owner"
  });
}

function isCurrentWriterLockSchema(value: unknown): boolean {
  return isRecord(value) && value.schema_version === EXTRACTION_FILL_OWNER_SCHEMA_VERSION;
}

function parseCurrentWriterLockOwner(value: unknown): CurrentWriterLockOwner {
  if (!isRecord(value) || value.schema_version !== EXTRACTION_FILL_OWNER_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
      typeof value.process_start_identity !== "string" ||
      !/^\d+$/u.test(value.process_start_identity) ||
      typeof value.token !== "string" || value.token.length === 0) {
    throw new ExtractionCacheInvariantError("extraction cache writer lock metadata is invalid");
  }
  return value as unknown as CurrentWriterLockOwner;
}

function readLegacyWriterPid(value: unknown): number | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    return undefined;
  }
  return value.pid as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProcessStartIdentity(pid: number): string {
  const bytes = readFileSync(`/proc/${pid}/stat`);
  if (bytes.byteLength > MAX_EXTRACTION_FILL_OWNER_BYTES) {
    throw new ExtractionCacheInvariantError("writer process identity exceeds its size limit");
  }
  const stat = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const closing = stat.lastIndexOf(")");
  const startTime = stat.slice(closing + 2).trim().split(/\s+/u)[19];
  if (closing < 0 || startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new ExtractionCacheInvariantError("writer process start identity is unavailable");
  }
  return startTime;
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
