import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";

export interface InspectCommandDependencies {
  readonly generateToken?: () => string;
  readonly spawnInspector?: (input: SpawnInspectorInput) => InspectorChildProcess;
  readonly checkPortAvailable?: (port: number) => Promise<boolean>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly inspectorEntryPath?: string;
}

export interface SpawnInspectorInput {
  readonly port: number;
  readonly token: string;
  readonly inspectorEntryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface InspectorChildProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

interface InspectArgs {
  readonly open: boolean;
  readonly port: number;
  readonly token: string | null;
}

const DEFAULT_INSPECTOR_PORT = 5174;
const READY_LINE = "inspector_ready";
const SHUTDOWN_TIMEOUT_MS = 2000;

export function createInspectCommand(deps: InspectCommandDependencies = {}): AlayaSubcommandSpec<InspectArgs> {
  return {
    name: "inspect",
    description: "Start the loopback memory Inspector server.",
    argsSchema: inspectArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await executeInspect(ctx, args, deps)
  };
}

async function executeInspect(
  ctx: AlayaCliContext,
  args: InspectArgs,
  deps: InspectCommandDependencies
): Promise<AlayaCliResult> {
  const checkPortAvailable = deps.checkPortAvailable ?? defaultCheckPortAvailable;
  if (!(await checkPortAvailable(args.port))) {
    ctx.stderr.write(`port ${args.port} in use; try alaya inspect --port ${args.port + 1}\n`);
    return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
  }

  const token = args.token ?? (deps.generateToken ?? defaultGenerateToken)();
  const url = `http://127.0.0.1:${args.port}/?token=${token}`;
  const child = (deps.spawnInspector ?? defaultSpawnInspector)({
    port: args.port,
    token,
    inspectorEntryPath: deps.inspectorEntryPath ?? defaultInspectorEntryPath(),
    env: ctx.env
  });

  try {
    await waitForInspectorReady(child, ctx);
    ctx.stdout.write(`${url}\n`);
    if (args.open) {
      await (deps.openUrl ?? defaultOpenUrl)(url).catch(() => undefined);
    }
    await waitForChildExitOrSignal(child);
    return { exitCode: ALAYA_SYSEXITS.OK, json: { url, port: args.port } };
  } catch (error) {
    child.kill("SIGTERM");
    ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.SOFTWARE };
  }
}

function inspectArgsSchema(): AlayaCliArgsSchema<InspectArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return { success: false, error: { issues: [{ path: [], message: "Expected a string argument list." }] } };
      }

      let open = false;
      let port = DEFAULT_INSPECTOR_PORT;
      let token: string | null = null;
      for (let index = 0; index < input.length; index += 1) {
        const current = input[index]!;
        if (current === "--open") {
          open = true;
          continue;
        }
        if (current === "--port") {
          const value = input[index + 1];
          if (value === undefined) {
            return { success: false, error: { issues: [{ path: [index], message: "--port requires a value." }] } };
          }
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
            return { success: false, error: { issues: [{ path: [index + 1], message: "Invalid port." }] } };
          }
          port = parsed;
          index += 1;
          continue;
        }
        if (current === "--token") {
          const value = input[index + 1];
          if (value === undefined || !/^[0-9a-f]+$/iu.test(value) || value.length < 64) {
            return { success: false, error: { issues: [{ path: [index + 1], message: "Invalid token." }] } };
          }
          token = value;
          index += 1;
          continue;
        }
        return { success: false, error: { issues: [{ path: [index], message: `Unknown inspect option: ${current}` }] } };
      }

      return { success: true, data: { open, port, token } };
    }
  };
}

function defaultGenerateToken(): string {
  return randomBytes(32).toString("hex");
}

function defaultInspectorEntryPath(): string {
  return fileURLToPath(new URL("../../../inspector/dist/server.js", import.meta.url));
}

function defaultSpawnInspector(input: SpawnInspectorInput): InspectorChildProcess {
  return spawnChildProcess(process.execPath, [input.inspectorEntryPath], {
    env: {
      ...process.env,
      ...input.env,
      ALAYA_INSPECTOR_TOKEN: input.token,
      ALAYA_INSPECTOR_PORT: String(input.port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForInspectorReady(child: InspectorChildProcess, ctx: AlayaCliContext): Promise<void> {
  if (child.stdout === null) {
    throw new Error("inspector stdout unavailable");
  }

  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === READY_LINE) {
          child.stdout?.off("data", onData);
          resolve();
        } else if (line.trim().length > 0) {
          ctx.stdout.write(`[inspector] ${line}\n`);
        }
      }
    };
    child.stdout!.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`inspector exited before ready: ${code ?? signal ?? "unknown"}`)));
  });

  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/u)) {
      if (line.trim().length > 0) ctx.stdout.write(`[inspector] ${line}\n`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/u)) {
      if (line.trim().length > 0) ctx.stderr.write(`[inspector] ${line}\n`);
    }
  });
}

async function waitForChildExitOrSignal(child: InspectorChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, SHUTDOWN_TIMEOUT_MS).unref();
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    child.once("exit", finish);
  });
}

async function defaultCheckPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function defaultOpenUrl(url: string): Promise<void> {
  const [command, args] = openCommand(url);
  const child = spawnChildProcess(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function openCommand(url: string): readonly [string, readonly string[]] {
  const os = platform();
  if (os === "darwin") return ["open", [url]];
  if (os === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}
