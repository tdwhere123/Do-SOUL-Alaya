import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import { dirname, resolve } from "node:path";

const NO_FOLLOW = constants.O_NOFOLLOW;

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

type CachedFileSha256 = Readonly<{
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}>;

const fileSha256Cache = new Map<string, CachedFileSha256>();
let fullFileContentReads = 0;

function cachedFileSha256(filePath: string): CachedFileSha256 | undefined {
  try {
    const metadata = statSync(filePath);
    const cached = fileSha256Cache.get(resolve(filePath));
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
  return fileSha256Cache.has(resolve(filePath)) && peekCachedFileSha256(filePath) === undefined;
}

export function boundFileFullContentReadCount(): number {
  return fullFileContentReads;
}

export function rememberFileSha256(filePath: string, sha256: string): void {
  const metadata = statSync(filePath);
  fileSha256Cache.set(resolve(filePath), Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    ctimeMs: metadata.ctimeMs,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256
  }));
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

export function hashRegularFileNoFollow(filePath: string): string {
  const cached = peekCachedFileSha256(filePath);
  if (cached !== undefined) {
    assertRegularFileNoFollow(filePath);
    return cached;
  }
  const source = openSync(filePath, constants.O_RDONLY | NO_FOLLOW);
  let sha256: string;
  try {
    if (!fstatSync(source).isFile()) throw new Error(`${filePath} is not a regular file`);
    sha256 = hashOpenFile(source);
  } finally {
    closeSync(source);
  }
  rememberFileSha256(filePath, sha256);
  return sha256;
}

export function copyRegularFileNoFollow(input: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly expectedSha256: string;
}): void {
  mkdirSync(dirname(input.targetPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${input.targetPath}${suffix}`, { force: true });
  const source = openSync(input.sourcePath, constants.O_RDONLY | NO_FOLLOW);
  let target: number | undefined;
  let failed = false;
  let actualSha: string | undefined;
  try {
    if (!fstatSync(source).isFile()) throw new Error("legacy snapshot DB is not a regular file");
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
  rememberFileSha256(input.sourcePath, actualSha);
  rememberFileSha256(input.targetPath, actualSha);
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
