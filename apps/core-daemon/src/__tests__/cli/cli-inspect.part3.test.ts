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
      token: "c".repeat(64),
      workspace: null
    });

    expect(result.exitCode).toBe(64);
    expect(stderrChunks.join("")).toContain("ALAYA_INSPECTOR_ALLOW_FIXED_TOKEN=1");
  });

  it("injects workspaceId into the printed token URL when exactly one workspace is registered", async () => {
    const child = new FakeInspectorChild();
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector: () => child,
      listWorkspaces: async () => [
        {
          workspace_id: "local_efcd2c3483725c97",
          name: "Sample",
          repo_path: "/tmp/sample",
          workspace_state: "active"
        }
      ]
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
    expect(stdoutChunks.join("")).toContain("?workspaceId=local_efcd2c3483725c97#token=");
  });

  it("resolves the auto-selected workspace through the daemon /workspaces HTTP contract", async () => {
    const child = new FakeInspectorChild();
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const daemon = stubWorkspaceDaemonFetch((url) => {
      if (url.pathname === "/workspaces") {
        return {
          body: {
            success: true,
            data: [
              {
                workspace_id: "ws-http",
                name: "HTTP",
                repo_path: "/tmp/http",
                workspace_state: "active"
              }
            ]
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
        workspace: null
      });
      const result = await promise;

      expect(result.exitCode).toBe(0);
      expect(daemon.requests).toEqual(["/workspaces"]);
      expect(stdoutChunks.join("")).toContain("?workspaceId=ws-http#token=");
    } finally {
      daemon.restore();
    }
  });

  it("errors with remediation when no active workspace is registered", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector,
      listWorkspaces: async () => []
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(70);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("no active workspace registered");
    expect(stderrChunks.join("")).toContain("alaya install");
  });

  it("errors and lists candidates when multiple workspaces and no --workspace flag", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector,
      listWorkspaces: async () => [
        {
          workspace_id: "ws-alpha",
          name: "Alpha",
          repo_path: "/tmp/alpha",
          workspace_state: "active"
        },
        {
          workspace_id: "ws-beta",
          name: "Beta",
          repo_path: "/tmp/beta",
          workspace_state: "active"
        }
      ]
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(64);
    expect(spawnInspector).not.toHaveBeenCalled();
    const out = stderrChunks.join("");
    expect(out).toContain("multiple workspaces registered");
    expect(out).toContain("ws-alpha");
    expect(out).toContain("ws-beta");
    expect(out).toContain("--workspace");
  });

  it("auto-selects the workspace whose repo path matches the current directory", async () => {
    const child = new FakeInspectorChild();
    const stdout = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => child);
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector,
      listWorkspaces: async () => [
        {
          workspace_id: "ws-alpha",
          name: "Alpha",
          repo_path: "/tmp/alpha",
          workspace_state: "active"
        },
        {
          workspace_id: "ws-beta",
          name: "Beta",
          repo_path: "/tmp/beta",
          workspace_state: "active"
        }
      ]
    });

    const promise = command.handler(createContext({ cwd: "/tmp/beta", stdout, stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(spawnInspector).toHaveBeenCalledTimes(1);
    expect(stdoutChunks.join("")).toContain("workspaceId=ws-beta");
    expect(stderrChunks.join("")).toContain("using workspace ws-beta");
  });

  it("surfaces listWorkspaces failures as SOFTWARE exit with the daemon error", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector,
      listWorkspaces: async () => {
        throw new Error("daemon /workspaces returned HTTP 503");
      }
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(70);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("failed to list workspaces from daemon");
    expect(stderrChunks.join("")).toContain("HTTP 503");
  });

  it("filters non-active workspaces during auto-resolution", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "a".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector,
      listWorkspaces: async () => [
        {
          workspace_id: "ws-archived",
          name: "Archived",
          repo_path: "/tmp/archived",
          workspace_state: "archived"
        }
      ]
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(70);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("no active workspace registered");
  });
});
