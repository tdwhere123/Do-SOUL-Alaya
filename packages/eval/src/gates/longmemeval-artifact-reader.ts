import { constants as bufferConstants } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";

export type LongMemEvalArtifactReadErrorCode =
  | "invalid_policy"
  | "role_not_allowed"
  | "unsafe_reference"
  | "root_unavailable"
  | "unreadable"
  | "symbolic_link"
  | "not_regular_file"
  | "outside_root"
  | "size_limit_exceeded"
  | "unstable_file"
  | "invalid_utf8"
  | "invalid_json"
  | "close_failed";

export class LongMemEvalArtifactReadError extends Error {
  readonly code: LongMemEvalArtifactReadErrorCode;

  constructor(code: LongMemEvalArtifactReadErrorCode) {
    super(`LongMemEval artifact rejected (${code})`);
    this.name = "LongMemEvalArtifactReadError";
    this.code = code;
  }
}

export interface LongMemEvalArtifactReader<Role extends string> {
  readBytes(role: Role, reference: string): Promise<Uint8Array>;
  readUtf8(role: Role, reference: string): Promise<string>;
  readJson(role: Role, reference: string): Promise<unknown>;
}

export function createLongMemEvalArtifactReader<Role extends string>(input: {
  readonly root: string;
  readonly maxBytesByRole: Readonly<Record<Role, number>>;
}): LongMemEvalArtifactReader<Role> {
  if (typeof input.root !== "string" || input.root.length === 0) {
    throw rejected("invalid_policy");
  }
  const limits = copyLimits(input.maxBytesByRole);
  const readBytes = async (role: Role, reference: string): Promise<Uint8Array> =>
    readArtifactBytes(input.root, reference, limitForRole(limits, role));
  const readUtf8 = async (role: Role, reference: string): Promise<string> =>
    decodeUtf8(await readBytes(role, reference));
  return {
    readBytes,
    readUtf8,
    async readJson(role: Role, reference: string): Promise<unknown> {
      return parseJson(await readUtf8(role, reference));
    }
  };
}

function copyLimits<Role extends string>(
  policy: Readonly<Record<Role, number>>
): ReadonlyMap<string, number> {
  let entries: Array<[string, number]>;
  try {
    entries = Object.entries(policy) as Array<[string, number]>;
  } catch {
    throw rejected("invalid_policy");
  }
  if (entries.length === 0 || entries.some(([role, limit]) =>
    role.length === 0 || !Number.isSafeInteger(limit) || limit < 0 ||
    limit > bufferConstants.MAX_LENGTH)) {
    throw rejected("invalid_policy");
  }
  return new Map(entries);
}

function limitForRole(
  limits: ReadonlyMap<string, number>,
  role: string
): number {
  const limit = limits.get(role);
  if (limit === undefined) throw rejected("role_not_allowed");
  return limit;
}

async function readArtifactBytes(
  root: string,
  reference: string,
  maxBytes: number
): Promise<Buffer> {
  const candidate = resolveSafeCandidate(root, reference);
  const realRoot = await resolveRoot(root);
  await assertNotFinalSymlink(candidate);
  let handle: FileHandle | undefined;
  try {
    handle = await openForRead(candidate);
    const opened = await descriptorStat(handle);
    if (!opened.isFile()) throw rejected("not_regular_file");
    await assertPathStillBinds(candidate, opened);
    const openedPath = await resolveOpenedPath(handle, candidate, opened);
    if (!isStrictlyContained(realRoot, openedPath)) {
      throw rejected("outside_root");
    }
    return await readStableBytes(handle, opened, maxBytes);
  } catch (error) {
    throw sanitize(error, "unreadable");
  } finally {
    if (handle !== undefined) await closeHandle(handle);
  }
}

function resolveSafeCandidate(root: string, reference: string): string {
  if (typeof reference !== "string" || reference.includes("\\") ||
      reference.includes(":") ||
      path.posix.isAbsolute(reference) || path.win32.isAbsolute(reference)) {
    throw rejected("unsafe_reference");
  }
  const segments = reference.split("/");
  if (segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".." ||
    segment.includes("\0"))) {
    throw rejected("unsafe_reference");
  }
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, ...segments);
  if (!isStrictlyContained(absoluteRoot, candidate)) {
    throw rejected("unsafe_reference");
  }
  return candidate;
}

async function resolveRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    throw rejected("root_unavailable");
  }
}

async function assertNotFinalSymlink(candidate: string): Promise<void> {
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw rejected("symbolic_link");
    }
  } catch (error) {
    throw sanitize(error, "unreadable");
  }
}

async function openForRead(candidate: string): Promise<FileHandle> {
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  try {
    return await open(candidate, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw rejected(code === "ELOOP" ? "symbolic_link" : "unreadable");
  }
}

async function descriptorStat(handle: FileHandle): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } catch {
    throw rejected("unstable_file");
  }
}

async function assertPathStillBinds(
  candidate: string,
  opened: BigIntStats
): Promise<void> {
  try {
    const current = await lstat(candidate, { bigint: true });
    if (current.isSymbolicLink()) throw rejected("symbolic_link");
    if (!sameFileIdentity(opened, current)) throw rejected("unstable_file");
  } catch (error) {
    throw sanitize(error, "unstable_file");
  }
}

async function resolveOpenedPath(
  handle: FileHandle,
  candidate: string,
  opened: BigIntStats
): Promise<string> {
  for (const descriptorRoot of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return await realpath(path.join(descriptorRoot, String(handle.fd)));
    } catch {
      // Descriptor pseudo-files are not available on every supported platform.
    }
  }
  try {
    const resolved = await realpath(candidate);
    const resolvedStat = await stat(resolved, { bigint: true });
    if (!sameFileIdentity(opened, resolvedStat)) throw rejected("unstable_file");
    return resolved;
  } catch (error) {
    throw sanitize(error, "unstable_file");
  }
}

async function readStableBytes(
  handle: FileHandle,
  opened: BigIntStats,
  maxBytes: number
): Promise<Buffer> {
  const before = await descriptorStat(handle);
  if (!sameStableFile(opened, before)) throw rejected("unstable_file");
  if (before.size > BigInt(maxBytes)) throw rejected("size_limit_exceeded");
  const expectedBytes = Number(before.size);
  const contents = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const result = await handle.read(
      contents,
      offset,
      Math.min(64 * 1024, expectedBytes - offset),
      offset
    );
    if (result.bytesRead === 0) throw rejected("unstable_file");
    offset += result.bytesRead;
  }
  const trailing = await handle.read(Buffer.alloc(1), 0, 1, expectedBytes);
  const after = await descriptorStat(handle);
  if (trailing.bytesRead !== 0 || !sameStableFile(before, after)) {
    throw rejected("unstable_file");
  }
  return contents;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right) && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function isStrictlyContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function closeHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw rejected("close_failed");
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rejected("invalid_utf8");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw rejected("invalid_json");
  }
}

function sanitize(
  error: unknown,
  fallback: LongMemEvalArtifactReadErrorCode
): LongMemEvalArtifactReadError {
  return error instanceof LongMemEvalArtifactReadError
    ? error
    : rejected(fallback);
}

function rejected(
  code: LongMemEvalArtifactReadErrorCode
): LongMemEvalArtifactReadError {
  return new LongMemEvalArtifactReadError(code);
}
