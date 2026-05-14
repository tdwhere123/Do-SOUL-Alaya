import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import type {
  ConversationRuntimeContext,
  EventLogEntry,
  ToolExecutionRecord,
  ToolSpec
} from "@do-soul/alaya-protocol";
import { createExternalConversationToolExecutor } from "../mcp-catalog.js";
import {
  executeConversationTool,
  executeConversationToolOrThrow,
  handleConversationToolUse,
  registerConversationToolSpecs
} from "../tool-runtime.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
});

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
    process.env.ALAYA_EXEC_SHELL_TEST_SECRET = "sk-env-leak";
    try {
      const result = await executeConversationTool(
        "tools.exec_shell",
        {
          command: process.execPath,
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

  it("maps tools.exec_shell nonzero exits and timeouts to structured results", async () => {
    const workspaceDir = await createWorkspace();

    await expect(
      executeConversationTool(
        "tools.exec_shell",
        {
          command: process.execPath,
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
          command: process.execPath,
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
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "dw-tool-runtime-gitdir-"));
    const outsideGitDir = path.join(outsideRoot, "detached-gitdir");
    tempDirs.add(outsideRoot);

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

  it("extracts repo-relative affected_paths for builtin write tools", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const { appendedEntries, executor, insertedRecords } = createRecordingConversationToolExecutor(
      createToolSpec("tools.write_file")
    );

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-write-affected",
        name: "tools.write_file",
        input: {
          path: path.join(repoDir, "src/index.ts"),
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
      executor,
      {
        gitBindingValidation: {
          currentWorkingDirectory: workspaceDir
        },
        externalToolExecutor: createBuiltinToolExecutor(["tools.write_file"])
      }
    );

    expect(JSON.parse(result.content)).toMatchObject({ ok: true });
    expect(insertedRecords.at(-1)?.affected_paths).toEqual(["src/index.ts"]);
    expect(
      appendedEntries.find((entry) => entry.event_type === "tool_call.completed")?.payload_json
    ).toMatchObject({
      toolCallId: "exec-affected-path",
      statusKind: "success",
      affected_paths: ["src/index.ts"]
    });
  });

  it("extracts repo-relative affected_paths for external filesystem write tools", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    const { appendedEntries, executor, insertedRecords } = createRecordingConversationToolExecutor(
      createToolSpec("mcp__filesystem__write_file")
    );

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-mcp-write-affected",
        name: "mcp__filesystem__write_file",
        input: {
          path: path.join(repoDir, "docs/notes.md"),
          content: "hello\n"
        }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir,
          repo_path: repoDir
        })
      },
      executor,
      {
        gitBindingValidation: {
          currentWorkingDirectory: workspaceDir
        },
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__write_file",
          executeTool: async () => ({
            content: [{ type: "text", text: "ok" }]
          })
        }
      }
    );

    expect(JSON.parse(result.content)).toEqual({
      content: [{ type: "text", text: "ok" }]
    });
    expect(insertedRecords.at(-1)?.affected_paths).toEqual(["docs/notes.md"]);
    expect(
      appendedEntries.find((entry) => entry.event_type === "tool_call.completed")?.payload_json
    ).toMatchObject({
      toolCallId: "exec-affected-path",
      statusKind: "success",
      affected_paths: ["docs/notes.md"]
    });
  });

  it("omits affected_paths when a write tool path cannot be normalized against repo roots", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    const { appendedEntries, executor, insertedRecords } = createRecordingConversationToolExecutor(
      createToolSpec("mcp__filesystem__write_file")
    );

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-mcp-write-outside-repo",
        name: "mcp__filesystem__write_file",
        input: {
          path: path.join(workspaceDir, "outside-repo.txt"),
          content: "hello\n"
        }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir,
          repo_path: repoDir
        })
      },
      executor,
      {
        gitBindingValidation: {
          currentWorkingDirectory: workspaceDir
        },
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__write_file",
          executeTool: async () => ({
            content: [{ type: "text", text: "ok" }]
          })
        }
      }
    );

    expect(JSON.parse(result.content)).toEqual({
      content: [{ type: "text", text: "ok" }]
    });
    expect(insertedRecords.at(-1)?.affected_paths).toBeUndefined();
    expect(
      appendedEntries.find((entry) => entry.event_type === "tool_call.completed")?.payload_json
    ).not.toHaveProperty("affected_paths");
  });

  it("routes dynamically registered external tools through the governed executor", async () => {
    const workspaceDir = await createWorkspace();

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-1",
        name: "mcp__filesystem__read_file",
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
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-1",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "ok",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__read_file",
          executeTool: async ({ toolId, rawInput, writableRoots }) => ({
            ok: true,
            tool: toolId,
            input: rawInput,
            writableRoots
          })
        }
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-1",
      content: JSON.stringify({
        ok: true,
        tool: "mcp__filesystem__read_file",
        input: { path: "README.md" },
        writableRoots: [workspaceDir]
      })
    });
  });

  it("routes builtin tools through the registered tool executor when the descriptor is present", async () => {
    const workspaceDir = await createWorkspace();
    const executeTool = vi.fn(async ({ toolId, rawInput, writableRoots }) => ({
      ok: true,
      tool: toolId,
      input: rawInput,
      writableRoots
    }));

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-builtin-registered",
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
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-builtin-registered",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "ok",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "tools.read_file",
          executeTool
        }
      }
    );

    expect(executeTool).toHaveBeenCalledWith({
      toolId: "tools.read_file",
      rawInput: {
        path: "README.md"
      },
      runtimeContext: createRuntimeContext(),
      writableRoots: [workspaceDir]
    });
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-builtin-registered",
      content: JSON.stringify({
        ok: true,
        tool: "tools.read_file",
        input: { path: "README.md" },
        writableRoots: [workspaceDir]
      })
    });
  });

  it("does not execute builtin tools when daemon-owned authority does not expose them", async () => {
    const workspaceDir = await createWorkspace();
    const executeTool = vi.fn(async () => ({
      ok: true,
      tool: "tools.read_file"
    }));

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-builtin-missing-authority",
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
        execute: async () => {
          throw new Error("must not execute missing builtin tool");
        }
      },
      {
        externalToolExecutor: {
          hasTool: () => false,
          refreshTools: vi.fn(async () => undefined),
          executeTool
        }
      }
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-builtin-missing-authority",
      content: JSON.stringify({ error: "Unsupported tool: tools.read_file" }),
      is_error: true
    });
  });

  it("rejects unknown dynamic tools when no external executor binding exists", async () => {
    const workspaceDir = await createWorkspace();

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-unsupported",
        name: "mcp__filesystem__unsupported",
        input: {}
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async () => {
          throw new Error("must not execute unsupported dynamic tool");
        }
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-unsupported",
      content: JSON.stringify({ error: "Unsupported tool: mcp__filesystem__unsupported" }),
      is_error: true
    });
  });

  it("sanitizes raw external runtime failures before returning them to the model", async () => {
    const workspaceDir = await createWorkspace();

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-error",
        name: "mcp__filesystem__read_file",
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
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-error",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "error",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__read_file",
          executeTool: async () => {
            throw new Error("provider returned 502 from https://internal.example/v1");
          }
        }
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-error",
      content: JSON.stringify({ error: "MCP tool execution failed." }),
      is_error: true
    });
  });

  it("sanitizes structured external runtime failures before returning them to the model", async () => {
    const workspaceDir = await createWorkspace();

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-structured-error",
        name: "mcp__filesystem__read_file",
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
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-structured-error",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "error",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__read_file",
          executeTool: async () => ({
            ok: false,
            code: "MCP_TOOL_ERROR",
            message: "permission denied by https://internal.example/v1",
            content: [{ type: "text", text: "secret provider trace" }],
            structuredContent: {
              provider: "internal.example"
            }
          })
        }
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-structured-error",
      content: JSON.stringify({
        ok: false,
        code: "MCP_TOOL_ERROR",
        message: "MCP tool execution failed."
      }),
      is_error: true
    });
  });

  it("sanitizes structured external validation failures before returning them to the model", async () => {
    const workspaceDir = await createWorkspace();

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-structured-validation",
        name: "mcp__filesystem__read_file",
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
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-structured-validation",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "error",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__read_file",
          executeTool: async () => ({
            ok: false,
            code: "MCP_TOOL_VALIDATION",
            message: "raw schema detail",
            structuredContent: {
              debug: "leak"
            }
          })
        }
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-structured-validation",
      content: JSON.stringify({
        ok: false,
        code: "MCP_TOOL_VALIDATION",
        message: "Invalid MCP tool payload."
      }),
      is_error: true
    });
  });

  it("sanitizes structured external failures thrown from the governed executor catch path", async () => {
    const workspaceDir = await createWorkspace();
    await mkdir(path.join(workspaceDir, "locked"), { recursive: true });

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-structured-catch",
        name: "mcp__filesystem__read_file",
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
        execute: async () => {
          await executeConversationToolOrThrow(
            "tools.write_file",
            {
              path: path.join(workspaceDir, "locked"),
              content: "updated"
            },
            [workspaceDir]
          );

          throw new Error("unreachable");
        }
      },
      {
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__read_file",
          executeTool: async () => ({
            ok: true
          })
        }
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-structured-catch",
      content: JSON.stringify({
        ok: false,
        code: "WRITE_ERROR",
        message: "MCP tool execution failed."
      }),
      is_error: true
    });
  });

  it("keeps builtin structured tool failures unchanged", async () => {
    const workspaceDir = await createWorkspace();
    await mkdir(path.join(workspaceDir, "locked"), { recursive: true });

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-builtin-structured-error",
        name: "tools.write_file",
        input: {
          path: "locked",
          content: "updated"
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
            execution_id: "exec-builtin-structured-error",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "error",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: createBuiltinToolExecutor(["tools.write_file"])
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-builtin-structured-error",
      content: JSON.stringify({
        ok: false,
        code: "WRITE_ERROR",
        message: `Path is not a regular file: ${path.join(workspaceDir, "locked")}`
      }),
      is_error: true
    });
  });

  it("sanitizes external validation failures before returning them to the model", async () => {
    const workspaceDir = await createWorkspace();

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-validation",
        name: "mcp__filesystem__read_file",
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
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-validation",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "error",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor: {
          hasTool: (toolId: string) => toolId === "mcp__filesystem__read_file",
          executeTool: async () => {
            throw new CoreError("VALIDATION", "tool_id must not be empty");
          }
        }
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-validation",
      content: JSON.stringify({ error: "Invalid MCP tool payload." }),
      is_error: true
    });
  });

  it("awaits one external tool refresh before executing newly registered tools", async () => {
    const workspaceDir = await createWorkspace();
    let enrolled = false;
    const refreshGate = createDeferred<void>();
    const refreshTools = vi.fn(async () => {
      await refreshGate.promise;
      enrolled = true;
    });
    const executeTool = vi.fn(async ({ toolId, rawInput, writableRoots }: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly writableRoots: readonly string[];
    }) => ({
      ok: true,
      tool: toolId,
      input: rawInput,
      writableRoots
    }));

    const externalToolExecutor = createExternalConversationToolExecutor({
      catalog: {
        refresh: async () => undefined,
        servers: [],
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        listServerTools: async () => [],
        hasTool: () => enrolled,
        executeTool: executeTool
      },
      now: () => 0,
      refreshTools,
      refreshTtlMs: 1_000
    });

    const runtimeContext = createRuntimeContext();
    const firstResultPromise = handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-refresh",
        name: "mcp__filesystem__search_files",
        input: {
          pattern: "TODO"
        }
      },
      runtimeContext,
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async (request) => ({
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-refresh",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "ok",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor
      }
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(refreshTools).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();

    refreshGate.resolve();
    const firstResult = await firstResultPromise;

    expect(firstResult).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-refresh",
      content: JSON.stringify({
        ok: true,
        tool: "mcp__filesystem__search_files",
        input: { pattern: "TODO" },
        writableRoots: [workspaceDir]
      })
    });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith({
      toolId: "mcp__filesystem__search_files",
      rawInput: { pattern: "TODO" },
      runtimeContext,
      writableRoots: [workspaceDir]
    });

    const secondResult = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-ext-refresh",
        name: "mcp__filesystem__search_files",
        input: {
          pattern: "TODO"
        }
      },
      runtimeContext,
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      {
        execute: async (request) => ({
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput),
          executionRecord: {
            execution_id: "exec-ext-refresh",
            tool_id: request.toolId,
            requested_by: "principal",
            requesting_run_id: request.runtimeContext.run_id,
            governance_decision_ref: "governance://allow",
            permission_result: "allow",
            executed: true,
            started_at: "2026-04-20T00:00:00.000Z",
            ended_at: "2026-04-20T00:00:01.000Z",
            result_summary: "ok",
            rollback_status: "none"
          },
          permissionResult: "allow"
        })
      },
      {
        externalToolExecutor
      }
    );

    expect(secondResult).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-ext-refresh",
      content: JSON.stringify({
        ok: true,
        tool: "mcp__filesystem__search_files",
        input: { pattern: "TODO" },
        writableRoots: [workspaceDir]
      })
    });
    expect(refreshTools).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it("awaits refresh completion and coalesces refreshes within the ttl window", async () => {
    let nowMs = 0;
    const refreshGate = createDeferred<void>();
    const refreshTools = vi.fn(async () => {
      await refreshGate.promise;
    });

    const externalToolExecutor = createExternalConversationToolExecutor({
      catalog: {
        refresh: async () => undefined,
        servers: [],
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        listServerTools: async () => [],
        hasTool: () => false,
        executeTool: async () => ({ ok: true })
      },
      now: () => nowMs,
      refreshTools,
      refreshTtlMs: 1_000
    });

    let firstRefreshSettled = false;
    const firstRefreshPromise = externalToolExecutor.refreshTools?.().then(() => {
      firstRefreshSettled = true;
    });
    await Promise.resolve();

    expect(firstRefreshSettled).toBe(false);
    expect(refreshTools).toHaveBeenCalledTimes(1);

    nowMs = 500;
    const secondRefreshPromise = externalToolExecutor.refreshTools?.();
    const thirdRefreshPromise = externalToolExecutor.refreshTools?.();
    await Promise.resolve();

    expect(refreshTools).toHaveBeenCalledTimes(1);

    refreshGate.resolve();
    await firstRefreshPromise;
    await secondRefreshPromise;
    await thirdRefreshPromise;
    expect(firstRefreshSettled).toBe(true);

    nowMs = 1_500;
    await externalToolExecutor.refreshTools?.();

    expect(refreshTools).toHaveBeenCalledTimes(2);
  });

  it("retries refreshes immediately after a failed refresh instead of waiting for the ttl window", async () => {
    let nowMs = 0;
    const refreshError = new Error("refresh failed");
    const refreshTools = vi.fn()
      .mockRejectedValueOnce(refreshError)
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();

    const externalToolExecutor = createExternalConversationToolExecutor({
      catalog: {
        refresh: async () => undefined,
        servers: [],
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        listServerTools: async () => [],
        hasTool: () => false,
        executeTool: async () => ({ ok: true })
      },
      now: () => nowMs,
      refreshTools,
      refreshTtlMs: 1_000,
      warn
    });

    await expect(externalToolExecutor.refreshTools?.()).rejects.toBe(refreshError);
    expect(refreshTools).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "failed to refresh daemon MCP tool discovery",
      expect.objectContaining({ error: refreshError })
    );

    nowMs = 500;
    await externalToolExecutor.refreshTools?.();

    expect(refreshTools).toHaveBeenCalledTimes(2);
  });

  it("does not treat builtin tools as present or directly executable when catalog authority does not expose them", async () => {
    const catalogExecuteTool = vi.fn(async () => ({
      ok: false,
      code: "MCP_EXTERNAL_UNBOUND",
      message: "missing from daemon catalog"
    }));
    const externalToolExecutor = createExternalConversationToolExecutor({
      catalog: {
        refresh: async () => undefined,
        servers: [],
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        listServerTools: async () => [],
        hasTool: () => false,
        executeTool: catalogExecuteTool
      },
      refreshTools: async () => undefined
    });

    expect(externalToolExecutor.hasTool("tools.read_file")).toBe(false);
    await expect(
      externalToolExecutor.executeTool({
        toolId: "tools.read_file",
        rawInput: { path: "README.md" },
        runtimeContext: createRuntimeContext(),
        writableRoots: ["/workspace/project"]
      })
    ).resolves.toEqual({
      ok: false,
      code: "MCP_EXTERNAL_UNBOUND",
      message: "missing from daemon catalog"
    });
    expect(catalogExecuteTool).toHaveBeenCalledWith({
      toolId: "tools.read_file",
      rawInput: { path: "README.md" },
      runtimeContext: createRuntimeContext(),
      writableRoots: ["/workspace/project"]
    });
  });

  it("starts conversation tool spec lookups in parallel before it writes any changes", async () => {
    const lookupGate = createDeferred<void>();
    const startedLookups: string[] = [];
    const specs = [
      createToolSpec("tools.write_file"),
      createToolSpec("tools.exec_shell")
    ] as const;
    const service = {
      findById: vi.fn(async (toolId: string) => {
        startedLookups.push(toolId);
        await lookupGate.promise;
        if (toolId === "tools.write_file") {
          return specs[0];
        }

        throw new CoreError("NOT_FOUND", "Tool spec not found");
      }),
      register: vi.fn(async (spec: Readonly<ToolSpec>) => spec),
      update: vi.fn(async (spec: Readonly<ToolSpec>) => spec)
    };

    const pending = registerConversationToolSpecs(service, specs);
    await Promise.resolve();

    expect(startedLookups).toEqual(["tools.write_file", "tools.exec_shell"]);
    expect(service.register).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();

    lookupGate.resolve();
    await pending;
  });

  it("starts register and update writes in parallel after the lookup phase", async () => {
    const writeGate = createDeferred<void>();
    const writesStarted: string[] = [];
    const specs = [
      createToolSpec("tools.write_file"),
      createToolSpec("tools.exec_shell")
    ] as const;
    const service = {
      findById: vi.fn(async (toolId: string) => {
        if (toolId === "tools.write_file") {
          return {
            ...specs[0],
            description: "Existing stale write_file spec"
          };
        }

        throw new CoreError("NOT_FOUND", "Tool spec not found");
      }),
      register: vi.fn(async (spec: Readonly<ToolSpec>) => {
        writesStarted.push(`register:${spec.tool_id}`);
        await writeGate.promise;
        return spec;
      }),
      update: vi.fn(async (spec: Readonly<ToolSpec>) => {
        writesStarted.push(`update:${spec.tool_id}`);
        await writeGate.promise;
        return spec;
      })
    };

    const pending = registerConversationToolSpecs(service, specs);
    await vi.waitFor(() => {
      expect(writesStarted).toEqual(["update:tools.write_file", "register:tools.exec_shell"]);
    });

    writeGate.resolve();
    await pending;
  });
});

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dw-tool-runtime-"));
  tempDirs.add(dir);
  return dir;
}

function createRuntimeContext(): ConversationRuntimeContext {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    user_message_id: "msg-user-1",
    assistant_message_id: "msg-assistant-1"
  };
}

function createBuiltinToolExecutor(toolIds: readonly string[]) {
  const registeredToolIds = new Set(toolIds);

  return {
    hasTool: (toolId: string) => registeredToolIds.has(toolId),
    executeTool: async ({ toolId, rawInput, writableRoots }: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly writableRoots: readonly string[];
    }) => await executeConversationToolOrThrow(toolId, rawInput, writableRoots)
  };
}

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
        } as ToolExecutionRecord);
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
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
