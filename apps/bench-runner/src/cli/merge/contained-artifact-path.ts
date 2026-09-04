import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { NO_FOLLOW_OPEN_FLAG } from "../../runs/fs/open-flags.js";
import {
  isContainedPath,
  resolveOpenedDescriptorPath
} from "../../runs/fs/opened-contained-path.js";

export interface ContainedArtifactFile {
  readonly handle: FileHandle;
  readonly bytes: number;
  readBytes(maxBytes?: number): Promise<Buffer>;
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
  if (!isContainedPath(root, candidate)) {
    throw new Error(`merge refused: artifact escapes declared root '${reference}'`);
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
    handle = await open(candidate, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`merge refused: artifact is not a file '${reference}'`);
    const openedPath = await resolveOpenedArtifactPath(handle, candidate);
    if (!isContainedPath(realRoot, openedPath)) {
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
  const readBytes = async (maxBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> => {
    if (bytes > maxBytes) {
      throw new Error(`artifact exceeds ${maxBytes} bytes '${reference}'`);
    }
    const contents = await handle.readFile();
    if (contents.byteLength > maxBytes) {
      throw new Error(`artifact exceeds ${maxBytes} bytes '${reference}'`);
    }
    return contents;
  };
  return {
    handle,
    bytes,
    readBytes,
    async readUtf8(maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
      const contents = await readBytes(maxBytes);
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

async function resolveOpenedArtifactPath(
  handle: FileHandle,
  fallbackPath: string
): Promise<string> {
  try {
    return await resolveOpenedDescriptorPath(handle, fallbackPath);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`merge refused: cannot validate opened artifact descriptor: ${message}`);
  }
}
