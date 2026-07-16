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
  writeSync
} from "node:fs";
import { dirname } from "node:path";

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
  try {
    if (!fstatSync(source).isFile()) throw new Error("legacy snapshot DB is not a regular file");
    target = openSync(
      input.targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600
    );
    const actualSha = copyAndHash(source, target);
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
}

function copyAndHash(source: number, target: number): string {
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
