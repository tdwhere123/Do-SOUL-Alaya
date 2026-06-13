import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { createExternalConversationToolExecutor } from "../../mcp/mcp-catalog.js";
import {
  executeConversationToolOrThrow,
  handleConversationToolUse
} from "../../mcp/tool-runtime.js";
import {
  cleanupToolRuntimeTempDirs,
  createBuiltinToolExecutor,
  createDeferred,
  createRuntimeContext,
  createWorkspace
} from "./tool-runtime-shared-fixture.js";

afterEach(cleanupToolRuntimeTempDirs);

describe("tool-runtime relative path handling", () => {
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
        executeTool
      } as Parameters<typeof createExternalConversationToolExecutor>[0]["catalog"],
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
      } as Parameters<typeof createExternalConversationToolExecutor>[0]["catalog"],
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
      } as Parameters<typeof createExternalConversationToolExecutor>[0]["catalog"],
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
});
