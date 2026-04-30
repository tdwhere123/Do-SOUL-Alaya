import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createToolsCommand } from "../cli/tools.js";
import type { AlayaCliContext } from "../cli/bridge.js";
import type { McpMemoryToolHandler } from "../mcp-memory-tool-handler.js";

describe("alaya tools", () => {
  it("lists the same first-party catalog used by MCP", async () => {
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => chunks.push(chunk.toString()));
    const command = createToolsCommand({ handler: createHandler() });

    const result = await command.handler(createContext({ stdout }), {
      action: "list",
      toolName: null,
      input: {},
      contextOverrides: { workspaceId: null, runId: undefined, agentTarget: null }
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("soul.recall");
    expect(result.json).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "soul.report_context_usage" })])
    });
  });

  it("calls the shared memory tool handler", async () => {
    const handler = createHandler();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (chunk) => chunks.push(chunk.toString()));
    const command = createToolsCommand({
      handler,
      defaultWorkspaceId: "ws1",
      defaultAgentTarget: "codex"
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.open_pointer",
      "{\"object_id\":\"mem1\"}",
      "--run",
      "run1"
    ]);

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await command.handler(createContext({ stdout }), parsed.data);

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ object_id: "mem1" });
    expect(chunks.join("")).toContain("\"mem1\"");
  });
});

function createHandler(): McpMemoryToolHandler {
  return {
    call: async ({ toolName }) => {
      if (toolName !== "soul.open_pointer") {
        return {
          ok: false,
          tool_name: toolName,
          error: { code: "UNKNOWN_TOOL", message: "unsupported" }
        };
      }

      return {
        ok: true,
        tool_name: "soul.open_pointer",
        output: { object_id: "mem1" }
      };
    }
  };
}

function createContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] },
    ...overrides
  };
}
