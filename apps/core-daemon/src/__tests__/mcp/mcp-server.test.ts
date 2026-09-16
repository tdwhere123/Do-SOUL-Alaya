import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALAYA_MCP_SERVER_INSTRUCTIONS,
  callAlayaMcpMemoryTool,
  createAlayaMcpServer,
  createAlayaMcpServerInfo,
  createAlayaMcpToolsResult
} from "../../mcp/server/mcp-server.js";
import { readRuntimeVersion } from "../../runtime/daemon/support/build-info.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool/tool-handler.js";

describe("mcp server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists the Alaya memory tools as MCP tools", () => {
    const result = createAlayaMcpToolsResult();

    expect(result.tools.map((tool) => tool.name)).toContain("soul.recall");
    expect(result.tools.map((tool) => tool.name)).toContain("soul.report_context_usage");
    expect(result.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("converts successful handler output into an MCP call result", async () => {
    const handler = {
      call: async () => ({
        ok: true,
        tool_name: "soul.open_pointer",
        output: { object_id: "mem1" }
      })
    } as unknown as McpMemoryToolHandler;

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
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          tool_name: "soul.open_pointer",
          output: { object_id: "mem1" }
        })
      }
    ]);
  });

  it("converts handler failures into MCP error results", async () => {
    const handler = {
      call: async () => ({
        ok: false,
        tool_name: "memory.recall",
        error: { code: "UNKNOWN_TOOL", message: "Unsupported" }
      })
    } as unknown as McpMemoryToolHandler;

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
    const handler = {
      call: async () => {
        throw new Error("private handler detail");
      }
    } as unknown as McpMemoryToolHandler;

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
    const handler = {
      call: async () => ({
        ok: true,
        tool_name: "soul.recall",
        output: { delivery_id: "d1", results: [], total_count: 0 }
      })
    } as unknown as McpMemoryToolHandler;
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
    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).toContain("Ordinary soul.recall does not enqueue extraction");
    expect(ALAYA_MCP_SERVER_INSTRUCTIONS).not.toContain(
      "On soul.recall, pass the user's latest message verbatim in recent_turn"
    );
  });

  it("derives MCP server info version from runtime metadata instead of a hardcoded sentinel", () => {
    expect(createAlayaMcpServerInfo()).toEqual({
      name: "do-soul-alaya",
      version: readRuntimeVersion()
    });
    expect(createAlayaMcpServerInfo().version).not.toBe("0.0.1");
  });

  it("does not start a handler write after the MCP tool timeout aborts", async () => {
    const writes: string[] = [];
    const handler: McpMemoryToolHandler = {
      call: async ({ context }) => {
        const signal = context.abortSignal;
        await new Promise<void>((resolve) => {
          if (signal === undefined || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (context.abortSignal?.aborted) {
          throw context.abortSignal.reason;
        }
        writes.push("signal-row");
        return {
          ok: true,
          tool_name: "soul.emit_candidate_signal",
          output: { signal_id: "late", status: "emitted" }
        };
      }
    };

    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: handler,
        contextProvider: () => ({
          workspaceId: "ws1",
          runId: "run-1",
          agentTarget: "codex",
          sessionId: "session-1"
        }),
        toolTimeoutMs: 20
      },
      "soul.emit_candidate_signal",
      { signal_kind: "potential_claim" }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "MCP tool execution timed out." }
    });
    expect(writes).toEqual([]);
  });

  it("applies ALAYA_MCP_TOOL_TIMEOUT_MS from process env when options omit timeout", async () => {
    vi.stubEnv("ALAYA_MCP_TOOL_TIMEOUT_MS", "20");
    const writes: string[] = [];
    const handler: McpMemoryToolHandler = {
      call: async ({ context }) => {
        const signal = context.abortSignal;
        await new Promise<void>((resolve) => {
          if (signal === undefined || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (context.abortSignal?.aborted) {
          throw context.abortSignal.reason;
        }
        writes.push("signal-row");
        return {
          ok: true,
          tool_name: "soul.emit_candidate_signal",
          output: { signal_id: "late", status: "emitted" }
        };
      }
    };

    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: handler,
        contextProvider: () => ({
          workspaceId: "ws1",
          runId: "run-1",
          agentTarget: "codex",
          sessionId: "session-1"
        })
      },
      "soul.emit_candidate_signal",
      { signal_kind: "potential_claim" }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "MCP tool execution timed out." }
    });
    expect(writes).toEqual([]);
  });
});
