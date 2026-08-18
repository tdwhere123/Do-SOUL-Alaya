import { constants } from "node:fs";
import { open, lstat, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WriteFileToolInput } from "@do-soul/alaya-protocol";
import {
  createAccessDenied,
  createFileToolError,
  isPathWithinRoot,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath,
  resolveOpenedFileRealPath,
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
  return await writeContainedFile(input.content, target);
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
  target: Readonly<{
    readonly resolvedPath: string;
    readonly exists: boolean;
    readonly realWritableRoots: readonly string[];
  }>
): Promise<unknown> {
  let handle: FileHandle | undefined;
  let newlyCreated = false;
  try {
    if (target.exists) {
      try {
        const linkStat = await lstat(target.resolvedPath);
        if (linkStat.isSymbolicLink()) {
          return createAccessDenied("Path is outside the workspace boundary.");
        }
      } catch (error) {
        return mapFileSystemError(error, target.resolvedPath, "WRITE_ERROR");
      }
    }

    const buffer = Buffer.from(content, "utf8");
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    if (target.exists) {
      handle = await open(target.resolvedPath, constants.O_RDWR | noFollow, 0o666);
    } else {
      handle = await open(
        target.resolvedPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o666
      );
      newlyCreated = true;
    }

    const openedFileRealPath = await resolveOpenedFileRealPath(handle.fd, target.resolvedPath);
    if (!target.realWritableRoots.some((root) => isPathWithinRoot(openedFileRealPath, root))) {
      await handle.close();
      handle = undefined;
      if (newlyCreated) {
        await unlink(target.resolvedPath).catch(swallowBestEffortCleanup("unlink-new-file"));
      }
      return createAccessDenied("Path is outside the workspace boundary.");
    }

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
      await unlink(target.resolvedPath).catch(swallowBestEffortCleanup("unlink-rolled-back-file"));
    }
    return mapFileSystemError(error, target.resolvedPath, "WRITE_ERROR");
  }
}

