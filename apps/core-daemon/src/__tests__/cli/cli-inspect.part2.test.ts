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

  it("forwards the explicit external daemon request token when resolving workspaces", async () => {
    const child = new FakeInspectorChild();
    const seenRequestTokens: Array<string | undefined> = [];
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "e".repeat(64),
      spawnInspector: () => child,
      listWorkspaces: async (_daemonUrl, auth) => {
        seenRequestTokens.push(auth?.requestToken);
        return [
          {
            workspace_id: "ws-auth",
            name: "Auth",
            repo_path: "/tmp/auth",
            workspace_state: "active"
          }
        ];
      }
    });

    const promise = command.handler(
      createContext({
        env: {
          ALAYA_DAEMON_URL: "http://external-daemon.local",
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
    expect(seenRequestTokens).toEqual(["explicit-external-token"]);
  });

  it("fails instead of starting a standalone inspector when no daemon is managed", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      generateToken: () => "f".repeat(64),
      spawnInspector
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(70);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("requires a managed daemon");
  });

  it("binds to an existing daemon only after the required capability probe passes", async () => {
    const child = new FakeInspectorChild();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const startDaemonServer = vi.fn(async () => fakeDaemonServer());
    const spawned: unknown[] = [];
    const command = createInspectCommand({
      checkPortAvailable: async (port) => port !== 5173,
      generateToken: () => "1".repeat(64),
      probeDaemon: async () => ({ status: "compatible" }),
      startDaemonServer,
      spawnInspector: (input) => {
        spawned.push(input);
        return child;
      },
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emitExit(0, null), 10);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(startDaemonServer).not.toHaveBeenCalled();
    expect(spawned).toMatchObject([
      {
        env: {
          ALAYA_DAEMON_URL: "http://127.0.0.1:5173"
        }
      }
    ]);
    expect(stderrChunks.join("")).toContain("using existing daemon");
  });

  it("refuses to bind Inspector to a stale Alaya daemon without garden-compute config", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async (port) => port !== 5173,
      generateToken: () => "3".repeat(64),
      probeDaemon: async () => ({ status: "missing_capability", detail: "HTTP 404" }),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(70);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("stale/incompatible daemon on 127.0.0.1:5173");
    expect(stderrChunks.join("")).toContain("/config/runtime/garden-compute");
  });

  it("refuses to bind Inspector to an occupied daemon when request-token auth is required", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async (port) => port !== 5173,
      generateToken: () => "4".repeat(64),
      probeDaemon: async () => ({ status: "auth_required", detail: "HTTP 403" }),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(70);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("requires request-token auth");
    expect(stderrChunks.join("")).toContain("ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN");
  });

  it("treats a protected daemon 403 as auth-required even when an external token was supplied", async () => {
    const originalFetch = globalThis.fetch;
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(null, { status: 200 });
        }
        expect(new Headers(init?.headers).get("x-request-token")).toBe("wrong-token");
        return new Response(null, { status: 403 });
      })
    );
    const command = createInspectCommand({
      checkPortAvailable: async (port) => port !== 5173,
      generateToken: () => "4".repeat(64),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector
    });

    try {
      const result = await command.handler(
        createContext({
          env: { ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN: "wrong-token" },
          stderr
        }),
        {
          open: false,
          port: 5174,
          token: null,
          workspace: null
        }
      );

      expect(result.exitCode).toBe(70);
      expect(spawnInspector).not.toHaveBeenCalled();
      expect(stderrChunks.join("")).toContain("requires request-token auth");
      expect(stderrChunks.join("")).not.toContain("stale/incompatible daemon");
    } finally {
      vi.unstubAllGlobals();
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses to bind Inspector to an occupied non-Alaya daemon port", async () => {
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
    const spawnInspector = vi.fn(() => new FakeInspectorChild());
    const command = createInspectCommand({
      checkPortAvailable: async (port) => port !== 5173,
      generateToken: () => "2".repeat(64),
      probeDaemon: async () => ({ status: "unavailable" }),
      startDaemonServer: async () => fakeDaemonServer(),
      spawnInspector
    });

    const result = await command.handler(createContext({ stderr }), {
      open: false,
      port: 5174,
      token: null,
      workspace: null
    });

    expect(result.exitCode).toBe(70);
    expect(spawnInspector).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("does not answer as Alaya");
  });

  it("prefers Windows browser bridge candidates when running in WSL", () => {
    expect(
      openCommandCandidates("http://127.0.0.1:5174/?workspaceId=ws-1#token=t", {
        os: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" }
      })
    ).toEqual([
      ["wslview", ["http://127.0.0.1:5174/?workspaceId=ws-1#token=t"]],
      ["cmd.exe", ["/c", "start", "", "http://127.0.0.1:5174/?workspaceId=ws-1#token=t"]],
      ["xdg-open", ["http://127.0.0.1:5174/?workspaceId=ws-1#token=t"]]
    ]);
  });

  it("falls back to the next browser opener when the first command is missing", async () => {
    const attempts: string[] = [];

    await openUrlWithSpawn("http://127.0.0.1:5174/?workspaceId=ws-1#token=t", {
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
      workspaceId: "ws-1",
      inspectorEntryPath: "/tmp/inspector.js",
      env: {
        ALAYA_DAEMON_URL: "http://127.0.0.1:3000",
        ALAYA_REQUEST_TOKEN: "daemon-request-token",
        ALAYA_OPENAI_SECRET_REF: "file:/tmp/secret",
        OPENAI_API_KEY: "sk-secret",
        PATH: "/usr/bin"
      }
    });

    expect(env).toEqual({
      ALAYA_DAEMON_URL: "http://127.0.0.1:3000",
      ALAYA_REQUEST_TOKEN: "daemon-request-token",
      ALAYA_INSPECTOR_TOKEN: "b".repeat(64),
      ALAYA_INSPECTOR_PORT: "5175",
      ALAYA_INSPECTOR_WORKSPACE_ID: "ws-1"
    });
  });
});
