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

  it("prints a loopback token URL after the inspector child is ready", async () => {
    const child = new FakeInspectorChild();
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector: () => child,
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(createContext({ stdout }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(stdoutChunks.join("")).toBe(
      "http://127.0.0.1:5174/?workspaceId=ws-1#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
    );
  });

  it("surfaces inspector stderr when the child exits before ready", async () => {
    const child = new FakeInspectorChild();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector: () => child,
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });
    setTimeout(() => child.stderr.write("Error: Cannot find module '/missing/server.js'\n"), 0);
    setTimeout(() => child.emitExit(1, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(70);
    const stderrText = stderrChunks.join("");
    expect(stderrText).toContain("inspector exited before ready: 1");
    expect(stderrText).toContain("Cannot find module '/missing/server.js'");
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
      token: null,
      workspace: null
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
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector: (input) => {
        spawned.push(input);
        return child;
      },
      openUrl: async (url) => {
        opened.push(url);
        throw new Error("missing helper");
      },
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(createContext({ env: { ALAYA_INSPECTOR_ALLOW_FIXED_TOKEN: "1" }, stderr }), {
      open: true,
      port: 5175,
      token: "b".repeat(64),
      workspace: null
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
    expect(opened).toEqual([
      "http://127.0.0.1:5175/?workspaceId=ws-1#token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ]);
  });

  it("starts a loopback daemon and passes its URL to the inspector child", async () => {
    const child = new FakeInspectorChild();
    const daemonStarts: unknown[] = [];
    const daemonCloses: string[] = [];
    const spawned: unknown[] = [];
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "e".repeat(64),
      startDaemonServer: async (options) => {
        daemonStarts.push(options);
        return {
          hostname: "127.0.0.1",
          port: 5173,
          close: async () => {
            daemonCloses.push("closed");
          }
        };
      },
      spawnInspector: (input) => {
        spawned.push(input);
        return child;
      },
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(createContext(), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(daemonStarts).toEqual([
      { hostname: "127.0.0.1", port: 5173, allowEphemeralRequestToken: true }
    ]);
    expect(spawned).toMatchObject([
      {
        env: {
          ALAYA_DAEMON_URL: "http://127.0.0.1:5173"
        }
      }
    ]);
    expect(daemonCloses).toEqual(["closed"]);
  });

  it("passes the managed daemon request token to the inspector child", async () => {
    const child = new FakeInspectorChild();
    const spawned: unknown[] = [];
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "e".repeat(64),
      getRequestToken: () => " managed-daemon-request-token ",
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector: (input) => {
        spawned.push(input);
        return child;
      },
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(createContext(), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(spawned).toMatchObject([
      {
        env: {
          ALAYA_DAEMON_URL: "http://127.0.0.1:5173",
          ALAYA_REQUEST_TOKEN: "managed-daemon-request-token"
        }
      }
    ]);
  });

  it("does not forward an inherited request token for an externally configured daemon", async () => {
    const child = new FakeInspectorChild();
    const spawned: unknown[] = [];
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "e".repeat(64),
      getRequestToken: () => "wrong-daemon-token",
      spawnInspector: (input) => {
        spawned.push(input);
        return child;
      },
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(
      createContext({
        env: {
          ALAYA_DAEMON_URL: "http://external-daemon.local",
          ALAYA_REQUEST_TOKEN: "stale-parent-token"
        }
      }),
      {
        open: false,
        port: 5174,
        token: null,
        workspace: null
      }
    );
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(spawned).toMatchObject([
      {
        env: {
          ALAYA_DAEMON_URL: "http://external-daemon.local"
        }
      }
    ]);
    expect((spawned[0] as { env?: Record<string, unknown> }).env?.ALAYA_REQUEST_TOKEN)
      .toBeUndefined();
  });

  it("passes the explicit external daemon request token to the inspector child", async () => {
    const child = new FakeInspectorChild();
    const spawned: unknown[] = [];
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "e".repeat(64),
      getRequestToken: () => "wrong-managed-daemon-token",
      spawnInspector: (input) => {
        spawned.push(input);
        return child;
      },
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(
      createContext({
        env: {
          ALAYA_DAEMON_URL: "http://external-daemon.local",
          ALAYA_REQUEST_TOKEN: "stale-parent-token",
          ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN: " explicit-external-token "
        }
      }),
      {
        open: false,
        port: 5174,
        token: null,
        workspace: null
      }
    );
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(spawned).toMatchObject([
      {
        env: {
          ALAYA_DAEMON_URL: "http://external-daemon.local",
          ALAYA_REQUEST_TOKEN: "explicit-external-token"
        }
      }
    ]);
  });
});
