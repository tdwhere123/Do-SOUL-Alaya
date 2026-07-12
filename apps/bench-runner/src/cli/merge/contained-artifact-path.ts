import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface ContainedArtifactFile {
  readonly handle: FileHandle;
  readonly bytes: number;
  readUtf8(maxBytes?: number): Promise<string>;
  close(): Promise<void>;
}

export function assertSafeArtifactReference(reference: string): void {
  if (reference.length === 0 || path.isAbsolute(reference) ||
    reference.split(/[\\/]/u).includes("..")) {
    throw new Error(`merge refused: unsafe artifact reference '${reference}'`);
  }
}

export async function openContainedArtifact(
  root: string,
  reference: string
): Promise<ContainedArtifactFile | null> {
  assertSafeArtifactReference(reference);
  const candidate = path.resolve(root, reference);
  if (!isContained(root, candidate)) {
    throw new Error(`merge refused: artifact escapes declared root '${reference}'`);
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("merge refused: descriptor-bound artifact validation is unavailable");
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let handle: FileHandle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`merge refused: artifact is not a file '${reference}'`);
    const openedPath = await resolveOpenedPath(handle);
    if (!isContained(realRoot, openedPath)) {
      throw new Error(`merge refused: artifact resolves outside declared root '${reference}'`);
    }
    return containedFile(handle, info.size, reference);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function containedFile(
  handle: FileHandle,
  bytes: number,
  reference: string
): ContainedArtifactFile {
  return {
    handle,
    bytes,
    async readUtf8(maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
      if (bytes > maxBytes) {
        throw new Error(`artifact exceeds ${maxBytes} bytes '${reference}'`);
      }
      const contents = await handle.readFile();
      if (contents.byteLength > maxBytes) {
        throw new Error(`artifact exceeds ${maxBytes} bytes '${reference}'`);
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(contents);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid UTF-8 in artifact '${reference}': ${message}`);
      }
    },
    close: () => handle.close()
  };
}

async function resolveOpenedPath(handle: FileHandle): Promise<string> {
  let lastError: unknown;
  for (const descriptorRoot of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return await realpath(path.join(descriptorRoot, String(handle.fd)));
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`merge refused: cannot validate opened artifact descriptor: ${message}`);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
