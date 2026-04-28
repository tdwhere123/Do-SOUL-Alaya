import { realpath, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import type { ToolSpec, WriteFileToolInput, WriteFileToolResult } from "@do-what/protocol";
import {
  createAccessDenied,
  createToolError,
  isPathWithinRoot,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath
} from "./shared.js";

export const WRITE_FILE_TOOL_SPEC: ToolSpec = {
  tool_id: "tools.write_file",
  category: "write",
  description:
    "Write content to a file within the workspace boundary. Creates the file if it does not exist; overwrites if it does. Parent directory must already exist.",
  scope_guard: "workspace",
  read_only: false,
  destructive: false,
  concurrency_safe: false,
  interrupt_behavior: "wait",
  requires_confirmation: false,
  requires_evidence_reopen: false,
  rollback_support: "best_effort",
  fast_path_eligible: false
};

export type WriteFileInput = WriteFileToolInput;
export type WriteFileResult = WriteFileToolResult;

export async function writeFile(
  input: WriteFileInput,
  writableRoots: readonly string[]
): Promise<WriteFileResult> {
  const containedPath = resolveContainedPath(input.path, writableRoots);

  if (!containedPath.ok) {
    return containedPath;
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);

  if (!entry.ok && entry.code !== "NOT_FOUND") {
    return entry;
  }

  if (entry.ok && !entry.stats.isFile()) {
    return createToolError("WRITE_ERROR", `Path is not a regular file: ${containedPath.resolvedPath}`);
  }

  const parentDirectory = path.dirname(containedPath.resolvedPath);
  const parentEntry = await readFileSystemEntry(parentDirectory);

  if (!parentEntry.ok) {
    return parentEntry;
  }

  if (!parentEntry.stats.isDirectory()) {
    return createToolError("WRITE_ERROR", `Parent path is not a directory: ${parentDirectory}`);
  }

  try {
    const realParentDirectory = await realpath(parentDirectory);
    const realWritableRoots = await Promise.all(
      writableRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return path.resolve(root);
        }
      })
    );

    if (!realWritableRoots.some((root) => isPathWithinRoot(realParentDirectory, root))) {
      return createAccessDenied("Path is outside the workspace boundary.");
    }
  } catch (error) {
    return mapFileSystemError(error, parentDirectory, "WRITE_ERROR");
  }

  try {
    const buffer = Buffer.from(input.content, "utf8");

    // Parent realpath checks cover the common symlink-ancestor escape, but the
    // final write still has an unavoidable TOCTOU window until A3 adds a real sandbox.
    await fsWriteFile(containedPath.resolvedPath, buffer);

    return {
      ok: true,
      bytesWritten: buffer.byteLength
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath, "WRITE_ERROR");
  }
}
