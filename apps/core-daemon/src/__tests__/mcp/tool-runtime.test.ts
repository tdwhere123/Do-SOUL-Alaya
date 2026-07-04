import { chmod, copyFile, mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError } from "@do-soul/alaya-core";

import type {
  EventLogEntry,
  ToolExecutionRecord,
  ToolSpec
} from "@do-soul/alaya-protocol";

import { createExternalConversationToolExecutor } from "../../mcp/mcp-catalog.js";

import {
  executeConversationTool,
  handleConversationToolUse,
  registerConversationToolSpecs
} from "../../mcp/tool-runtime.js";

import {
  cleanupToolRuntimeTempDirs,
  createBuiltinToolExecutor,
  createDeferred,
  createRuntimeContext,
  createWorkspace,
  trackToolRuntimeTempDir
} from "./tool-runtime-shared-fixture.js";

function createRecordingConversationToolExecutor(toolSpec: ToolSpec): {
  readonly appendedEntries: EventLogEntry[];
  readonly executor: {
    execute(request: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly workspaceRoot: string;
      readonly affectedPathRoots?: readonly string[];
      readonly handler: (
        context: { readonly writableRoots: readonly string[] },
        rawInput?: unknown
      ) => Promise< unknown>;
    }): Promise<{ readonly result: unknown }>;
  };
  readonly insertedRecords: ToolExecutionRecord[];
} {
  const appendedEntries: EventLogEntry[] = [];
  const insertedRecords: ToolExecutionRecord[] = [];

  return {
    appendedEntries,
    insertedRecords,
    executor: {
      execute: async (request) => {
        expect(request.toolId).toBe(toolSpec.tool_id);
        const result = await request.handler(
          { writableRoots: [request.workspaceRoot] },
          request.rawInput
        );
        const affectedPaths = extractAffectedPaths(request.rawInput, request.affectedPathRoots);
        insertedRecords.push({
          tool_call_id: "exec-affected-path",
          tool_id: request.toolId,
          run_id: "run-1",
          workspace_id: "workspace-1",
          status: "completed",
          input_json: request.rawInput as Record<string, unknown>,
          result_json: result as Record<string, unknown>,
          started_at: "2026-04-20T00:00:00.000Z",
          completed_at: "2026-04-20T00:00:01.000Z",
          affected_paths: affectedPaths
        } as unknown as ToolExecutionRecord);
        appendedEntries.push({
          event_id: `event-${appendedEntries.length + 1}`,
          event_type: "tool_call.completed",
          entity_type: "tool_call",
          entity_id: "exec-affected-path",
          workspace_id: "workspace-1",
          run_id: "run-1",
          caused_by: "tool-runtime-test",
          revision: 1,
          created_at: "2026-04-20T00:00:01.000Z",
          payload_json: {
            toolCallId: "exec-affected-path",
            statusKind: "success",
            ...(affectedPaths === undefined ? {} : { affected_paths: affectedPaths })
          }
        });
        return { result };
      }
    }
  };
}

function extractAffectedPaths(
  rawInput: unknown,
  affectedPathRoots: readonly string[] | undefined
): readonly string[] | undefined {
  if (affectedPathRoots === undefined || affectedPathRoots.length === 0) {
    return undefined;
  }

  const pathInput = (rawInput as { readonly path?: unknown }).path;
  if (typeof pathInput !== "string") {
    return undefined;
  }

  const resolvedPath = path.resolve(pathInput);
  for (const root of affectedPathRoots) {
    const resolvedRoot = path.resolve(root);
    const relativePath = path.relative(resolvedRoot, resolvedPath);
    if (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return [relativePath.split(path.sep).join("/")];
    }
  }

  return undefined;
}

function createToolSpec(toolId: ToolSpec["tool_id"]): ToolSpec {
  return {
    tool_id: toolId,
    category: toolId === "tools.exec_shell" ? "exec" : "write",
    description: `Spec for ${toolId}`,
    scope_guard: toolId === "tools.exec_shell" ? "project" : "workspace",
    read_only: false,
    destructive: toolId === "tools.exec_shell",
    concurrency_safe: false,
    interrupt_behavior: toolId === "tools.exec_shell" ? "abort" : "wait",
    requires_confirmation: toolId === "tools.exec_shell",
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: false
  };
}

afterEach(cleanupToolRuntimeTempDirs);

describe("tool-runtime relative path handling", () => {

  it("reads a relative tools.read_file path from the workspace root through the live handler contract", async () => {
    const workspaceDir = await createWorkspace();
    await writeFile(path.join(workspaceDir, "README.md"), "workspace readme", "utf8");

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-1",
        name: "tools.read_file",
        input: {
          path: "README.md"
        }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async (request) => ({
          result: await request.handler({ writableRoots: [request.workspaceRoot] }),
          executionRecord: {
            execution_id: "exec-1",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "fast-path://skipped",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-16T00:00:00.000Z",
            ended_at: "2026-04-16T00:00:01.000Z",
            result_summary: "ok",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: createBuiltinToolExecutor(["tools.read_file"])
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-1",
      content: JSON.stringify({
        ok: true,
        content: "workspace readme",
        bytesRead: 16
      })
    });
  });

  it("executes tools.exec_shell through argv without shell expansion and without leaking ambient secrets", async () => {
    const workspaceDir = await createWorkspace();
    const nodeExecutable = await createContainedNodeExecutable(workspaceDir);
    process.env.ALAYA_EXEC_SHELL_TEST_SECRET = "sk-env-leak";
    try {
      const result = await executeConversationTool(
        "tools.exec_shell",
        {
          command: nodeExecutable,
          args: [
            "-e",
            "require('node:fs').writeFileSync(1, `${process.argv[1]}|${process.env.ALAYA_EXEC_SHELL_TEST_SECRET ?? 'missing'}`)",
            "$(echo owned)"
          ]
        },
        [workspaceDir]
      );

      expect(result).toEqual({
        ok: true,
        exitCode: 0,
        stdout: "$(echo owned)|missing",
        stderr: ""
      });
    } finally {
      delete process.env.ALAYA_EXEC_SHELL_TEST_SECRET;
    }
  });

  it("denies tools.exec_shell PATH commands before execFile", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      executeConversationTool(
        "tools.exec_shell",
        {
          command: "sh",
          args: ["-c", "printf escaped"]
        },
        [workspaceDir]
      )
    ).resolves.toEqual({
      ok: false,
      code: "ACCESS_DENIED",
      message: "Command must be a real non-symlink executable inside a writable root."
    });
  });

  it("denies tools.exec_shell commands that escape through intermediate symlinks", async () => {
    const workspaceDir = await createWorkspace();
    const binLink = path.join(workspaceDir, "bin-link");
    await symlink(path.dirname(process.execPath), binLink, "dir");

    await expect(
      executeConversationTool(
        "tools.exec_shell",
        {
          command: path.join(binLink, path.basename(process.execPath)),
          args: ["-e", "require('node:fs').writeFileSync(1, 'escaped')"]
        },
        [workspaceDir]
      )
    ).resolves.toEqual({
      ok: false,
      code: "ACCESS_DENIED",
      message: "Command must be a real non-symlink executable inside a writable root."
    });
  });

  it("pins the executable inode when the workspace path is swapped before spawn", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspaceDir = await createWorkspace();
    const nodeExecutable = await createContainedNodeExecutable(workspaceDir);
    const { open } = await import("node:fs/promises");
    const handle = await open(nodeExecutable, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await unlink(nodeExecutable);
      await symlink(process.execPath, nodeExecutable);
      const execPath = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : `/dev/fd/${handle.fd}`;
      const result = await promisify(execFile)(execPath, ["-e", "process.stdout.write('pinned')"], {
        cwd: workspaceDir
      });
      expect(result.stdout).toBe("pinned");
    } finally {
      await handle.close();
    }
  });

  it("maps tools.exec_shell nonzero exits and timeouts to structured results", async () => {
    const workspaceDir = await createWorkspace();
    const nodeExecutable = await createContainedNodeExecutable(workspaceDir);

    await expect(
      executeConversationTool(
        "tools.exec_shell",
        {
          command: nodeExecutable,
          args: ["-e", "require('node:fs').writeFileSync(2, 'bad'); process.exit(7)"]
        },
        [workspaceDir]
      )
    ).resolves.toEqual({
      ok: true,
      exitCode: 7,
      stdout: "",
      stderr: "bad"
    });

    await expect(
      executeConversationTool(
        "tools.exec_shell",
        {
          command: nodeExecutable,
          args: ["-e", "setTimeout(() => {}, 1000)"],
          timeoutMs: 1
        },
        [workspaceDir]
      )
    ).resolves.toEqual({
      ok: false,
      code: "TIMEOUT",
      message: "Command timed out after 1ms."
    });
  });

  it("forwards repo-bound affectedPathRoots separately from the writable workspace root", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(repoDir, { recursive: true });
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    const execute = vi.fn(async () => ({
      result: { ok: true },
      executionRecord: {
        execution_id: "exec-write-bound",
        tool_id: "tools.write_file",
        requested_by: "principal",
        requesting_run_id: "run-1",
        governance_decision_ref: "governance://allow",
        permission_result: "allow",
        executed: true,
        started_at: "2026-04-20T00:00:00.000Z",
        ended_at: "2026-04-20T00:00:01.000Z",
        result_summary: "ok",
        rollback_status: "none"
      },
      permissionResult: "allow"
    }));

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-write-bound",
        name: "tools.write_file",
        input: {
          path: "repo/src/index.ts",
          content: "export const value = 1;\n"
        }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir,
          repo_path: repoDir
        })
      },
      {
        execute
      },
      {
        gitBindingValidation: {
          currentWorkingDirectory: workspaceDir
        },
        externalToolExecutor: createBuiltinToolExecutor(["tools.write_file"])
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-write-bound",
      content: JSON.stringify({ ok: true })
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: workspaceDir,
        affectedPathRoots: [repoDir]
      })
    );
  });

  it("drops affectedPathRoots when a persisted repo binding has drifted invalid", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    const outsideRoot = trackToolRuntimeTempDir(
      await mkdtemp(path.join(tmpdir(), "dw-tool-runtime-gitdir-"))
    );
    const outsideGitDir = path.join(outsideRoot, "detached-gitdir");

    await mkdir(repoDir, { recursive: true });
    await mkdir(outsideGitDir, { recursive: true });
    await writeFile(path.join(repoDir, ".git"), `gitdir: ${outsideGitDir}\n`, "utf8");

    const execute = vi.fn(async () => ({
      result: { ok: true },
      executionRecord: {
        execution_id: "exec-write-invalid-binding",
        tool_id: "tools.write_file",
        requested_by: "principal",
        requesting_run_id: "run-1",
        governance_decision_ref: "governance://allow",
        permission_result: "allow",
        executed: true,
        started_at: "2026-04-20T00:00:00.000Z",
        ended_at: "2026-04-20T00:00:01.000Z",
        result_summary: "ok",
        rollback_status: "none"
      },
      permissionResult: "allow"
    }));

    await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-write-invalid-binding",
        name: "tools.write_file",
        input: {
          path: "repo/src/index.ts",
          content: "export const value = 1;\n"
        }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir,
          repo_path: repoDir
        })
      },
      {
        execute
      },
      {
        gitBindingValidation: {
          currentWorkingDirectory: workspaceDir
        },
        externalToolExecutor: createBuiltinToolExecutor(["tools.write_file"])
      }
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: workspaceDir,
        affectedPathRoots: undefined
      })
    );
  });
});

async function createContainedNodeExecutable(workspaceDir: string): Promise<string> {
  const binDir = path.join(workspaceDir, ".tool-bin");
  await mkdir(binDir, { recursive: true });
  const nodeExecutable = path.join(binDir, path.basename(process.execPath));
  await copyFile(process.execPath, nodeExecutable);
  await chmod(nodeExecutable, 0o755);
  return nodeExecutable;
}
