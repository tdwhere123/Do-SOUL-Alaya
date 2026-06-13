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
      "http://127.0.0.1:5174/?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&workspaceId=ws-1\n"
    );
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
      "http://127.0.0.1:5175/?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&workspaceId=ws-1"
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
    expect(stdoutChunks.join("")).toContain("&workspaceId=local_efcd2c3483725c97");
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
      expect(stdoutChunks.join("")).toContain("&workspaceId=ws-http");
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
    expect(stdoutOkChunks.join("")).toContain("&workspaceId=explicit-ws");

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
      expect(stdoutChunks.join("")).toContain("&workspaceId=explicit-ws");
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
