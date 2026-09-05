import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import {
  isKernelWriteLeaseActive,
  type KernelWriteLease
} from "./kernel-write-lease.js";
import {
  DIRECTORY_OPEN_FLAG,
  NO_FOLLOW_OPEN_FLAG
} from "../../../fs/open-flags.js";
import {
  assertBoundDirectoryIdentity,
  assertDirectoryIdentity,
  boundDirectoryAnchor,
  openExistingCacheRoot,
  readDirectoryIdentity,
  unlinkBoundChildDirectory,
  type BoundCacheRoot,
  type DirectoryIdentity
} from "./root-directory-binding.js";

export const EXTRACTION_FILL_LOCK_DIR = ".extraction-fill.lock";
const MAX_EXTRACTION_FILL_OWNER_BYTES = 16 * 1024;
const EXTRACTION_FILL_OWNER_SCHEMA_VERSION = 3;

interface CurrentWriterLockOwner {
  readonly schema_version: typeof EXTRACTION_FILL_OWNER_SCHEMA_VERSION;
  readonly pid: number;
  readonly process_start_identity: string;
  readonly token: string;
}

export interface WriterLockHold {
  readonly rootFd: number;
  readonly stableLockPath: string;
  readonly token: string;
  readonly rootIdentity: DirectoryIdentity;
  readonly lockIdentity: DirectoryIdentity;
  readonly kernelLease: KernelWriteLease;
  readonly processStartIdentity: string;
}

export interface LeaseOwnerBinding extends WriterLockHold {
  readonly cacheRoot: string;
  readonly stableRootPath: string;
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
    boundDirectoryAnchor(boundRoot.descriptor, boundRoot.path), EXTRACTION_FILL_LOCK_DIR
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

export function assertHeldWriterLockOwner(binding: WriterLockHold): void {
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
    stableLockPath, constants.O_RDONLY | DIRECTORY_OPEN_FLAG | NO_FOLLOW_OPEN_FLAG
  );
  try {
    assertBoundDirectoryIdentity(lockFd, lockIdentity, "extraction cache writer lock");
    return parseCurrentWriterLockOwner(
      readWriterLockOwner(boundDirectoryAnchor(lockFd, stableLockPath))
    );
  } finally {
    closeSync(lockFd);
  }
}

export function assertNamedLeaseRootIdentity(binding: LeaseOwnerBinding): void {
  try {
    assertDirectoryIdentity(binding.cacheRoot, binding.rootIdentity, "extraction cache root");
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `cannot verify extraction cache root final identity: ${String(cause)}`,
      { cause }
    );
  }
}

export function removeOwnedWriterLockDirectory(binding: WriterLockHold): void {
  assertHeldWriterLockOwner(binding);
  unlinkBoundWriterLockDirectory({
    rootFd: binding.rootFd,
    parentPath: capturedLockParentPath(binding.stableLockPath),
    lockIdentity: binding.lockIdentity,
    tombstoneToken: binding.token,
    expectedToken: binding.token
  });
}

export function prepareWriterLockDirectory(
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
        removeStaleWriterLockDirectory(rootFd, lockIdentity, serializedOwner, stableLockPath);
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
    removeStaleWriterLockDirectory(rootFd, lockIdentity, serializedOwner, stableLockPath);
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
      removeStaleWriterLockDirectory(rootFd, lockIdentity, serializedOwner, stableLockPath);
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

export function publishWriterLock(input: {
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
              parentPath: capturedLockParentPath(input.stableLockPath),
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

function capturedLockParentPath(stableLockPath: string): string | undefined {
  if (process.platform === "linux") return undefined;
  return dirname(stableLockPath);
}

function removeStaleWriterLockDirectory(
  rootFd: number,
  lockIdentity: DirectoryIdentity,
  expectedSerializedOwner: string,
  stableLockPath: string
): void {
  unlinkBoundWriterLockDirectory({
    rootFd,
    parentPath: capturedLockParentPath(stableLockPath),
    lockIdentity,
    tombstoneToken: randomUUID(),
    expectedOwnerText: expectedSerializedOwner
  });
}

function unlinkBoundWriterLockDirectory(
  binding: Pick<WriterLockHold, "rootFd" | "lockIdentity"> & {
    readonly parentPath?: string;
    readonly tombstoneToken: string;
    readonly expectedToken?: string;
    readonly expectedOwnerText?: string;
  }
): void {
  unlinkBoundChildDirectory({
    parentFd: binding.rootFd,
    parentPath: binding.parentPath,
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

export function readProcessStartIdentity(pid: number): string {
  if (pid === process.pid) {
    selfProcessStartIdentity ??= readPlatformProcessStartIdentity(pid);
    return selfProcessStartIdentity;
  }
  return readPlatformProcessStartIdentity(pid);
}

let selfProcessStartIdentity: string | undefined;

function readPlatformProcessStartIdentity(pid: number): string {
  if (process.platform === "linux") return readLinuxProcessStartIdentity(pid);
  if (process.platform === "win32") return readWindowsProcessStartIdentity(pid);
  return readPosixProcessStartIdentity(pid);
}

function readLinuxProcessStartIdentity(pid: number): string {
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

function readWindowsProcessStartIdentity(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  let output: string;
  try {
    output = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
    ], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).replace(/^\uFEFF/u, "").trim();
  } catch (cause) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT", cause }
    );
  }
  if (!/^\d+$/u.test(output) || output.length > MAX_EXTRACTION_FILL_OWNER_BYTES) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  return output;
}

function readPosixProcessStartIdentity(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "status" in cause &&
        (cause as { status?: number }).status === 1) {
      throw Object.assign(
        new ExtractionCacheInvariantError("writer process start identity is unavailable"),
        { code: "ENOENT", cause }
      );
    }
    throw new ExtractionCacheInvariantError(
      `writer process start identity is unavailable: ${String(cause)}`,
      { cause }
    );
  }
  if (output.length === 0 || output.length > MAX_EXTRACTION_FILL_OWNER_BYTES) {
    throw Object.assign(
      new ExtractionCacheInvariantError("writer process start identity is unavailable"),
      { code: "ENOENT" }
    );
  }
  const parsed = Date.parse(output);
  if (!Number.isFinite(parsed)) {
    throw new ExtractionCacheInvariantError("writer process start identity is unavailable");
  }
  return String(parsed);
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null &&
    "code" in cause && cause.code === code;
}

export function runCleanupActions(actions: readonly (() => void)[]): Error[] {
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

export function throwWithCleanupFailures(
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

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
