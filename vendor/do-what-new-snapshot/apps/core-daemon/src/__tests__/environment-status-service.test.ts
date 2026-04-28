import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

import { createEnvironmentStatusService } from "../services/environment-status-service.js";

describe("environment status service", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("uses async default probes and worktree counting when commands succeed", async () => {
    execFileMock.mockImplementation(
      (
        command: string,
        args: readonly string[],
        options: { readonly encoding?: string; readonly stdio?: string },
        callback: (error: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        queueMicrotask(() => {
          if (
            command === "bash"
            && args[0] === "-lc"
            && args[1] === "command -v -- \"$1\" >/dev/null 2>&1"
            && args[2] === "bash"
            && args[3] === "git"
          ) {
            callback(null, "", "");
            return;
          }

          if (
            command === "bash"
            && args[0] === "-lc"
            && args[1] === "command -v -- \"$1\" >/dev/null 2>&1"
            && args[2] === "bash"
            && args[3] === "node"
          ) {
            callback(null, "", "");
            return;
          }

          if (command === "git" && args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
            expect(options).toEqual({ encoding: "utf8" });
            callback(null, "worktree /tmp/one\nworktree /tmp/two\n", "");
            return;
          }

          callback(new Error(`unexpected command: ${command} ${args.join(" ")}`));
        });
      }
    );

    const service = createEnvironmentStatusService({
      toolNames: ["git", "node"],
      getDatabasePath: () => "/tmp/do-what.db",
      getFilesDirectory: () => "/tmp/do-what-files"
    });

    await expect(service.getStatus()).resolves.toEqual({
      tools: {
        git: true,
        node: true
      },
      active_worktrees: 2,
      db_path: "/tmp/do-what.db",
      files_dir: "/tmp/do-what-files"
    });
  });

  it("falls back to false and zero when probe commands fail", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        _options: { readonly encoding?: string; readonly stdio?: string },
        callback: (error: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        queueMicrotask(() => {
          callback(new Error("boom"), "", "");
        });
      }
    );

    const service = createEnvironmentStatusService({
      toolNames: ["git", "node"],
      getDatabasePath: () => "/tmp/do-what.db",
      getFilesDirectory: () => "/tmp/do-what-files"
    });

    await expect(service.getStatus()).resolves.toEqual({
      tools: {
        git: false,
        node: false
      },
      active_worktrees: 0,
      db_path: "/tmp/do-what.db",
      files_dir: "/tmp/do-what-files"
    });
  });

  it("starts tool probes and worktree counting concurrently", async () => {
    const probeSignals = new Map<string, { resolve: (value: boolean) => void; promise: Promise<boolean> }>();
    const toolNames = ["git", "node"] as const;
    let activeWorktreesStarted = false;
    let resolveWorktrees!: (value: number) => void;
    const activeWorktreesPromise = new Promise<number>((resolve) => {
      resolveWorktrees = resolve;
    });

    for (const toolName of toolNames) {
      let resolve!: (value: boolean) => void;
      const promise = new Promise<boolean>((nextResolve) => {
        resolve = nextResolve;
      });
      probeSignals.set(toolName, { resolve, promise });
    }

    const service = createEnvironmentStatusService({
      toolNames,
      probeTool: (toolName) => probeSignals.get(toolName)?.promise ?? Promise.resolve(false),
      countActiveWorktrees: async () => {
        activeWorktreesStarted = true;
        return activeWorktreesPromise;
      },
      getDatabasePath: () => "/tmp/do-what.db",
      getFilesDirectory: () => "/tmp/do-what-files"
    });

    const statusPromise = service.getStatus();
    await Promise.resolve();

    expect(activeWorktreesStarted).toBe(true);

    probeSignals.get("git")?.resolve(true);
    probeSignals.get("node")?.resolve(false);
    resolveWorktrees(3);

    await expect(statusPromise).resolves.toEqual({
      tools: {
        git: true,
        node: false
      },
      active_worktrees: 3,
      db_path: "/tmp/do-what.db",
      files_dir: "/tmp/do-what-files"
    });
  });
});
