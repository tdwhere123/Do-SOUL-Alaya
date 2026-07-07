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
    requires_confirmation: toolId === "tools.exec_shell" || toolId === "tools.write_file",
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: false
  };
}

afterEach(cleanupToolRuntimeTempDirs);

describe("tool-runtime relative path handling", () => {

  it("denies builtin tools that require confirmation without a valid server receipt", async () => {
    const workspaceDir = await createWorkspace();
    const executeTool = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: "should-not-run",
      stderr: ""
    }));

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-confirmation-required",
        name: "tools.exec_shell",
        input: {
          command: "/bin/echo",
          args: ["unsafe"],
          _alaya_confirmation: {
            confirmed: true,
            token: "wrong-token"
          }
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
          throw new Error("must not execute confirmation-required builtin tool");
        }
      },
      {
        confirmationToken: "server-token",
        externalToolExecutor: {
          hasTool: () => true,
          executeTool
        }
      }
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-confirmation-required",
      content: JSON.stringify({
        ok: false,
        code: "CONFIRMATION_REQUIRED",
        message: "Tool tools.exec_shell requires a valid server-verifiable confirmation receipt."
      }),
      is_error: true
    });
  });

  it("executes confirmation-required builtin tools with a valid server receipt", async () => {
    const workspaceDir = await createWorkspace();
    const executeTool = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: "confirmed",
      stderr: ""
    }));

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-confirmed",
        name: "tools.exec_shell",
        input: {
          command: "/bin/echo",
          args: ["confirmed"],
          _alaya_confirmation: {
            confirmed: true,
            token: "server-token"
          }
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
          result: await request.handler({ writableRoots: [request.workspaceRoot] }, request.rawInput)
        })
      },
      {
        confirmationToken: "server-token",
        externalToolExecutor: {
          hasTool: () => true,
          executeTool
        }
      }
    );

    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        rawInput: {
          command: "/bin/echo",
          args: ["confirmed"]
        }
      })
    );
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-confirmed",
      content: JSON.stringify({
        ok: true,
        exitCode: 0,
        stdout: "confirmed",
        stderr: ""
      })
    });
  });

  it("rejects confirmation-required builtin tools when ALAYA_MCP_TOOL_CONFIRMATION_TOKEN is unset", async () => {
    const workspaceDir = await createWorkspace();
    const previousToken = process.env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN;
    delete process.env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN;

    try {
      const result = await handleConversationToolUse(
        {
          type: "tool_use",
          id: "toolu-unconfigured-token",
          name: "tools.exec_shell",
          input: {
            command: "/bin/echo",
            args: ["unsafe"],
            _alaya_confirmation: {
              confirmed: true,
              token: "server-token"
            }
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
            throw new Error("must not execute confirmation-required builtin tool");
          }
        }
      );

      expect(result).toEqual({
        type: "tool_result",
        tool_use_id: "toolu-unconfigured-token",
        content: JSON.stringify({
          ok: false,
          code: "CONFIRMATION_REQUIRED",
          message:
            "Tool tools.exec_shell requires server-verifiable confirmation, but ALAYA_MCP_TOOL_CONFIRMATION_TOKEN is not configured."
        }),
        is_error: true
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN;
      } else {
        process.env.ALAYA_MCP_TOOL_CONFIRMATION_TOKEN = previousToken;
      }
    }
  });

  it("denies tools.write_file without a valid server confirmation receipt", async () => {
    const workspaceDir = await createWorkspace();
    await mkdir(path.join(workspaceDir, "notes"), { recursive: true });

    const result = await handleConversationToolUse(
      {
        type: "tool_use",
        id: "toolu-write-unconfirmed",
        name: "tools.write_file",
        input: {
          path: "notes/test.txt",
          content: "unsafe"
        }
      },
      createRuntimeContext(),
      {
        getById: async () => ({
          root_path: workspaceDir
        })
      },
      createBuiltinToolExecutor(["tools.write_file"]),
      {
        confirmationToken: "server-token"
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-write-unconfirmed",
      content: JSON.stringify({
        ok: false,
        code: "CONFIRMATION_REQUIRED",
        message: "Tool tools.write_file requires a valid server-verifiable confirmation receipt."
      }),
      is_error: true
    });
  });

  it("rejects executeConversationToolOrThrow for confirmation-required builtins without receipt", async () => {
    const workspaceDir = await createWorkspace();
    const { executeConversationToolOrThrow } = await import("../../mcp/tool-runtime.js");

    await expect(
      executeConversationToolOrThrow(
        "tools.exec_shell",
        {
          command: "/bin/echo",
          args: ["unsafe"]
        },
        [workspaceDir],
        { confirmationToken: "server-token" }
      )
    ).rejects.toMatchObject({
      result: {
        ok: false,
        code: "CONFIRMATION_REQUIRED"
      }
    });

    await expect(
      executeConversationToolOrThrow(
        "tools.write_file",
        {
          path: "notes/test.txt",
          content: "unsafe"
        },
        [workspaceDir],
        { confirmationToken: "server-token" }
      )
    ).rejects.toMatchObject({
      result: {
        ok: false,
        code: "CONFIRMATION_REQUIRED"
      }
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
      } as Parameters<typeof createExternalConversationToolExecutor>[0]["catalog"],
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
