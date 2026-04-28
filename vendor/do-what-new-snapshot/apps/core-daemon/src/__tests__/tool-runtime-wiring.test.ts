import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  getToolRuntimeWiringFixture,
  resetToolRuntimeWiringState
} from "./tool-runtime-wiring-fixture.js";

const hoisted = getToolRuntimeWiringFixture();

describe("daemon tool runtime wiring", () => {
  afterEach(() => {
    resetToolRuntimeWiringState();
  });

  it("boots when the storage mock leaves the optional embedding repo unavailable", async () => {
    await expect(import("../index.js")).resolves.toBeDefined();
  });

  it(
    "wires a toolsHandler through McpBridge and routes tools.read_file through the core conversation tool executor",
    async () => {
      await import("../index.js");

      const toolsHandler = hoisted.mcpBridgeDeps?.toolsHandler;
      expect(typeof toolsHandler).toBe("function");
      expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");

      const result = await toolsHandler!(
        {
          type: "tool_use",
          id: "toolu-1",
          name: "tools.read_file",
          input: {
            path: "/workspace/project/README.md"
          }
        },
        {
          workspace_id: "workspace-1",
          run_id: "run-1",
          surface_id: null,
          user_message_id: "msg-user-1",
          assistant_message_id: "msg-assistant-1"
        }
      );

      expect(hoisted.toolHotPathExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: "tools.read_file",
          rawInput: {
            path: "/workspace/project/README.md"
          },
          workspaceRoot: "/workspace/project",
          runtimeContext: expect.objectContaining({
            workspace_id: "workspace-1",
            run_id: "run-1"
          })
        })
      );
      expect(hoisted.readFile).toHaveBeenCalledWith(
        {
          path: "/workspace/project/README.md"
        },
        ["/workspace/project"]
      );
      expect(result).toEqual({
        type: "tool_result",
        tool_use_id: "toolu-1",
        content: JSON.stringify({
          ok: true,
          content: "hello",
          bytesRead: 5
        })
      });
    },
    10_000
  );

  it("executes discovered MCP tools through their daemon runtime bindings", async () => {
    process.env.DO_WHAT_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON = JSON.stringify({
      filesystem: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-filesystem-server.js"]
      }
    });
    process.env.DO_WHAT_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP.",
          daemon_binding: {
            binding_kind: "builtin_tool",
            builtin_tool_id: "tools.read_file"
          }
        }
      ]
    });
    hoisted.mcpRuntimeServerInfos.push({
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: "2026-04-20T12:00:00.000Z"
    });
    hoisted.mcpRuntimeServerTools.set("filesystem", [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ]);

    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-ext-1",
        name: "mcp__filesystem__read_file",
        input: {
          path: "/workspace/project/README.md"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.readFile).toHaveBeenCalledWith(
      {
        path: "/workspace/project/README.md"
      },
      ["/workspace/project"]
    );
    expect(result.is_error).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      ok: true,
      content: "hello",
      bytesRead: 5
    });
  });

  it("does not execute builtin-bound external MCP tools when the daemon runtime server is configured but inactive", async () => {
    process.env.DO_WHAT_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON = JSON.stringify({
      filesystem: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-filesystem-server.js"]
      }
    });
    process.env.DO_WHAT_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP.",
          daemon_binding: {
            binding_kind: "builtin_tool",
            builtin_tool_id: "tools.read_file"
          }
        }
      ]
    });
    hoisted.mcpRuntimeServerInfos.push({
      server_name: "filesystem",
      transport_type: "stdio",
      status: "inactive",
      registered_at: "2026-04-20T12:00:00.000Z"
    });

    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-ext-missing-runtime",
        name: "mcp__filesystem__read_file",
        input: {
          path: "/workspace/project/README.md"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.readFile).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ is_error: true }));
  });

  it("executes discovered MCP tools through the configured daemon MCP runtime", async () => {
    process.env.DO_WHAT_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON = JSON.stringify({
      filesystem: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-filesystem-server.js"]
      }
    });
    process.env.DO_WHAT_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        }
      ]
    });
    hoisted.mcpRuntimeServerInfos.push({
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: "2026-04-20T12:00:00.000Z"
    });

    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-ext-runtime-1",
        name: "mcp__filesystem__read_file",
        input: {
          path: "README.md"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.mcpRuntimeCallTool).toHaveBeenCalledWith({
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: {
        path: "README.md"
      }
    });
    expect(result.is_error).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            serverName: "filesystem",
            toolName: "filesystem.read_file",
            input: {
              path: "README.md"
            }
          })
        }
      ]
    });
  });

  it("stops executing cached builtin-bound external MCP tools after the runtime server becomes inactive", async () => {
    process.env.DO_WHAT_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON = JSON.stringify({
      filesystem: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-filesystem-server.js"]
      }
    });
    process.env.DO_WHAT_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP.",
          daemon_binding: {
            binding_kind: "builtin_tool",
            builtin_tool_id: "tools.read_file"
          }
        }
      ]
    });
    hoisted.mcpRuntimeServerInfos.push({
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: "2026-04-20T12:00:00.000Z"
    });

    await import("../index.js");
    hoisted.mcpRuntimeServerInfos[0] = {
      ...hoisted.mcpRuntimeServerInfos[0]!,
      status: "inactive"
    };

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-ext-runtime-stale",
        name: "mcp__filesystem__read_file",
        input: {
          path: "/workspace/project/README.md"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.readFile).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ is_error: true }));
  });

  it("awaits external discovery refreshes without adding per-message refreshes", async () => {
    process.env.DO_WHAT_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON = JSON.stringify({
      filesystem: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-filesystem-server.js"]
      }
    });
    hoisted.mcpRuntimeServerInfos.push({
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: "2026-04-20T12:00:00.000Z"
    });
    hoisted.mcpRuntimeServerTools.set("filesystem", [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ]);

    await import("../index.js");

    hoisted.mcpRuntimeServerTools.set("filesystem", [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      },
      {
        name: "filesystem.list_directory",
        description: "List directory through filesystem MCP."
      }
    ]);

    const engine = hoisted.conversationServiceDeps?.engine as
      | { sendMessage(request: unknown): Promise<unknown> }
      | undefined;
    const toolsHandler = hoisted.mcpBridgeDeps?.toolsHandler;
    expect(engine).toBeDefined();
    expect(toolsHandler).toBeDefined();

    await engine!.sendMessage({});
    expect(hoisted.mcpRuntimeRefresh).toHaveBeenCalledTimes(1);
    expect(hoisted.mcpDiscoverAndRegister).toHaveBeenCalledTimes(1);
    expect(hoisted.engineToolSnapshots.at(-1)).not.toEqual(
      expect.arrayContaining(["mcp__filesystem__list_directory"])
    );

    const refreshGate = createDeferred<void>();
    hoisted.mcpRuntimeRefresh.mockImplementationOnce(async () => {
      await refreshGate.promise;
    });

    const firstRefreshResultPromise = toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-ext-refresh-1",
        name: "mcp__filesystem__list_directory",
        input: {
          path: "."
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );
    await Promise.resolve();
    expect(hoisted.mcpRuntimeRefresh).toHaveBeenCalledTimes(2);
    expect(hoisted.mcpDiscoverAndRegister).toHaveBeenCalledTimes(1);

    await engine!.sendMessage({});
    expect(hoisted.engineToolSnapshots.at(-1)).not.toEqual(
      expect.arrayContaining(["mcp__filesystem__list_directory"])
    );

    refreshGate.resolve();
    const firstRefreshResult = await firstRefreshResultPromise;
    expect(firstRefreshResult.is_error).not.toBe(true);
    expect(JSON.parse(firstRefreshResult.content)).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            serverName: "filesystem",
            toolName: "filesystem.list_directory",
            input: {
              path: "."
            }
          })
        }
      ]
    });
    expect(hoisted.mcpDiscoverAndRegister).toHaveBeenCalledTimes(2);

    await engine!.sendMessage({});
    expect(hoisted.engineToolSnapshots.at(-1)).toEqual(
      expect.arrayContaining(["mcp__filesystem__read_file", "mcp__filesystem__list_directory"])
    );
  });

  it("routes tools.write_file through the core conversation tool executor", async () => {
    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-2",
        name: "tools.write_file",
        input: {
          path: "/workspace/project/notes.txt",
          content: "hello"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.toolHotPathExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "tools.write_file",
        rawInput: {
          path: "/workspace/project/notes.txt",
          content: "hello"
        },
        workspaceRoot: "/workspace/project"
      })
    );
    expect(hoisted.writeFile).toHaveBeenCalledWith(
      {
        path: "/workspace/project/notes.txt",
        content: "hello"
      },
      ["/workspace/project"]
    );
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-2",
      content: JSON.stringify({
        ok: true,
        bytesWritten: 5
      })
    });
  });

  it("routes tools.exec_shell through the core conversation tool executor", async () => {
    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-3",
        name: "tools.exec_shell",
        input: {
          command: "echo",
          args: ["hello"],
          timeoutMs: 5_000
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.toolHotPathExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "tools.exec_shell",
        rawInput: {
          command: "echo",
          args: ["hello"],
          timeoutMs: 5_000
        },
        workspaceRoot: "/workspace/project"
      })
    );
    expect(hoisted.execShell).toHaveBeenCalledWith(
      {
        command: "echo",
        args: ["hello"],
        timeoutMs: 5_000
      },
      ["/workspace/project"]
    );
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-3",
      content: JSON.stringify({
        ok: true,
        exitCode: 0,
        stdout: "ok\n",
        stderr: ""
      })
    });
  });

  it("reuses the daemon-validated tools.exec_shell input inside the hot-path handler", async () => {
    hoisted.toolHotPathExecute.mockImplementationOnce(async (request: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly handler: (context: { readonly writableRoots: readonly string[] }, input: unknown) => Promise<unknown>;
    }) => ({
      result: await request.handler(
        { writableRoots: [hoisted.workspace.root_path] },
        {
          command: "",
          args: ["should-not-be-reparsed"]
        }
      ),
      executionRecord: {
        execution_id: "exec-1",
        tool_id: request.toolId,
        requested_by: "principal",
        requesting_run_id: "run-1",
        governance_decision_ref: "ask://approved",
        permission_result: "allow",
        executed: true,
        started_at: "2026-04-12T10:00:00.000Z",
        ended_at: "2026-04-12T10:00:01.000Z",
        result_summary: "ok",
        rollback_status: "none"
      },
      permissionResult: "allow"
    }));

    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-3b",
        name: "tools.exec_shell",
        input: {
          command: "echo",
          args: ["hello"],
          timeoutMs: 5_000
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.toolHotPathExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "tools.exec_shell",
        rawInput: {
          command: "echo",
          args: ["hello"],
          timeoutMs: 5_000
        }
      })
    );
    expect(hoisted.execShell).toHaveBeenCalledWith(
      {
        command: "echo",
        args: ["hello"],
        timeoutMs: 5_000
      },
      ["/workspace/project"]
    );
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-3b",
      content: JSON.stringify({
        ok: true,
        exitCode: 0,
        stdout: "ok\n",
        stderr: ""
      })
    });
  });
});
