import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createInspectCommand, type InspectorChildProcess } from "../cli/inspect.js";
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

    const promise = command.handler(createContext(), {
      open: true,
      port: 5175,
      token: "b".repeat(64)
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(spawned).toMatchObject([
      {
        port: 5175,
        token: "b".repeat(64)
      }
    ]);
    expect(opened).toEqual(["http://127.0.0.1:5175/?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
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
