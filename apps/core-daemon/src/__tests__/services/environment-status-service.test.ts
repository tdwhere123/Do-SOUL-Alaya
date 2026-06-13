import type { ExecFileException, execFile as nodeExecFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;
type GitWorktreeMockState =
  | { readonly kind: "success"; readonly stdout: string }
  | { readonly kind: "failure"; readonly error: Error };

const childProcessMock = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  gitWorktreeState: { kind: "success", stdout: "" } as GitWorktreeMockState
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMock.execFileMock.mockImplementation(
    (
      command: string,
      args: readonly string[],
      options: Parameters<typeof nodeExecFile>[2],
      callback: ExecFileCallback
    ) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
        queueMicrotask(() => {
          const state = childProcessMock.gitWorktreeState;
          if (state.kind === "failure") {
            callback(state.error as ExecFileException, "", "");
            return;
          }

          callback(null, state.stdout, "");
        });
        return undefined;
      }

      return actual.execFile(command, [...args], options, callback);
    }
  );
  return {
    ...actual,
    execFile: childProcessMock.execFileMock
  };
});

import { createEnvironmentStatusService } from "../../services/environment-status-service.js";

describe("environment status service", () => {
  beforeEach(() => {
    childProcessMock.execFileMock.mockClear();
    childProcessMock.gitWorktreeState = { kind: "success", stdout: "" };
  });

  it("uses async default probes and worktree counting when commands succeed", async () => {
    childProcessMock.gitWorktreeState = {
      kind: "success",
      stdout: "worktree /tmp/one\nworktree /tmp/two\n"
    };

    const service = createEnvironmentStatusService({
      toolNames: ["git", "node"],
      getDatabasePath: () => "/tmp/alaya.db",
      getFilesDirectory: () => "/tmp/alaya-files"
    });

    await expect(service.getStatus()).resolves.toEqual({
      tools: {
        git: true,
        node: true
      },
      active_worktrees: 2,
      db_path: "/tmp/alaya.db",
      files_dir: "/tmp/alaya-files"
    });

    const gitWorktreeCall = childProcessMock.execFileMock.mock.calls.find(([command]) => command === "git");
    expect(gitWorktreeCall?.[2]).toMatchObject({
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true
    });
    expect(gitWorktreeCall?.[2]).toMatchObject({
      env: expect.not.objectContaining({
        ALAYA_ENV_STATUS_TEST_SECRET: expect.any(String)
      })
    });
    expect(childProcessMock.execFileMock).not.toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining(["-lc"]),
      expect.anything(),
      expect.anything()
    );
  });

  it("falls back to false and zero when probes and worktree counting fail", async () => {
    childProcessMock.gitWorktreeState = { kind: "failure", error: new Error("boom") };

    const service = createEnvironmentStatusService({
      toolNames: ["git", "node"],
      probeTool: async () => false,
      getDatabasePath: () => "/tmp/alaya.db",
      getFilesDirectory: () => "/tmp/alaya-files"
    });

    await expect(service.getStatus()).resolves.toEqual({
      tools: {
        git: false,
        node: false
      },
      active_worktrees: 0,
      db_path: "/tmp/alaya.db",
      files_dir: "/tmp/alaya-files"
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
      getDatabasePath: () => "/tmp/alaya.db",
      getFilesDirectory: () => "/tmp/alaya-files"
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
      db_path: "/tmp/alaya.db",
      files_dir: "/tmp/alaya-files"
    });
  });

  it("does not use a shell for default tool probes", async () => {
    process.env.ALAYA_ENV_STATUS_TEST_SECRET = "secret";
    try {
      const service = createEnvironmentStatusService({
        toolNames: ["definitely-not-a-real-alaya-tool;echo-owned"],
        getDatabasePath: () => "/tmp/alaya.db",
        getFilesDirectory: () => "/tmp/alaya-files"
      });

      await expect(service.getStatus()).resolves.toMatchObject({
        tools: {
          "definitely-not-a-real-alaya-tool;echo-owned": false
        }
      });
    } finally {
      delete process.env.ALAYA_ENV_STATUS_TEST_SECRET;
    }

    expect(childProcessMock.execFileMock).not.toHaveBeenCalledWith(
      "bash",
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });
});
