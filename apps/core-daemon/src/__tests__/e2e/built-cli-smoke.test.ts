import { spawn } from "node:child_process";
import { access, constants as fsConstants, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BIN_PATH = fileURLToPath(new URL("../../../../../bin/alaya.mjs", import.meta.url));
const BRIDGE_DIST_PATH = fileURLToPath(
  new URL("../../../../../apps/core-daemon/dist/cli/bridge.js", import.meta.url)
);
const REPO_ROOT = dirname(dirname(BIN_PATH));
const BUILT_CLI_TIMEOUT_MS = 45_000;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("built CLI smoke", () => {
  it(
    "exercises install, tools list, status, and doctor through bin/alaya.mjs",
    async () => {
      await assertBuiltCliAvailable();
      const tempRoot = await mkdtemp(join(tmpdir(), "alaya-built-cli-"));
      tempDirs.push(tempRoot);
      const env = createBuiltCliEnv(tempRoot);
      const dbPath = join(tempRoot, "data", "alaya.db");

      const install = await runBuiltCli(
        [
          "install",
          "--non-interactive",
          JSON.stringify({
            db_path: dbPath,
            embedding_enabled: false,
            default_workspace: "workspace-1",
            worktree_enabled: false
          }),
          "--json"
        ],
        env
      );
      expect(install.exitCode).toBe(0);
      expect(parseJsonOutput<{ readonly ok: boolean; readonly config_dir: string }>(install.stdout)).toMatchObject({
        ok: true,
        config_dir: env.ALAYA_CONFIG_DIR
      });

      const toolsList = await runBuiltCli(["tools", "list", "--json"], env);
      expect(toolsList.exitCode).toBe(0);
      const toolNames = parseJsonOutput<{
        readonly tools: ReadonlyArray<{ readonly name: string }>;
      }>(toolsList.stdout).tools.map((tool) => tool.name);
      expect(toolNames).toEqual(
        expect.arrayContaining(["soul.recall", "soul.report_context_usage", "garden.list_pending_tasks"])
      );
      expect(toolNames.some((toolName) => toolName.startsWith("memory."))).toBe(false);

      const status = await runBuiltCli(["status", "--agent", "codex", "--json"], env);
      expect(status.exitCode).toBe(0);
      expect(parseJsonOutput<{
        readonly daemon: { readonly up: boolean };
        readonly trust: ReadonlyArray<{ readonly agent_target: string }>;
      }>(status.stdout)).toMatchObject({
        daemon: { up: true },
        trust: expect.arrayContaining([expect.objectContaining({ agent_target: "codex" })])
      });

      const doctor = await runBuiltCli(["doctor", "--json"], env);
      expect(doctor.exitCode).toBe(75);
      expect(parseJsonOutput<{
        readonly overall: string;
        readonly startup: { readonly ready: boolean };
        readonly storage: { readonly schema_ok: boolean | null };
        readonly garden: { readonly status: string };
        readonly mcp: { readonly transport: string };
      }>(doctor.stdout)).toMatchObject({
        overall: "degraded",
        startup: { ready: true },
        storage: { schema_ok: true },
        garden: { status: "degraded" },
        mcp: { transport: "ready" }
      });
    },
    60_000
  );
});

async function assertBuiltCliAvailable(): Promise<void> {
  try {
    await access(BRIDGE_DIST_PATH, fsConstants.R_OK);
  } catch {
    throw new Error("Built CLI dist missing. Run `rtk pnpm build` before built-cli smoke tests.");
  }
}

function createBuiltCliEnv(tempRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALAYA_CONFIG_DIR: join(tempRoot, "config"),
    DATA_DIR: join(tempRoot, "data"),
    HOME: join(tempRoot, "home"),
    CODEX_HOME: join(tempRoot, "codex-home"),
    ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false"
  };
}

async function runBuiltCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Built CLI command timed out: node bin/alaya.mjs ${args.join(" ")}`));
    }, BUILT_CLI_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr
      });
    });
  });
}

function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}
