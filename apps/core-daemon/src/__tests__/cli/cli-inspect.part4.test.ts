import { EventEmitter } from "node:events";

import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  buildInspectorChildEnv,
  createInspectCommand,
  openCommandCandidates,
  openUrlWithSpawn,
  type BrowserOpenerChildProcess,
  type InspectorChildProcess
} from "../../cli/inspect.js";

import type { AlayaCliContext } from "../../cli/bridge.js";

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

function fakeDaemonServer() {
  return {
    hostname: "127.0.0.1",
    port: 5173,
    close: async () => {}
  };
}

function oneWorkspaceList() {
  return async () => [
    {
      workspace_id: "ws-1",
      name: "Sample",
      repo_path: "/tmp/sample",
      workspace_state: "active"
    }
  ];
}

interface TestDaemonResponse {
  readonly status?: number;
  readonly body: unknown;
}

function stubWorkspaceDaemonFetch(
  handler: (url: URL) => TestDaemonResponse
): {
  readonly url: string;
  readonly requests: string[];
  restore(): void;
} {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const requestUrl = input instanceof Request ? new URL(input.url) : new URL(String(input));
    requests.push(requestUrl.pathname);
    const response = handler(requestUrl);
    return Response.json(response.body, { status: response.status ?? 200 });
  });
  return {
    url: "http://daemon.local",
    requests,
    restore: () => {
      vi.stubGlobal("fetch", originalFetch);
    }
  };
}

describe("cli inspect", () => {

  it("accepts --workspace <id> and verifies it exists, rejecting unknown ids", async () => {
    const childOk = new FakeInspectorChild();
    const stdoutOk = new PassThrough();
    const stdoutOkChunks: string[] = [];
    stdoutOk.on("data", (chunk) => stdoutOkChunks.push(chunk.toString()));
    const okCommand = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector: () => childOk,
      getWorkspaceById: async (_url, id) => ({
        status: "ok",
        workspace: {
          workspace_id: id,
          name: "Explicit",
          repo_path: "/tmp/explicit",
          workspace_state: "active"
        }
      })
    });

    const okPromise = okCommand.handler(createContext({ stdout: stdoutOk }), {
      open: false,
      port: 5174,
      token: null,
      workspace: "explicit-ws"
    });
    setTimeout(() => childOk.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => childOk.emitExit(0, null), 10);
    const okResult = await okPromise;
    expect(okResult.exitCode).toBe(0);
    expect(stdoutOkChunks.join("")).toContain("?workspaceId=explicit-ws#token=");

    const stderrMissing = new PassThrough();
    const stderrMissingChunks: string[] = [];
    stderrMissing.on("data", (chunk) => stderrMissingChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const missingCommand = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector,
      getWorkspaceById: async () => ({ status: "not_found" })
    });

    const missingResult = await missingCommand.handler(createContext({ stderr: stderrMissing }), {
      open: false,
      port: 5174,
      token: null,
      workspace: "nope"
    });

    expect(missingResult.exitCode).toBe(64);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrMissingChunks.join("")).toContain('workspace "nope" not found');
  });

  it("verifies explicit --workspace through the daemon /workspaces/:id HTTP contract", async () => {
    const child = new FakeInspectorChild();
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const daemon = stubWorkspaceDaemonFetch((url) => {
      if (url.pathname === "/workspaces/explicit-ws") {
        return {
          body: {
            success: true,
            data: {
              workspace_id: "explicit-ws",
              name: "Explicit",
              repo_path: "/tmp/explicit",
              workspace_state: "active"
            }
          }
        };
      }
      return { status: 404, body: { success: false } };
    });
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      spawnInspector: () => {
        setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
        setTimeout(() => child.emitExit(0, null), 10);
        return child;
      }
    });

    try {
      const promise = command.handler(createContext({ env: { ALAYA_DAEMON_URL: daemon.url }, stdout }), {
        open: false,
        port: 5174,
        token: null,
        workspace: "explicit-ws"
      });
      const result = await promise;

      expect(result.exitCode).toBe(0);
      expect(daemon.requests).toEqual(["/workspaces/explicit-ws"]);
      expect(stdoutChunks.join("")).toContain("?workspaceId=explicit-ws#token=");
    } finally {
      daemon.restore();
    }
  });

  it("terminates the inspector child when the CLI receives SIGINT", async () => {
    const child = new FakeInspectorChild();
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "d".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector: () => child,
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(createContext(), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
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
