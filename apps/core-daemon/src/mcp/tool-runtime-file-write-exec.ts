import { execFile } from "node:child_process";
import { readFile as fsReadFile, realpath, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import type { ExecShellToolInput, WriteFileToolInput } from "@do-soul/alaya-protocol";
import type { GitBindingValidationOptions } from "./tool-runtime-files.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_CHILD_ENV_ALLOWLIST,
  MAX_EXEC_BUFFER_BYTES,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_EXEC_TIMEOUT_MS
} from "./tool-runtime-file-constants.js";
import {
  createAccessDenied,
  createFileToolError,
  isPathWithinRoot,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath,
  type WorkspaceGitBindingStatus
} from "./tool-runtime-file-common.js";

export async function writeFile(
  input: WriteFileToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
  const containedPath = resolveContainedPath(input.path, writableRoots);
  if (!containedPath.ok) {
    return containedPath;
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);
  if (!entry.ok && entry.code !== "NOT_FOUND") {
    return entry;
  }

  if (entry.ok && !entry.stats.isFile()) {
    return createFileToolError("WRITE_ERROR", `Path is not a regular file: ${containedPath.resolvedPath}`);
  }

  const parentDirectory = path.dirname(containedPath.resolvedPath);
  const parentEntry = await readFileSystemEntry(parentDirectory);
  if (!parentEntry.ok) {
    return parentEntry;
  }

  if (!parentEntry.stats.isDirectory()) {
    return createFileToolError("WRITE_ERROR", `Parent path is not a directory: ${parentDirectory}`);
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
    await fsWriteFile(containedPath.resolvedPath, buffer);
    return {
      ok: true,
      bytesWritten: buffer.byteLength
    };
  } catch (error) {
    return mapFileSystemError(error, containedPath.resolvedPath, "WRITE_ERROR");
  }
}

export async function execShell(
  input: ExecShellToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
  if (writableRoots.length === 0) {
    return createAccessDenied("No writable roots are available for exec containment.");
  }

  const timeoutMs = normalizeExecTimeout(input.timeoutMs);
  const cwd = writableRoots[0]!;
  const args = input.args !== undefined ? [...input.args] : [];

  return await new Promise((resolve) => {
    execFile(
      input.command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_EXEC_BUFFER_BYTES,
        encoding: "utf8",
        env: createExecChildProcessEnv(),
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (error.killed === true) {
            resolve(createFileToolError("TIMEOUT", `Command timed out after ${timeoutMs}ms.`));
            return;
          }

          if (typeof error.code === "number") {
            resolve({
              ok: true,
              exitCode: error.code,
              stdout: truncateExecOutput(stdout),
              stderr: truncateExecOutput(stderr)
            });
            return;
          }

          resolve(createFileToolError("EXEC_ERROR", error.message));
          return;
        }

        resolve({
          ok: true,
          exitCode: 0,
          stdout: truncateExecOutput(stdout),
          stderr: truncateExecOutput(stderr)
        });
      }
    );
  });
}

function normalizeExecTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }

  return Math.min(value, MAX_EXEC_TIMEOUT_MS);
}

function truncateExecOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= MAX_EXEC_OUTPUT_BYTES) {
    return output;
  }

  let collectedBytes = 0;
  const truncatedChars: string[] = [];
  for (const char of output) {
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (collectedBytes + nextBytes > MAX_EXEC_OUTPUT_BYTES) {
      break;
    }

    truncatedChars.push(char);
    collectedBytes += nextBytes;
  }

  return `${truncatedChars.join("")}\n[truncated]`;
}

function createExecChildProcessEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const variableName of EXEC_CHILD_ENV_ALLOWLIST) {
    const value = process.env[variableName];
    if (typeof value === "string" && value.length > 0) {
      childEnv[variableName] = value;
    }
  }

  return childEnv;
}

export async function resolveWorkspaceGitBindingStatus(
  repoPath: string,
  _validation: GitBindingValidationOptions | undefined
): Promise<WorkspaceGitBindingStatus> {
  const resolvedRepoPath = path.resolve(repoPath);
  const gitMarkerPath = path.join(resolvedRepoPath, ".git");
  const markerEntry = await readFileSystemEntry(gitMarkerPath);

  if (!markerEntry.ok) {
    return {
      status: "unbound",
      reason: "missing_git_marker"
    };
  }

  if (markerEntry.stats.isDirectory()) {
    return {
      status: "bound",
      repo_path: resolvedRepoPath
    };
  }

  if (!markerEntry.stats.isFile()) {
    return {
      status: "unbound",
      reason: "unsupported_git_marker"
    };
  }

  const gitMarkerContent = await fsReadFile(gitMarkerPath, "utf8").catch(() => null);
  if (gitMarkerContent === null) {
    return {
      status: "unbound",
      reason: "unreadable_git_marker"
    };
  }

  const match = /^\s*gitdir:\s*(.+)\s*$/i.exec(gitMarkerContent);
  if (match === null) {
    return {
      status: "unbound",
      reason: "invalid_git_marker"
    };
  }

  const rawGitDir = match[1]!;
  const resolvedGitDir = path.isAbsolute(rawGitDir)
    ? path.resolve(rawGitDir)
    : path.resolve(resolvedRepoPath, rawGitDir);
  if (!isPathWithinRoot(resolvedGitDir, resolvedRepoPath)) {
    return {
      status: "unbound",
      reason: "gitdir_outside_repo_root"
    };
  }

  return {
    status: "bound",
    repo_path: resolvedRepoPath
  };
}

