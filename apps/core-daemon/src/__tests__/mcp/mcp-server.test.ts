import { describe, expect, it, vi } from "vitest";
import {
  ALAYA_MCP_SERVER_INSTRUCTIONS,
  callAlayaMcpMemoryTool,
  createAlayaMcpServer,
  createAlayaMcpServerInfo,
  createAlayaMcpToolsResult
} from "../../mcp/mcp-server.js";
import { readRuntimeVersion } from "../../runtime/build-info.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool-handler.js";

describe("mcp server", () => {
  it("lists the Alaya memory tools as MCP tools", () => {
    const result = createAlayaMcpToolsResult();

    expect(result.tools.map((tool) => tool.name)).toContain("soul.recall");
    expect(result.tools.map((tool) => tool.name)).toContain("soul.report_context_usage");
    expect(result.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("converts successful handler output into an MCP call result", async () => {
    const handler: McpMemoryToolHandler = {
      call: async () => ({
        ok: true,
        tool_name: "soul.open_pointer",
        output: { object_id: "mem1" }
      })
    };

    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: handler,
        contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex", sessionId: "session-1" })
      },
      "soul.open_pointer",
      { object_id: "mem1" }
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool_name: "soul.open_pointer",
      output: { object_id: "mem1" }
    });
  });

  it("converts handler failures into MCP error results", async () => {
    const handler: McpMemoryToolHandler = {
      call: async () => ({
        ok: false,
        tool_name: "memory.recall",
        error: { code: "UNKNOWN_TOOL", message: "Unsupported" }
      })
    };

    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: handler,
        contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex", sessionId: "session-1" })
      },
      "memory.recall",
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_TOOL" }
    });
  });

  it("converts a rejected handler promise into a structured MCP error result", async () => {
    const warn = vi.fn();
    const handler: McpMemoryToolHandler = {
      call: async () => {
        throw new Error("private handler detail");
      }
    };

    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: handler,
        contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex", sessionId: "session-1" }),
        warn
      },
      "soul.recall",
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Unexpected MCP tool failure" }
    });
    expect(warn).toHaveBeenCalledWith("MCP memory tool handler rejected", {
      error: "private handler detail",
      toolName: "soul.recall"
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("private handler detail");
  });

  it("pins tools-only MCP server instructions for the full memory loop", () => {
    const handler: McpMemoryToolHandler = {
      call: async () => ({
        ok: true,
        tool_name: "soul.recall",
        output: { delivery_id: "d1", results: [], total_count: 0 }
      })
    };
    createAlayaMcpServer({
      memoryToolHandler: handler,
      contextProvider: () => ({ workspaceId: "ws1", runId: null, agentTarget: "codex", sessionId: "session-1" })
    });

    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).toContain("tools only");
    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).toContain("no prompts, no resources");
    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).toContain("START every memory-sensitive turn");
    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).toContain("soul.recall -> soul.open_pointer");
    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).toContain("soul.emit_candidate_signal");
    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).toContain("accepted proposal apply");
  });

  it("derives MCP server info version from runtime metadata instead of a hardcoded sentinel", () => {
    expect(createAlayaMcpServerInfo()).toEqual({
      name: "do-soul-alaya",
      version: readRuntimeVersion()
    });
    expect(createAlayaMcpServerInfo().version).not.toBe("0.0.1");
  });
});
