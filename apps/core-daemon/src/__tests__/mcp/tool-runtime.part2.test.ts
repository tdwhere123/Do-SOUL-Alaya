import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreError } from "@do-soul/alaya-core";

import type {
  EventLogEntry,
  ToolExecutionRecord,
  ToolSpec
} from "@do-soul/alaya-protocol";

import { createExternalConversationToolExecutor } from "../../mcp/catalog/mcp-catalog.js";

import {
  executeConversationTool,
  handleConversationToolUse,
  registerConversationToolSpecs
} from "../../mcp/tool-runtime/tool-runtime.js";

import {
  cleanupToolRuntimeTempDirs,
  createAutoConfirmingBuiltinToolExecutor,
  createConversationToolSpec,
  createDeferred,
  createRuntimeContext,
  createWorkspace,
  confirmedToolExecutionOptions,
  trackToolRuntimeTempDir,
  withToolConfirmation
} from "./tool-runtime-shared-fixture.js";

function createRecordingConversationToolExecutor(toolSpec: ToolSpec) {
  const requests: Array<{ readonly rawInput: unknown; readonly affectedPathRoots?: readonly string[] }> = [];
  return {
    requests,
    executor: {
      execute: async (request: {
        readonly toolId: string; readonly rawInput: unknown; readonly workspaceRoot: string;
        readonly affectedPathRoots?: readonly string[];
        readonly handler: (context: { readonly writableRoots: readonly string[] }, rawInput?: unknown) => Promise<unknown>;
      }) => {
        expect(request.toolId).toBe(toolSpec.tool_id);
        requests.push(request);
        return { result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput) };
      }
    }
  };
}

afterEach(cleanupToolRuntimeTempDirs);

describe("tool-runtime relative path handling", () => {

  it("forwards repository roots and raw input for builtin write tools", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const { requests, executor } = createRecordingConversationToolExecutor(
      createConversationToolSpec("tools.write_file")
    );

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-write-affected",
        name: "tools.write_file",
        input: withToolConfirmation({
          path: path.join(repoDir, "src/index.ts"),
          content: "export const value = 1;\n"
        })
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
        ...confirmedToolExecutionOptions,
        gitBindingValidation: {
          currentWorkingDirectory: workspaceDir
        },
        externalToolExecutor: createAutoConfirmingBuiltinToolExecutor(["tools.write_file"])
      }
    );

    expect(JSON.parse(result.content)).toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.affectedPathRoots).toContain(repoDir);
    expect(requests[0]?.rawInput).toMatchObject({ path: path.join(repoDir, "src/index.ts") });
  });

  it("forwards repository roots and raw input for external filesystem write tools", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    const { requests, executor } = createRecordingConversationToolExecutor(
      createConversationToolSpec("mcp__filesystem__write_file")
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
    expect(requests).toHaveLength(1);
    expect(requests[0]?.affectedPathRoots).toContain(repoDir);
    expect(requests[0]?.rawInput).toMatchObject({ path: path.join(repoDir, "docs/notes.md") });
  });

  it("forwards the original outside-repository path for the executor to assess", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    const { requests, executor } = createRecordingConversationToolExecutor(
      createConversationToolSpec("mcp__filesystem__write_file")
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
    expect(requests).toHaveLength(1);
    expect(requests[0]?.affectedPathRoots).toContain(repoDir);
    expect(requests[0]?.rawInput).toMatchObject({ path: path.join(workspaceDir, "outside-repo.txt") });
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
});
