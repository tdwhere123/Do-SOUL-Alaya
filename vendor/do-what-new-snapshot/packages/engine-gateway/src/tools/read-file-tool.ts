import { open } from "node:fs/promises";
import type { ToolSpec } from "@do-what/protocol";
import {
  createToolError,
  DEFAULT_MAX_BYTES,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath,
  type FileToolError
} from "./shared.js";

export const READ_FILE_TOOL_SPEC: ToolSpec = {
  tool_id: "tools.read_file",
  category: "read",
  description: "Read the content of a single file within the workspace boundary.",
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

export interface ReadFileInput {
  readonly path: string;
  /** Maximum bytes to read; defaults to 1 MiB. */
  readonly maxBytes?: number;
}

export type ReadFileResult =
  | { readonly ok: true; readonly content: string; readonly bytesRead: number }
  | FileToolError;

/**
 * Reads a single file with an in-process writableRoots containment check only;
 * full sandbox escape prevention is A3 Worker Baseline Safety.
 */
export async function readFile(
  input: ReadFileInput,
  writableRoots: readonly string[]
): Promise<ReadFileResult> {
  const containedPath = resolveContainedPath(input.path, writableRoots, {
    basePath: writableRoots[0]
  });

  if (!containedPath.ok) {
    return containedPath;
  }

  const maxBytes = normalizeMaxBytes(input.maxBytes);
  const entry = await readFileSystemEntry(containedPath.resolvedPath);

  if (!entry.ok) {
    return entry;
  }

  if (!entry.stats.isFile()) {
    return createToolError("READ_ERROR", `Path is not a file: ${containedPath.resolvedPath}`);
  }

  // Fast-fail on the initial stat, then enforce again while streaming to cover TOCTOU races.
  if (entry.stats.size > maxBytes) {
    return createToolError("SIZE_EXCEEDED", `File exceeds the ${maxBytes}-byte limit.`);
  }

  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(containedPath.resolvedPath, "r");
    const chunks: Buffer[] = [];
    let totalBytesRead = 0;

    while (totalBytesRead <= maxBytes) {
      const remainingBytes = maxBytes + 1 - totalBytesRead;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingBytes));
      const { bytesRead } = await fileHandle.read(chunk, 0, chunk.byteLength, null);

      if (bytesRead === 0) {
        break;
      }

      totalBytesRead += bytesRead;

      if (totalBytesRead > maxBytes) {
        return createToolError("SIZE_EXCEEDED", `File exceeds the ${maxBytes}-byte limit.`);
      }

      chunks.push(chunk.subarray(0, bytesRead));
    }

    const buffer = Buffer.concat(chunks, totalBytesRead);

    return {
      ok: true,
      content: buffer.toString("utf8"),
      bytesRead: totalBytesRead
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath);
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function normalizeMaxBytes(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : DEFAULT_MAX_BYTES;
}
