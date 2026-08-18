import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  open,
  readFile as fsReadFile,
  realpath,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import type { ExecShellToolInput } from "@do-soul/alaya-protocol";
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
  isNodeErrorWithCode,
  mapFileSystemError,
  readFileSystemEntry,
  resolveContainedPath,
  resolveOpenedFileRealPath,
  resolveRealWritableRoots,
  swallowBestEffortCleanup,
  type WorkspaceGitBindingStatus
} from "./tool-runtime-file-common.js";
export { writeFile } from "./tool-runtime-file-write.js";

const EXEC_COMMAND_CONTAINMENT_MESSAGE = "Command must be a real non-symlink executable inside a writable root.";

function fdExecPath(fd: number): string {
  return process.platform === "linux" ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
}

function warnExecContainmentFailure(operation: string, error: unknown): void {
  process.emitWarning(`[ToolRuntime] exec containment ${operation} failed`, {
    code: "ALAYA_EXEC_CONTAINMENT_FAILED",
    detail: JSON.stringify({
      operation,
      errno: isNodeErrorWithCode(error) ? error.code : "unknown"
    })
  });
}

function mapExecContainmentOpenError(error: unknown): ReturnType<typeof createAccessDenied> {
  if (isNodeErrorWithCode(error)) {
    if (error.code === "ENOSPC" || error.code === "EIO" || error.code === "EMFILE" || error.code === "ENFILE") {
      return mapFileSystemError(error, "exec command", "READ_ERROR");
    }
  }
  return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
}

export async function execShell(
  input: ExecShellToolInput,
  writableRoots: readonly string[]
): Promise<unknown> {
  if (writableRoots.length === 0) {
    return createAccessDenied("No writable roots are available for exec containment.");
  }

  const command = await openContainedExecutableForExec(input.command, writableRoots);
  if (!command.ok) {
    return command;
  }
  const timeoutMs = normalizeExecTimeout(input.timeoutMs);
  const cwd = await resolveExecCwd(writableRoots);
  const args = input.args !== undefined ? [...input.args] : [];

  return await new Promise((resolve) => {
    execFile(
      command.execPath,
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
        void command.release().finally(() => {
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
        });
      }
    );
  });
}

type ContainedExecutableCommand =
  | Readonly<{
      readonly ok: true;
      readonly execPath: string;
      readonly release: () => Promise<void>;
    }>
  | ReturnType<typeof createAccessDenied>;

async function openContainedExecutableForExec(
  command: string,
  writableRoots: readonly string[]
): Promise<ContainedExecutableCommand> {
  if (process.platform === "win32") {
    const resolved = await resolveContainedExecutablePath(command, writableRoots);
    if (!resolved.ok) {
      return resolved;
    }
    return {
      ok: true,
      execPath: resolved.resolvedPath,
      release: async () => undefined
    };
  }

  const containedPath = resolveContainedPath(command, writableRoots);
  if (!containedPath.ok) {
    return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
  }

  const realWritableRoots = await resolveRealWritableRoots(writableRoots);
  if (realWritableRoots.length === 0) {
    return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
  }

  let handle: FileHandle;
  try {
    handle = await open(containedPath.resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    warnExecContainmentFailure("open", error);
    return mapExecContainmentOpenError(error);
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !hasExecutableMode(stat.mode)) {
      await handle.close();
      return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
    }
    const execPath = fdExecPath(handle.fd);
    const fdRealPath = await realpath(execPath);
    if (!realWritableRoots.some((root) => isPathWithinRoot(fdRealPath, root))) {
      await handle.close();
      return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
    }
    return {
      ok: true,
      execPath,
      release: async () => {
        await handle.close();
      }
    };
  } catch (error) {
    await handle.close().catch(swallowBestEffortCleanup("close-exec-handle"));
    warnExecContainmentFailure("validate", error);
    return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
  }
}

async function resolveContainedExecutablePath(
  command: string,
  writableRoots: readonly string[]
): Promise<{ readonly ok: true; readonly resolvedPath: string } | ReturnType<typeof createAccessDenied>> {
  const containedPath = resolveContainedPath(command, writableRoots);
  if (!containedPath.ok) {
    return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
  }

  const entry = await readFileSystemEntry(containedPath.resolvedPath);
  if (!entry.ok || !entry.stats.isFile() || !hasExecutableMode(entry.stats.mode)) {
    return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
  }

  try {
    const realCommandPath = await realpath(containedPath.resolvedPath);
    const realWritableRoots = await resolveRealWritableRoots(writableRoots);
    if (!realWritableRoots.some((root) => isPathWithinRoot(realCommandPath, root))) {
      return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
    }

    return {
      ok: true,
      resolvedPath: realCommandPath
    };
  } catch (error) {
    warnExecContainmentFailure("resolve", error);
    return createAccessDenied(EXEC_COMMAND_CONTAINMENT_MESSAGE);
  }
}

async function resolveExecCwd(writableRoots: readonly string[]): Promise<string> {
  const realRoots = await resolveRealWritableRoots(writableRoots);
  return realRoots[0] ?? writableRoots[0]!;
}

function hasExecutableMode(mode: number | bigint): boolean {
  return process.platform === "win32" || (Number(mode) & 0o111) !== 0;
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
