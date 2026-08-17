import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  type BigIntStats
} from "node:fs";

export interface BoundedStableRegularFile {
  readonly bytes: Buffer;
  readonly identity: Readonly<{
    readonly device: string;
    readonly inode: string;
    readonly byteLength: number;
    readonly sha256: string;
  }>;
}

export function boundedArtifactEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

export function readBoundedStableRegularFile(input: {
  readonly path: string;
  readonly maxBytes: number;
  readonly label: string;
}): BoundedStableRegularFile {
  return withBoundedStableRegularFile(input, (descriptor, opened) => {
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${input.label} changed while reading`);
      offset += count;
    }
    return {
      bytes,
      identity: Object.freeze({
        device: opened.dev.toString(), inode: opened.ino.toString(),
        byteLength: Number(opened.size),
        sha256: createHash("sha256").update(bytes).digest("hex")
      })
    };
  });
}

export function readBoundedCanonicalUtf8Artifact(input: {
  readonly path: string;
  readonly maxBytes: number;
  readonly label: string;
}): string {
  let bytes: Buffer;
  try {
    bytes = readBoundedStableRegularFile(input).bytes;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`failed to read bounded regular ${input.label}: ${detail}`, { cause });
  }
  return decodeCanonicalUtf8Artifact(bytes, input.label);
}

export function decodeCanonicalUtf8Artifact(bytes: Uint8Array, label: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${label} contains invalid UTF-8`, { cause });
  }
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new Error(`${label} UTF-8 bytes are not canonical`);
  }
  return decoded;
}

export function withBoundedStableRegularFile<T>(
  input: { readonly path: string; readonly maxBytes: number; readonly label: string },
  read: (descriptor: number, opened: BigIntStats) => T
): T {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error(`O_NOFOLLOW is required to read ${input.label}`);
  }
  let descriptor: number;
  try {
    descriptor = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? ` (${String(cause.code)})` : "";
    throw new Error(`cannot open bounded regular ${input.label}: ${input.path}${code}`, { cause });
  }
  let failure: unknown;
  let result: T | undefined;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const pathBefore = lstatSync(input.path, { bigint: true });
    assertReadableIdentity(input, opened, pathBefore);
    result = read(descriptor, opened);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(input.path, { bigint: true });
    if (!sameStableFile(opened, after) || !sameStableFile(opened, pathAfter)) {
      throw new Error(`${input.label} changed during bounded read`);
    }
  } catch (cause) {
    failure = cause;
  }
  try {
    closeSync(descriptor);
  } catch (closeFailure) {
    if (failure !== undefined) {
      throw new AggregateError([failure, closeFailure], `${input.label} read and close failed`);
    }
    throw closeFailure;
  }
  if (failure !== undefined) throw failure;
  return result as T;
}

function assertReadableIdentity(
  input: { readonly maxBytes: number; readonly label: string },
  opened: BigIntStats,
  path: BigIntStats
): void {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 ||
      opened.size > BigInt(input.maxBytes)) {
    throw new Error(`${input.label} exceeds its size limit`);
  }
  if (!opened.isFile() || path.isSymbolicLink() || !sameIdentity(opened, path)) {
    throw new Error(`${input.label} is not a stable regular file`);
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
