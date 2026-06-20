import { spawn as spawnChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  INSPECTOR_CHILD_ENV_KEYS,
  INSPECTOR_STDERR_CAPTURE_LIMIT,
  READY_LINE,
  SHUTDOWN_TIMEOUT_MS
} from "./inspect-constants.js";
import type { AlayaCliContext } from "./bridge.js";
import type { InspectorChildProcess, SpawnInspectorInput } from "./inspect-types.js";

export function defaultGenerateToken(): string {
  return randomBytes(32).toString("hex");
}

export function defaultInspectorEntryPath(): string {
  return fileURLToPath(import.meta.resolve("@do-soul/alaya-inspector"));
}

export function defaultSpawnInspector(input: SpawnInspectorInput): InspectorChildProcess {
  return spawnChildProcess(process.execPath, [input.inspectorEntryPath], {
    env: buildInspectorChildEnv(input),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function buildInspectorChildEnv(input: SpawnInspectorInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INSPECTOR_CHILD_ENV_KEYS) {
    const value = input.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.ALAYA_INSPECTOR_TOKEN = input.token;
  env.ALAYA_INSPECTOR_PORT = String(input.port);
  env.ALAYA_INSPECTOR_WORKSPACE_ID = input.workspaceId;
  return env;
}

export async function waitForInspectorReady(child: InspectorChildProcess, ctx: AlayaCliContext): Promise<void> {
  const stdout = requireInspectorStdout(child);
  await new InspectorReadyWaiter(child, stdout, ctx).wait();
  pipeInspectorOutput(child, stdout, ctx);
}

export async function waitForChildExitOrSignal(child: InspectorChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    let resolved = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        process.off("SIGINT", terminate);
        process.off("SIGTERM", terminate);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve();
      }
    };
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, SHUTDOWN_TIMEOUT_MS).unref();
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    child.once("exit", finish);
  });
}

function echoInspectorLines(stream: { write(text: string): void }, chunk: Buffer | string): void {
  for (const line of chunk.toString().split(/\r?\n/u)) {
    if (line.trim().length > 0) stream.write(`[inspector] ${line}\n`);
  }
}

function requireInspectorStdout(child: InspectorChildProcess): NodeJS.ReadableStream {
  if (child.stdout === null) {
    throw new Error("inspector stdout unavailable");
  }
  return child.stdout;
}

function pipeInspectorOutput(
  child: InspectorChildProcess,
  stdout: NodeJS.ReadableStream,
  ctx: AlayaCliContext
): void {
  stdout.on("data", (chunk) => echoInspectorLines(ctx.stdout, chunk));
  child.stderr?.on("data", (chunk) => echoInspectorLines(ctx.stderr, chunk));
}

class InspectorReadyWaiter {
  private stdoutBuffer = "";
  private stderrTail = "";
  private resolve: (() => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private settled = false;

  public constructor(
    private readonly child: InspectorChildProcess,
    private readonly stdout: NodeJS.ReadableStream,
    private readonly ctx: AlayaCliContext
  ) {}

  public async wait(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.stdout.on("data", this.onStdout);
      this.child.stderr?.on("data", this.onStderr);
      this.child.once("error", this.onError);
      this.child.once("exit", this.onExit);
    });
  }

  private readonly onStdout = (chunk: Buffer | string): void => {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split(/\r?\n/u);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === READY_LINE) {
        this.finish();
        return;
      }
      if (line.trim().length > 0) {
        this.ctx.stdout.write(`[inspector] ${line}\n`);
      }
    }
  };

  private readonly onStderr = (chunk: Buffer | string): void => {
    this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-INSPECTOR_STDERR_CAPTURE_LIMIT);
    echoInspectorLines(this.ctx.stderr, chunk);
  };

  private readonly onError = (error: Error): void => {
    this.finish(error);
  };

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.finish(buildInspectorReadyExitError(code, signal, this.stderrTail));
  };

  private finish(error?: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.stdout.off("data", this.onStdout);
    this.child.stderr?.off("data", this.onStderr);
    this.child.off("error", this.onError);
    this.child.off("exit", this.onExit);
    if (error === undefined) {
      this.resolve?.();
      return;
    }
    this.reject?.(error);
  }
}

function buildInspectorReadyExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string
): Error {
  const reason = code ?? signal ?? "unknown";
  const detail = stderrTail.trim();
  return new Error(
    detail.length > 0
      ? `inspector exited before ready: ${reason}\n${detail}`
      : `inspector exited before ready: ${reason}`
  );
}
