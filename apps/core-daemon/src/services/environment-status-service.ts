import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { ToolchainStatusSchema, type ToolchainStatus } from "@do-soul/alaya-protocol";

export interface EnvironmentStatusService {
  getStatus(): Promise<ToolchainStatus>;
}

export function createEnvironmentStatusService(dependencies?: {
  readonly toolNames?: readonly string[];
  readonly probeTool?: (toolName: string) => Promise<boolean>;
  readonly countActiveWorktrees?: () => Promise<number>;
  readonly getDatabasePath?: () => string;
  readonly getFilesDirectory?: () => string;
}): EnvironmentStatusService {
  const toolNames = dependencies?.toolNames ?? ["git", "node", "pnpm", "rg"];
  const probeTool = dependencies?.probeTool ?? defaultProbeTool;
  const countActiveWorktrees = dependencies?.countActiveWorktrees ?? defaultCountActiveWorktrees;
  const getDatabasePath = dependencies?.getDatabasePath ?? (() => "./data/alaya.db");
  const getFilesDirectory = dependencies?.getFilesDirectory ?? (() => "./data/files");

  return {
    getStatus: async (): Promise<ToolchainStatus> => {
      const toolEntriesPromise = Promise.all(
        toolNames.map(async (toolName) => [toolName, await probeTool(toolName)] as const)
      );
      const activeWorktreesPromise = countActiveWorktrees();
      const [toolEntries, activeWorktrees] = await Promise.all([
        toolEntriesPromise,
        activeWorktreesPromise
      ]);
      const tools = Object.fromEntries(toolEntries);

      return ToolchainStatusSchema.parse({
        tools,
        active_worktrees: activeWorktrees,
        db_path: getDatabasePath(),
        files_dir: getFilesDirectory()
      });
    }
  };
}

const DEFAULT_ENVIRONMENT_PROBE_TIMEOUT_MS = 5_000;
const ENVIRONMENT_PROBE_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "ComSpec",
  "PATHEXT"
] as const;

async function defaultProbeTool(toolName: string): Promise<boolean> {
  return await findExecutableOnPath(toolName, process.env);
}

async function defaultCountActiveWorktrees(): Promise<number> {
  try {
    const result = await runExecFile("git", ["worktree", "list", "--porcelain"], {
      encoding: "utf8"
    });

    if (typeof result.stdout !== "string") {
      return 0;
    }

    return result.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .length;
  } catch (error) {
    // git failed: 0 here means "could not determine", not "zero worktrees" —
    // the schema's active_worktrees is a NonNegativeInt with no unknown variant,
    // so surface the degradation via a warning rather than silently reporting 0.
    process.emitWarning("[EnvironmentStatus] active worktree count unavailable; reporting 0", {
      code: "ALAYA_WORKTREE_COUNT_UNAVAILABLE",
      detail: JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      })
    });
    return 0;
  }
}

function runExecFile(
  command: string,
  args: readonly string[],
  options?: Parameters<typeof execFile>[2]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      ...options,
      timeout: DEFAULT_ENVIRONMENT_PROBE_TIMEOUT_MS,
      windowsHide: true,
      env: createEnvironmentProbeChildEnv()
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        stdout: normalizeExecFileOutput(stdout),
        stderr: normalizeExecFileOutput(stderr)
      });
    });
  });
}

async function findExecutableOnPath(toolName: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (toolName.includes("\0") || toolName.trim().length === 0) {
    return false;
  }

  if (path.isAbsolute(toolName) || toolName.includes(path.sep) || toolName.includes("/")) {
    return await isExecutablePath(toolName);
  }

  const pathValue = env.PATH;
  if (pathValue === undefined || pathValue.trim().length === 0) {
    return false;
  }

  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.trim().length === 0) {
      continue;
    }
    for (const candidateName of executableCandidateNames(toolName, env)) {
      if (await isExecutablePath(path.join(directory, candidateName))) {
        return true;
      }
    }
  }

  return false;
}

function executableCandidateNames(toolName: string, env: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform !== "win32" || path.extname(toolName).length > 0) {
    return [toolName];
  }

  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);

  return [toolName, ...extensions.map((extension) => `${toolName}${extension}`)];
}

async function isExecutablePath(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createEnvironmentProbeChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const variableName of ENVIRONMENT_PROBE_CHILD_ENV_ALLOWLIST) {
    const value = source[variableName];
    if (typeof value === "string" && value.length > 0) {
      env[variableName] = value;
    }
  }
  return env;
}

function normalizeExecFileOutput(output: string | Buffer | null | undefined): string {
  if (typeof output === "string") {
    return output;
  }

  if (output == null) {
    return "";
  }

  return output.toString();
}
