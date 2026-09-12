import { constants } from "node:fs";
import { open, realpath, unlink, type FileHandle } from "node:fs/promises";
import type { FileToolError, FileToolErrorCode } from "@do-soul/alaya-protocol";
import {
  createAccessDenied,
  createFileToolError,
  isNodeErrorWithCode,
  isPathWithinRoot,
  mapFileSystemError,
  resolveContainedPath,
  resolveOpenedFileRealPath,
  resolveRealWritableRoots
} from "./tool-runtime-file-common.js";

const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

export function containedNoFollowFlag(): number {
  return process.platform === "win32" ? FILE_FLAG_OPEN_REPARSE_POINT : constants.O_NOFOLLOW;
}

export type OpenContainedKind = "file" | "directory";

export type OpenContainedResult =
  | Readonly<{
      readonly ok: true;
      readonly handle: FileHandle;
      readonly realPath: string;
    }>
  | FileToolError;

export async function openContained(
  inputPath: string,
  writableRoots: readonly string[],
  kind: OpenContainedKind,
  options: {
    readonly basePath?: string;
    readonly flags?: number;
    readonly mode?: number;
    readonly errorCode?: Extract<FileToolErrorCode, "READ_ERROR" | "WRITE_ERROR">;
    readonly onOpenError?: (error: unknown) => void;
  } = {}
): Promise<OpenContainedResult> {
  const errorCode = options.errorCode ?? "READ_ERROR";
  const containedPath = resolveContainedPath(inputPath, writableRoots, options);
  if (!containedPath.ok) {
    return remapContainedPathError(containedPath, errorCode);
  }

  const realWritableRoots = await resolveRealWritableRoots(writableRoots);
  if (realWritableRoots.length === 0) {
    return createAccessDenied("No writable roots are available for containment checks.");
  }

  const noFollow = containedNoFollowFlag();
  const kindFlag = kind === "directory" ? (constants.O_DIRECTORY ?? 0) : 0;
  const flags = options.flags ?? (constants.O_RDONLY | noFollow | kindFlag);
  const exclusiveCreate = (flags & constants.O_CREAT) !== 0 && (flags & constants.O_EXCL) !== 0;
  let handle: FileHandle;
  try {
    handle = options.mode === undefined
      ? await open(containedPath.resolvedPath, flags)
      : await open(containedPath.resolvedPath, flags, options.mode);
  } catch (error) {
    options.onOpenError?.(error);
    if (isNodeErrorWithCode(error) && error.code === "EEXIST") {
      const escaped = await denyIfResolvedOutside(containedPath.resolvedPath, realWritableRoots);
      if (escaped !== null) {
        return escaped;
      }
    }
    return mapOpenContainedError(error, containedPath.resolvedPath, kind, errorCode);
  }

  try {
    return await validateOpenedContained(
      handle,
      containedPath.resolvedPath,
      kind,
      realWritableRoots,
      errorCode,
      exclusiveCreate
    );
  } catch (error) {
    await handle.close().catch(() => undefined);
    return mapOpenContainedError(error, containedPath.resolvedPath, kind, errorCode);
  }
}

export function containedFdPath(handle: FileHandle, realPath: string): string {
  if (process.platform === "linux") {
    return `/proc/self/fd/${handle.fd}`;
  }
  return realPath;
}

async function validateOpenedContained(
  handle: FileHandle,
  resolvedPath: string,
  kind: OpenContainedKind,
  realWritableRoots: readonly string[],
  errorCode: Extract<FileToolErrorCode, "READ_ERROR" | "WRITE_ERROR">,
  exclusiveCreate: boolean
): Promise<OpenContainedResult> {
  const stat = await handle.stat();
  if (stat.isSymbolicLink()) {
    await handle.close();
    return createAccessDenied(`Path is a symlink and cannot be accessed: ${resolvedPath}`);
  }
  if (kind === "file" && !stat.isFile()) {
    await handle.close();
    return createFileToolError(errorCode, `Path is not a file: ${resolvedPath}`);
  }
  if (kind === "directory" && !stat.isDirectory()) {
    await handle.close();
    return createFileToolError(errorCode, `Path is not a directory: ${resolvedPath}`);
  }
  const realPath = await resolveOpenedFileRealPath(handle.fd, resolvedPath);
  if (!realWritableRoots.some((root) => isPathWithinRoot(realPath, root))) {
    if (exclusiveCreate) {
      await unlink(realPath).catch(() => undefined);
    }
    await handle.close();
    return createAccessDenied("Path is outside the workspace boundary.");
  }
  return { ok: true, handle, realPath };
}

async function denyIfResolvedOutside(
  targetPath: string,
  realWritableRoots: readonly string[]
): Promise<FileToolError | null> {
  try {
    const escaped = await realpath(targetPath);
    if (!realWritableRoots.some((root) => isPathWithinRoot(escaped, root))) {
      return createAccessDenied("Path is outside the workspace boundary.");
    }
  } catch {
    return null;
  }
  return null;
}

function remapContainedPathError(
  error: FileToolError,
  errorCode: Extract<FileToolErrorCode, "READ_ERROR" | "WRITE_ERROR">
): FileToolError {
  if (error.code !== "READ_ERROR" || errorCode === "READ_ERROR") {
    return error;
  }
  return createFileToolError(errorCode, error.message);
}

function mapOpenContainedError(
  error: unknown,
  targetPath: string,
  kind: OpenContainedKind,
  errorCode: Extract<FileToolErrorCode, "READ_ERROR" | "WRITE_ERROR">
): FileToolError {
  if (isNodeErrorWithCode(error) && (error.code === "ELOOP" || error.code === "EPERM")) {
    return createAccessDenied(`Path is a symlink and cannot be accessed: ${targetPath}`);
  }
  // O_NOFOLLOW|O_DIRECTORY on a symlink reports ENOTDIR rather than ELOOP.
  if (kind === "directory" && isNodeErrorWithCode(error) && error.code === "ENOTDIR") {
    return createAccessDenied(`Path is a symlink and cannot be accessed: ${targetPath}`);
  }
  return mapFileSystemError(error, targetPath, errorCode);
}
