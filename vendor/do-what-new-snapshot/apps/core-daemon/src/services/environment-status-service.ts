import { execFile } from "node:child_process";
import { ToolchainStatusSchema, type ToolchainStatus } from "@do-what/protocol";

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
  const getDatabasePath = dependencies?.getDatabasePath ?? (() => "./data/do-what.db");
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

async function defaultProbeTool(toolName: string): Promise<boolean> {
  try {
    await runExecFile("bash", ["-lc", "command -v -- \"$1\" >/dev/null 2>&1", "bash", toolName]);
    return true;
  } catch {
    return false;
  }
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
  } catch {
    return 0;
  }
}

function runExecFile(
  command: string,
  args: readonly string[],
  options?: Parameters<typeof execFile>[2]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error, stdout, stderr) => {
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

function normalizeExecFileOutput(output: string | Buffer | null | undefined): string {
  if (typeof output === "string") {
    return output;
  }

  if (output == null) {
    return "";
  }

  return output.toString();
}
