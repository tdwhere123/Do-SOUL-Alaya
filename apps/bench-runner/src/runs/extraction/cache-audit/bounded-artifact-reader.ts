import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  type BigIntStats
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
  boundDirectoryAnchor,
  boundDirectoryChildNoFollow,
  boundDirectoryChildPath
} from "../fill/manifest/root-directory-binding.js";

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

interface BoundDirectory {
  readonly descriptor: number;
  readonly identity: BigIntStats;
  readonly namedPath: string;
}

export function withRootBoundDirectory<T>(input: {
  readonly root: string;
  readonly segments?: readonly string[];
  readonly createRoot?: boolean;
  readonly createSegments?: boolean;
  readonly label: string;
}, operation: (stableDirectoryPath: string, stableRootPath: string) => T): T {
  const held = openRootChain(input.root, input.createRoot === true, input.label);
  try {
    const rootDirectory = held.at(-1)!;
    const stableRootPath = boundDirectoryAnchor(rootDirectory.descriptor, rootDirectory.namedPath);
    for (const segment of input.segments ?? []) {
      assertPathSegment(segment, input.label);
      held.push(openChildDirectory(
        held.at(-1)!, segment, input.createSegments === true, input.label
      ));
    }
    const directory = held.at(-1)!;
    const result = operation(
      boundDirectoryAnchor(directory.descriptor, directory.namedPath), stableRootPath
    );
    for (const directory of held) {
      if (!sameIdentity(directory.identity, fstatSync(directory.descriptor, { bigint: true }))) {
        throw new Error(`${input.label} directory identity changed during operation`);
      }
    }
    return result;
  } finally {
    for (const directory of [...held].reverse()) closeSync(directory.descriptor);
  }
}

export function readRootBoundCanonicalUtf8Artifact(input: {
  readonly root: string;
  readonly directorySegments?: readonly string[];
  readonly filename: string;
  readonly maxBytes: number;
  readonly label: string;
}): string {
  assertPathSegment(input.filename, input.label);
  return withRootBoundDirectory({
    root: input.root,
    segments: input.directorySegments,
    label: input.label
  }, (directory) => readBoundedCanonicalUtf8Artifact({
    path: `${directory}/${input.filename}`,
    maxBytes: input.maxBytes,
    label: input.label
  }));
}

function openRootChain(root: string, create: boolean, label: string): BoundDirectory[] {
  const absolute = resolve(root);
  if (!isAbsolute(absolute)) throw new Error(`${label} root must be absolute`);
  if (/^\/proc\/self\/fd\/\d+$/u.test(absolute)) {
    return [openDirectory(absolute, false, label)];
  }
  const segments = absolute.split(sep).filter(Boolean);
  const held = [openDirectory(sep, false, label)];
  try {
    for (const segment of segments) {
      held.push(openChildDirectory(held.at(-1)!, segment, create, label));
    }
    return held;
  } catch (cause) {
    for (const directory of [...held].reverse()) closeSync(directory.descriptor);
    throw cause;
  }
}

function openChildDirectory(
  parent: BoundDirectory,
  segment: string,
  create: boolean,
  label: string
): BoundDirectory {
  const anchored = boundDirectoryChildPath(parent.descriptor, parent.namedPath, segment);
  if (create) {
    try {
      mkdirSync(anchored, { mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
    }
  }
  const child = openDirectory(anchored, boundDirectoryChildNoFollow(anchored), label);
  if (!sameIdentity(parent.identity, fstatSync(parent.descriptor, { bigint: true }))) {
    closeSync(child.descriptor);
    throw new Error(`${label} parent directory identity changed while opening a child`);
  }
  return child;
}

function openDirectory(path: string, noFollow: boolean, label: string): BoundDirectory {
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    throw new Error(`${label} requires directory descriptor and no-follow support`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY |
    (noFollow ? constants.O_NOFOLLOW : 0));
  try {
    const identity = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!identity.isDirectory() || (noFollow && named.isSymbolicLink()) ||
        (!named.isSymbolicLink() && !sameIdentity(identity, named))) {
      throw new Error(`${label} directory is not a stable real directory`);
    }
    return { descriptor, identity, namedPath: path };
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}

function assertPathSegment(segment: string, label: string): void {
  if (segment.length === 0 || segment === "." || segment === ".." ||
      segment.includes("/") || segment.includes("\\")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
}
