import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readSync, renameSync, unlinkSync, writeSync, type BigIntStats
} from "node:fs";
import { dirname, join } from "node:path";
import { NO_FOLLOW_OPEN_FLAG } from "../../../fs/open-flags.js";

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export function publishBytesExclusiveDurable(input: {
  readonly destination: string;
  readonly bytes: Uint8Array;
  readonly ownerIdentity: string;
  readonly temporaryDirectory: string;
  readonly allowExistingExact?: boolean;
}): void {
  const temporary = deterministicTemporaryPath(input);
  let owned: FileIdentity | undefined;
  let failure: unknown;
  try {
    try {
      writeBytesExclusiveTracked(temporary, input.bytes, (identity) => {
        owned = identity;
      });
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
      owned = assertExactOwnedTemporary(temporary, input.bytes);
    }
    try {
      linkFileExclusiveDurable(temporary, input.destination);
    } catch (cause) {
      if (!input.allowExistingExact || !isAlreadyExists(cause)) throw cause;
      assertExactRegularFile(input.destination, input.bytes, "published destination");
      fsyncRegularFile(input.destination);
      fsyncDirectory(dirname(input.destination));
    }
  } catch (cause) {
    failure = cause;
  }
  finishOwnedTemporaryCleanup(temporary, owned, failure);
}

export function writeBytesExclusiveDurable(
  path: string,
  bytes: Uint8Array
): void {
  writeBytesExclusiveTracked(path, bytes, () => undefined);
}

export function replaceBytesDurable(input: {
  readonly destination: string;
  readonly bytes: Uint8Array;
  readonly ownerIdentity: string;
  readonly temporaryDirectory: string;
}): void {
  const temporary = deterministicTemporaryPath(input);
  let owned: FileIdentity | undefined;
  let failure: unknown;
  try {
    try {
      writeBytesExclusiveTracked(temporary, input.bytes, (identity) => {
        owned = identity;
      });
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
      owned = assertExactOwnedTemporary(temporary, input.bytes);
    }
    renameSync(temporary, input.destination);
    owned = undefined;
    fsyncRegularFile(input.destination);
    fsyncDirectory(dirname(input.destination));
  } catch (cause) {
    failure = cause;
  }
  finishOwnedTemporaryCleanup(temporary, owned, failure);
}

function writeBytesExclusiveTracked(
  path: string,
  bytes: Uint8Array,
  onCreated: (identity: FileIdentity) => void
): void {
  const descriptor = openSync(
    path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600
  );
  runAndClose(descriptor, "durable write", () => {
    onCreated(fileIdentity(fstatSync(descriptor, { bigint: true })));
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  });
}

export function linkFileExclusiveDurable(source: string, destination: string): void {
  linkSync(source, destination);
  fsyncRegularFile(destination);
  fsyncDirectory(dirname(destination));
}

export function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  runAndClose(descriptor, "directory fsync", () => fsyncSync(descriptor));
}

function deterministicTemporaryPath(input: {
  readonly destination: string;
  readonly bytes: Uint8Array;
  readonly ownerIdentity: string;
  readonly temporaryDirectory: string;
}): string {
  const identity = createHash("sha256").update(input.destination).update("\0")
    .update(input.ownerIdentity).update("\0")
    .update(input.bytes).digest("hex");
  return join(input.temporaryDirectory, `.alaya-exclusive-publication-${identity}.tmp`);
}

function assertExactOwnedTemporary(path: string, expected: Uint8Array): FileIdentity {
  return assertExactRegularFile(path, expected, "deterministic publication temporary");
}

function assertExactRegularFile(
  path: string,
  expected: Uint8Array,
  label: string
): FileIdentity {
  const descriptor = openSync(path, constants.O_RDONLY | requireNoFollow());
  let identity: FileIdentity | undefined;
  runAndClose(descriptor, `${label} read`, () => {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(expected.byteLength)) {
      throw new Error(`${label} is not an exact owned publication`);
    }
    assertExactBytes(descriptor, expected, label);
    const current = lstatSync(path, { bigint: true });
    if (current.isSymbolicLink() || !sameFile(stat, current)) {
      throw new Error(`${label} identity changed`);
    }
    identity = fileIdentity(stat);
  });
  if (identity === undefined) throw new Error(`${label} identity was not established`);
  return identity;
}

function assertExactBytes(descriptor: number, expected: Uint8Array, label: string): void {
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expected.byteLength || 1));
  let offset = 0;
  while (offset < expected.byteLength) {
    const length = Math.min(buffer.length, expected.byteLength - offset);
    const read = readSync(descriptor, buffer, 0, length, offset);
    if (read !== length || !buffer.subarray(0, read).equals(
      Buffer.from(expected.buffer, expected.byteOffset + offset, read)
    )) throw new Error(`${label} content differs`);
    offset += read;
  }
}

function finishOwnedTemporaryCleanup(
  path: string,
  owned: FileIdentity | undefined,
  failure: unknown
): void {
  let cleanupFailure: unknown;
  if (owned !== undefined) {
    try {
      cleanupOwnedTemporary(path, owned);
    } catch (cause) {
      cleanupFailure = cause;
    }
  }
  if (failure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [failure, cleanupFailure], "durable publication and owned cleanup both failed"
    );
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (failure !== undefined) throw failure;
}

function cleanupOwnedTemporary(path: string, expected: FileIdentity): void {
  const current = lstatSync(path, { bigint: true });
  if (current.isSymbolicLink() || !sameIdentity(current, expected)) {
    throw new Error("owned publication temporary identity changed before cleanup");
  }
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function fsyncRegularFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | requireNoFollow());
  runAndClose(descriptor, "published file fsync", () => fsyncSync(descriptor));
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written === 0) throw new Error("durable exclusive publication made no write progress");
    offset += written;
  }
}

function runAndClose(descriptor: number, label: string, task: () => void): void {
  let primary: unknown;
  let taskFailed = false;
  try {
    task();
  } catch (cause) {
    primary = cause;
    taskFailed = true;
  }
  try {
    closeSync(descriptor);
  } catch (closeFailure) {
    if (taskFailed) {
      throw new AggregateError([primary, closeFailure], `${label} and close both failed`);
    }
    throw closeFailure;
  }
  if (taskFailed) throw primary;
}

function fileIdentity(stat: BigIntStats): FileIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentity(stat: BigIntStats, identity: FileIdentity): boolean {
  return stat.dev === identity.device && stat.ino === identity.inode;
}

function requireNoFollow(): number {
  return NO_FOLLOW_OPEN_FLAG;
}

function isAlreadyExists(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}
