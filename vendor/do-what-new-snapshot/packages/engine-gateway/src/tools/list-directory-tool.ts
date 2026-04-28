import { readdir } from "node:fs/promises";
import type { ToolSpec } from "@do-what/protocol";
import {
  createToolError,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath,
  type FileToolError
} from "./shared.js";

export const LIST_DIRECTORY_TOOL_SPEC: ToolSpec = {
  tool_id: "tools.list_directory",
  category: "read",
  description: "List the immediate contents of a directory within the workspace boundary.",
  scope_guard: "workspace",
  read_only: true,
  destructive: false,
  concurrency_safe: true,
  interrupt_behavior: "continue",
  requires_confirmation: false,
  requires_evidence_reopen: false,
  rollback_support: "none",
  fast_path_eligible: true
};

export interface ListDirectoryInput {
  readonly path: string;
}

export type ListDirectoryResult =
  | { readonly ok: true; readonly entries: readonly { name: string; isDirectory: boolean }[] }
  | FileToolError;

/**
 * Lists the immediate contents of a directory with an in-process containment
 * check only; full sandbox escape prevention is A3 Worker Baseline Safety.
 */
export async function listDirectory(
  input: ListDirectoryInput,
  writableRoots: readonly string[]
): Promise<ListDirectoryResult> {
  const containedPath = resolveContainedPath(input.path, writableRoots, {
    basePath: writableRoots[0]
  });

  if (!containedPath.ok) {
    return containedPath;
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);

  if (!entry.ok) {
    return entry;
  }

  if (!entry.stats.isDirectory()) {
    return createToolError("READ_ERROR", `Path is not a directory: ${containedPath.resolvedPath}`);
  }

  try {
    const entries = await readdir(containedPath.resolvedPath, { withFileTypes: true });

    return {
      ok: true,
      entries: entries
        .map((dirent) => ({
          name: dirent.name,
          isDirectory: dirent.isDirectory()
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath);
  }
}
