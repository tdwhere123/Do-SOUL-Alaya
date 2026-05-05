import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildInspectorChildEnv,
  createInspectCommand,
  openCommandCandidates,
  openUrlWithSpawn,
  type BrowserOpenerChildProcess,
  type InspectorChildProcess
} from "../cli/inspect.js";
import type { AlayaCliContext } from "../cli/bridge.js";

describe("cli inspect", () => {
  it("prints a loopback token URL after the inspector child is ready", async () => {
    const child = new FakeInspectorChild();
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      spawnInspector: () => child
    });

    const promise = command.handler(createContext({ stdout }), {
      open: false,
      port: 5174,
      token: null
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(stdoutChunks.join("")).toBe("http://127.0.0.1:5174/?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  });

  it("returns a remediation when the port is busy", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const command = createInspectCommand({
      checkPortAvailable: async () => false
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null
    });

    expect(result.exitCode).toBe(75);
    expect(stderrChunks.join("")).toContain("port 5174 in use; try alaya inspect --port 5175");
  });

  it("passes token and loopback port to the inspector child and treats open as best effort", async () => {
    const child = new FakeInspectorChild();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawned: unknown[] = [];
    const opened: string[] = [];
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      spawnInspector: (input) => {
        spawned.push(input);
        return child;
      },
      openUrl: async (url) => {
        opened.push(url);
        throw new Error("missing helper");
      }
    });

    const promise = command.handler(createContext({ env: { ALAYA_INSPECTOR_ALLOW_FIXED_TOKEN: "1" }, stderr }), {
      open: true,
      port: 5175,
      token: "b".repeat(64)
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(stderrChunks.join("")).toContain("could not open browser automatically");
    expect(spawned).toMatchObject([
      {
        port: 5175,
        token: "b".repeat(64)
      }
    ]);
    expect(opened).toEqual(["http://127.0.0.1:5175/?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
  });

  it("prefers Windows browser bridge candidates when running in WSL", () => {
    expect(
      openCommandCandidates("http://127.0.0.1:5174/?token=t", {
        os: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" }
      })
    ).toEqual([
      ["wslview", ["http://127.0.0.1:5174/?token=t"]],
      ["cmd.exe", ["/c", "start", "", "http://127.0.0.1:5174/?token=t"]],
      ["xdg-open", ["http://127.0.0.1:5174/?token=t"]]
    ]);
  });

  it("falls back to the next browser opener when the first command is missing", async () => {
    const attempts: string[] = [];

    await openUrlWithSpawn("http://127.0.0.1:5174/?token=t", {
      env: { WSL_INTEROP: "/run/WSL/1_interop" },
      os: "linux",
      spawnBrowser: (command) => {
        attempts.push(command);
        const child = new FakeBrowserOpenerChild();
        setTimeout(() => {
          if (command === "wslview") {
            child.emit("error", Object.assign(new Error("missing wslview"), { code: "ENOENT" }));
            return;
          }
          child.emit("spawn");
        }, 0);
        return child;
      }
    });

    expect(attempts).toEqual(["wslview", "cmd.exe"]);
  });

  it("builds a minimal inspector child env without provider secrets", () => {
    const env = buildInspectorChildEnv({
      port: 5175,
      token: "b".repeat(64),
      inspectorEntryPath: "/tmp/inspector.js",
      env: {
        ALAYA_DAEMON_URL: "http://127.0.0.1:3000",
        ALAYA_OPENAI_SECRET_REF: "file:/tmp/secret",
        OPENAI_API_KEY: "sk-secret",
        PATH: "/usr/bin"
      }
    });

    expect(env).toEqual({
      ALAYA_DAEMON_URL: "http://127.0.0.1:3000",
      ALAYA_INSPECTOR_TOKEN: "b".repeat(64),
      ALAYA_INSPECTOR_PORT: "5175"
    });
  });

  it("rejects fixed test tokens unless the env gate is enabled", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const command = createInspectCommand({
      checkPortAvailable: async () => true
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: "c".repeat(64)
    });

    expect(result.exitCode).toBe(64);
    expect(stderrChunks.join("")).toContain("ALAYA_INSPECTOR_ALLOW_FIXED_TOKEN=1");
  });

  it("terminates the inspector child when the CLI receives SIGINT", async () => {
    const child = new FakeInspectorChild();
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "d".repeat(64),
      spawnInspector: () => child
    });

    const promise = command.handler(createContext(), {
      open: false,
      port: 5174,
      token: null
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => process.emit("SIGINT", "SIGINT"), 10);
    setTimeout(() => child.emitExit(0, null), 20);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(child.killedSignals).toContain("SIGTERM");
    expect(child.killedSignals).not.toContain("SIGKILL");
  });
});

class FakeInspectorChild extends EventEmitter implements InspectorChildProcess {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killedSignals: (NodeJS.Signals | undefined)[] = [];

  public kill(signal?: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  public emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("exit", code, signal);
  }
}

class FakeBrowserOpenerChild extends EventEmitter implements BrowserOpenerChildProcess {
  public unrefCalled = false;

  public unref(): void {
    this.unrefCalled = true;
  }
}

function createContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] },
    ...overrides
  };
}
