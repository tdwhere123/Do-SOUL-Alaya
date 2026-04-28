import { lstat } from "node:fs/promises";
import path from "node:path";
import type { FileToolError as ProtocolFileToolError, FileToolErrorCode as ProtocolFileToolErrorCode } from "@do-what/protocol";

export const DEFAULT_MAX_BYTES = 1_048_576;
export const DEFAULT_MAX_RESULTS = 200;

export type FileToolErrorCode = ProtocolFileToolErrorCode;
export type FileToolError = ProtocolFileToolError;

export function createAccessDenied(message: string): FileToolError {
  return {
    ok: false,
    code: "ACCESS_DENIED",
    message
  };
}

export function createToolError(code: FileToolErrorCode, message: string): FileToolError {
  return {
    ok: false,
    code,
    message
  };
}

export function resolveContainedPath(
  inputPath: string,
  writableRoots: readonly string[],
  options: {
    readonly basePath?: string;
  } = {}
): { readonly ok: true; readonly resolvedPath: string } | FileToolError {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return createToolError("READ_ERROR", "Path is required.");
  }

  if (inputPath.includes("\0")) {
    return createToolError("READ_ERROR", "Path must not contain null bytes.");
  }

  if (writableRoots.length === 0) {
    return createAccessDenied("No writable roots are available for containment checks.");
  }

  const normalizedRoots = writableRoots.map((root) => path.resolve(root));
  const resolvedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(options.basePath ?? normalizedRoots[0]!, inputPath);

  if (!normalizedRoots.some((root) => isPathWithinRoot(resolvedPath, root))) {
    return createAccessDenied("Path is outside the workspace boundary.");
  }

  return {
    ok: true,
    resolvedPath
  };
}

export async function readFileSystemEntry(
  resolvedPath: string
): Promise<
  | { readonly ok: true; readonly stats: Awaited<ReturnType<typeof lstat>> }
  | FileToolError
> {
  try {
    const stats = await lstat(resolvedPath);

    if (stats.isSymbolicLink()) {
      return createAccessDenied(`Path is a symlink and cannot be accessed: ${resolvedPath}`);
    }

    return {
      ok: true,
      stats
    };
  } catch (error) {
    return mapFileSystemError(error, resolvedPath);
  }
}

export function mapFileSystemError(
  error: unknown,
  targetPath: string,
  fallbackCode: Extract<FileToolErrorCode, "READ_ERROR" | "WRITE_ERROR"> = "READ_ERROR"
): FileToolError {
  if (isNodeError(error)) {
    if (error.code === "ENOENT") {
      return createToolError("NOT_FOUND", `Path not found: ${targetPath}`);
    }

    if (error.code === "EACCES" || error.code === "EPERM") {
      return createAccessDenied(`Access denied: ${targetPath}`);
    }
  }

  return createToolError(
    fallbackCode,
    fallbackCode === "WRITE_ERROR"
      ? `Failed to write path: ${targetPath}`
      : `Failed to read path: ${targetPath}`
  );
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException & { readonly code: string } {
  if (!(error instanceof Error)) {
    return false;
  }

  return "code" in error && typeof error.code === "string";
}
