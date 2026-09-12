import { constants } from "node:fs";
import { realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WriteFileToolInput } from "@do-soul/alaya-protocol";
import { containedNoFollowFlag, openContained } from "./open-contained.js";
import {
  createAccessDenied,
  createFileToolError,
  isPathWithinRoot,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath,
  resolveRealWritableRoots,
  swallowBestEffortCleanup
} from "./tool-runtime-file-common.js";

export async function writeFile(
  input: WriteFileToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
  const target = await resolveWriteFileTarget(input.path, writableRoots);
  if (!target.ok) {
    return target.error;
  }
  return await writeContainedFile(input.content, input.path, writableRoots, target.exists);
}

async function resolveWriteFileTarget(
  inputPath: string,
  writableRoots: readonly string[]
): Promise<
  | Readonly<{
      readonly ok: true;
      readonly resolvedPath: string;
      readonly exists: boolean;
      readonly realWritableRoots: readonly string[];
    }>
  | Readonly<{ readonly ok: false; readonly error: unknown }>
> {
  const containedPath = resolveContainedPath(inputPath, writableRoots);
  if (!containedPath.ok) {
    return { ok: false, error: containedPath };
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);
  if (!entry.ok && entry.code !== "NOT_FOUND") {
    return { ok: false, error: entry };
  }

  if (entry.ok && !entry.stats.isFile()) {
    return {
      ok: false,
      error: createFileToolError("WRITE_ERROR", `Path is not a regular file: ${containedPath.resolvedPath}`)
    };
  }

  const parentDirectory = path.dirname(containedPath.resolvedPath);
  const parentEntry = await readFileSystemEntry(parentDirectory);
  if (!parentEntry.ok) {
    return { ok: false, error: parentEntry };
  }

  if (!parentEntry.stats.isDirectory()) {
    return {
      ok: false,
      error: createFileToolError("WRITE_ERROR", `Parent path is not a directory: ${parentDirectory}`)
    };
  }

  try {
    const realParentDirectory = await realpath(parentDirectory);
    const realWritableRoots = await resolveRealWritableRoots(writableRoots);
    if (!realWritableRoots.some((root) => isPathWithinRoot(realParentDirectory, root))) {
      return { ok: false, error: createAccessDenied("Path is outside the workspace boundary.") };
    }
    return {
      ok: true,
      resolvedPath: containedPath.resolvedPath,
      exists: entry.ok,
      realWritableRoots
    };
  } catch (error) {
    return { ok: false, error: mapFileSystemError(error, parentDirectory, "WRITE_ERROR") };
  }
}

async function writeContainedFile(
  content: string,
  inputPath: string,
  writableRoots: readonly string[],
  exists: boolean
): Promise<unknown> {
  const noFollow = containedNoFollowFlag();
  const flags = exists
    ? constants.O_RDWR | noFollow
    : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow;
  const opened = await openContained(inputPath, writableRoots, "file", {
    flags,
    mode: 0o666,
    errorCode: "WRITE_ERROR"
  });
  if (!opened.ok) {
    return opened;
  }

  let handle: FileHandle | undefined = opened.handle;
  const newlyCreated = !exists;
  try {
    const buffer = Buffer.from(content, "utf8");
    await handle.truncate(0);
    await handle.write(buffer, 0, buffer.length, 0);
    await handle.close();
    handle = undefined;
    return {
      ok: true,
      bytesWritten: buffer.byteLength
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(swallowBestEffortCleanup("close-write-handle"));
    }
    if (newlyCreated) {
      await unlink(opened.realPath).catch(swallowBestEffortCleanup("unlink-rolled-back-file"));
    }
    return mapFileSystemError(error, opened.realPath, "WRITE_ERROR");
  }
}
