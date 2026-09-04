import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname, resolve } from "node:path";

// Child proof process strip-types-loads this file; a .js specifier cannot see sibling .ts.
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export function readRegularFileNoFollow(filePath: string, maxBytes?: number): Buffer {
  const descriptor = openSync(filePath, constants.O_RDONLY | NO_FOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`${filePath} is not a regular file`);
    if (maxBytes === undefined) return readFileSync(descriptor);
    if (metadata.size > maxBytes) throw new Error(`${filePath} exceeds its size budget`);
    const bytes = readFixedSize(descriptor, metadata.size, filePath);
    if (fstatSync(descriptor).size !== metadata.size) {
      throw new Error(`${filePath} changed while reading`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readFixedSize(descriptor: number, size: number, filePath: string): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) throw new Error(`${filePath} changed while reading`);
    offset += count;
  }
  return bytes;
}

export function sha256Buffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type OpenedFileIdentity = Readonly<{
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly mtimeMs: number;
}>;

export type OpenedFileSha256 = OpenedFileIdentity & Readonly<{
  readonly sha256: string;
}>;

const fileSha256Cache = new Map<string, OpenedFileSha256>();
let fullFileContentReads = 0;

function digestCacheKeys(filePath: string): readonly string[] {
  const absolute = resolve(filePath);
  try {
    const physical = realpathSync(absolute);
    return physical === absolute ? [absolute] : [absolute, physical];
  } catch {
    return [absolute];
  }
}

function cachedFileSha256(filePath: string): OpenedFileSha256 | undefined {
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile()) return undefined;
    let cached: OpenedFileSha256 | undefined;
    for (const key of digestCacheKeys(filePath)) {
      cached = fileSha256Cache.get(key);
      if (cached !== undefined) break;
    }
    if (cached === undefined) return undefined;
    if (cached.dev !== metadata.dev || cached.ino !== metadata.ino ||
        cached.ctimeMs !== metadata.ctimeMs ||
        cached.size !== metadata.size || cached.mtimeMs !== metadata.mtimeMs) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

export function peekCachedFileSha256(filePath: string): string | undefined {
  return cachedFileSha256(filePath)?.sha256;
}

export function sealedDigestIdentityDrifted(filePath: string): boolean {
  const sealed = digestCacheKeys(filePath).some((key) => fileSha256Cache.has(key));
  return sealed && peekCachedFileSha256(filePath) === undefined;
}

export function withRegularFileNoFollow<T>(
  filePath: string,
  operation: (openedPath: string) => T
): T {
  return withOpenedRegularFile(filePath, undefined, operation);
}

export function withCachedRegularFileNoFollow<T>(input: {
  readonly filePath: string;
  readonly expectedSha256: string;
  readonly operation: (openedPath: string) => T;
}): T {
  const cached = cachedFileSha256(input.filePath);
  if (cached === undefined || cached.sha256 !== input.expectedSha256) {
    throw new Error(`${input.filePath} changed after cached digest`);
  }
  return withOpenedRegularFile(input.filePath, cached, input.operation);
}

export function boundFileFullContentReadCount(): number {
  return fullFileContentReads;
}

export function openedRegularFileIdentity(descriptor: number): OpenedFileIdentity {
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile()) throw new Error("opened file is not regular");
  return fileIdentity(metadata);
}

export function rememberOpenedFileSha256(input: {
  readonly filePath: string;
  readonly descriptor: number;
  readonly expectedIdentity: OpenedFileIdentity;
  readonly sha256: string;
}): void {
  const opened = openedRegularFileIdentity(input.descriptor);
  if (!sameFileIdentity(opened, input.expectedIdentity)) {
    throw new Error(`${input.filePath} changed before digest registration`);
  }
  assertOpenedFilePath(input.filePath, input.descriptor);
  const entry = Object.freeze({
    ...opened,
    sha256: input.sha256
  });
  for (const key of digestCacheKeys(input.filePath)) {
    fileSha256Cache.set(key, entry);
  }
}

export function assertOpenedFileIdentity(input: {
  readonly filePath: string;
  readonly descriptor: number;
  readonly expectedIdentity: OpenedFileIdentity;
}): OpenedFileIdentity {
  const opened = openedRegularFileIdentity(input.descriptor);
  if (!sameFileIdentity(opened, input.expectedIdentity)) {
    throw new Error(`${input.filePath} changed before digest registration`);
  }
  return assertOpenedFilePath(input.filePath, input.descriptor);
}

export function assertOpenedFilePath(
  filePath: string,
  descriptor: number
): OpenedFileIdentity {
  const opened = openedRegularFileIdentity(descriptor);
  const current = lstatSync(filePath);
  if (!current.isFile() || !sameFileIdentity(fileIdentity(current), opened)) {
    throw new Error(`${filePath} changed before digest registration`);
  }
  return opened;
}

export function assertRegularFileNoFollow(filePath: string): void {
  const descriptor = openSync(filePath, constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${filePath} is not a regular file`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function withOpenedRegularFile<T>(
  filePath: string,
  expected: OpenedFileSha256 | undefined,
  operation: (openedPath: string) => T
): T {
  const descriptor = openSync(filePath, constants.O_RDONLY | NO_FOLLOW);
  try {
    const before = openedRegularFileIdentity(descriptor);
    if (expected !== undefined && !sameFileIdentity(before, expected)) {
      throw new Error(`${filePath} changed after cached digest`);
    }
    const result = operation(openedFileDescriptorPath(descriptor, filePath));
    if (!sameFileIdentity(openedRegularFileIdentity(descriptor), before)) {
      throw new Error(`${filePath} changed while copying`);
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

export function openedFileDescriptorPath(
  descriptor: number,
  fallbackPath?: string
): string {
  if (process.platform === "linux") return `/proc/self/fd/${descriptor}`;
  if (process.platform === "darwin" || process.platform === "freebsd") {
    return `/dev/fd/${descriptor}`;
  }
  if (fallbackPath !== undefined) return fallbackPath;
  throw new Error(`descriptor-bound file copy is unsupported on ${process.platform}`);
}

function sameFileIdentity(left: OpenedFileIdentity, right: OpenedFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.ctimeMs === right.ctimeMs && left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

export function hashRegularFileNoFollow(
  filePath: string,
  hooks: Readonly<{ readonly beforeCacheRegistration?: () => void }> = {}
): string {
  return captureRegularFileSha256(filePath, hooks).sha256;
}

export function captureRegularFileSha256(
  filePath: string,
  hooks: Readonly<{ readonly beforeCacheRegistration?: () => void }> = {}
): OpenedFileSha256 {
  const cached = cachedFileSha256(filePath);
  if (cached !== undefined) {
    return withOpenedRegularFile(filePath, cached, () => cached);
  }
  const source = openSync(filePath, constants.O_RDONLY | NO_FOLLOW);
  try {
    const before = openedRegularFileIdentity(source);
    const sha256 = hashOpenFile(source);
    const after = openedRegularFileIdentity(source);
    if (!sameFileIdentity(before, after)) throw new Error(`${filePath} changed while hashing`);
    hooks.beforeCacheRegistration?.();
    rememberOpenedFileSha256({
      filePath,
      descriptor: source,
      expectedIdentity: after,
      sha256
    });
    return Object.freeze({ ...after, sha256 });
  } finally {
    closeSync(source);
  }
}

export function seedRegularFileSha256(input: {
  readonly filePath: string;
  readonly expectedIdentity: OpenedFileIdentity;
  readonly sha256: string;
}): void {
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) {
    throw new Error(`${input.filePath} parent digest is invalid`);
  }
  const source = openSync(input.filePath, constants.O_RDONLY | NO_FOLLOW);
  try {
    assertOpenedFileIdentity({
      filePath: input.filePath,
      descriptor: source,
      expectedIdentity: input.expectedIdentity
    });
    const existing = cachedFileSha256(input.filePath);
    if (existing !== undefined &&
        (existing.sha256 !== input.sha256 ||
          !sameFileIdentity(existing, input.expectedIdentity))) {
      throw new Error(`${input.filePath} changed after parent digest`);
    }
    rememberOpenedFileSha256({
      filePath: input.filePath,
      descriptor: source,
      expectedIdentity: input.expectedIdentity,
      sha256: input.sha256
    });
  } finally {
    closeSync(source);
  }
}

export function copyRegularFileNoFollow(input: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly expectedSha256: string;
  readonly beforeCacheRegistration?: () => void;
}): void {
  mkdirSync(dirname(input.targetPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${input.targetPath}${suffix}`, { force: true });
  const source = openSync(input.sourcePath, constants.O_RDONLY | NO_FOLLOW);
  let target: number | undefined;
  let failed = false;
  let actualSha: string | undefined;
  try {
    const sourceBefore = openedRegularFileIdentity(source);
    target = openSync(
      input.targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600
    );
    actualSha = copyAndHash(source, target);
    if (actualSha !== input.expectedSha256) {
      throw new Error("legacy snapshot DB SHA-256 mismatch");
    }
    fsyncSync(target);
    const sourceAfter = openedRegularFileIdentity(source);
    const targetAfter = openedRegularFileIdentity(target);
    if (!sameFileIdentity(sourceBefore, sourceAfter)) {
      throw new Error("legacy snapshot DB changed while copying");
    }
    input.beforeCacheRegistration?.();
    rememberOpenedFileSha256({ filePath: input.sourcePath, descriptor: source,
      expectedIdentity: sourceAfter, sha256: actualSha });
    rememberOpenedFileSha256({ filePath: input.targetPath, descriptor: target,
      expectedIdentity: targetAfter, sha256: actualSha });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (target !== undefined) closeSync(target);
    closeSync(source);
    if (failed) rmSync(input.targetPath, { force: true });
  }
  if (actualSha === undefined) {
    throw new Error("sealed snapshot copy produced no digest");
  }
}

function fileIdentity(metadata: OpenedFileIdentity): OpenedFileIdentity {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    ctimeMs: metadata.ctimeMs,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs
  });
}

function hashOpenFile(source: number): string {
  fullFileContentReads += 1;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = readSync(source, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function copyAndHash(source: number, target: number): string {
  fullFileContentReads += 1;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = readSync(source, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    writeAll(target, buffer, bytesRead);
    position += bytesRead;
  }
  return hash.digest("hex");
}

function writeAll(target: number, buffer: Buffer, length: number): void {
  let offset = 0;
  while (offset < length) {
    offset += writeSync(target, buffer, offset, length - offset);
  }
}
