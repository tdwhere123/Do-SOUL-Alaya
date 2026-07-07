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

import { createExternalConversationToolExecutor } from "../../mcp/mcp-catalog.js";

import {
  executeConversationTool,
  handleConversationToolUse,
  registerConversationToolSpecs
} from "../../mcp/tool-runtime.js";

import {
  cleanupToolRuntimeTempDirs,
  createBuiltinToolExecutor,
  createConversationToolSpec,
  createDeferred,
  createRuntimeContext,
  createWorkspace,
  confirmedToolExecutionOptions,
  trackToolRuntimeTempDir,
  withToolConfirmation
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

afterEach(cleanupToolRuntimeTempDirs);

describe("tool-runtime relative path handling", () => {

  it("extracts repo-relative affected_paths for builtin write tools", async () => {
    const workspaceDir = await createWorkspace();
    const repoDir = path.join(workspaceDir, "repo");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const { appendedEntries, executor, insertedRecords } = createRecordingConversationToolExecutor(
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
});
