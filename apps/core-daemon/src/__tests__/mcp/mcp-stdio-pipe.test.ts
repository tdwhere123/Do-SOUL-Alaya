import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { runAlayaMcpStdioServer } from "../../mcp/server/mcp-server.js";
import { createMcpMemoryToolDispatcher } from "../../mcp-memory/tool/tool-handler-dispatch.js";
import type { McpMemoryToolOperations, GardenTaskOperations } from "../../mcp-memory/tool/tool-handler-operations.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool/tool-handler.js";
import type { AlayaMemoryToolName } from "../../mcp-memory/tool/tool-catalog.js";

class PipeClientTransport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: unknown) => void;
  private buffer = "";

  public constructor(
    private readonly readable: PassThrough,
    private readonly writable: PassThrough
  ) {}

  public async start(): Promise<void> {
    this.readable.on("data", (chunk: Buffer | string) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          this.onmessage?.(JSON.parse(line) as unknown);
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  public async send(message: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.writable.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    this.readable.destroy();
    this.writable.end();
    this.onclose?.();
  }
}

describe("Alaya MCP stdio pipe", () => {
  it("lists and calls tools over real stdio framing", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const unused = async (): Promise<never> => {
      throw new Error("unused stdio catalog tool");
    };
    const dispatcher = createMcpMemoryToolDispatcher({
      gardenTasks: {
        listPendingGardenTasks: unused,
        claimGardenTask: unused,
        completeGardenTask: unused
      } as unknown as GardenTaskOperations,
      recall: unused,
      reportContextUsage: unused,
      operations: {
        listPendingProposals: async () => ({ proposals: [], total_count: 0 })
      } as unknown as McpMemoryToolOperations
    });
    const handler: McpMemoryToolHandler = {
      call: async (input) =>
        dispatcher.dispatchToolCall({
          toolName: input.toolName as AlayaMemoryToolName,
          rawArguments: input.arguments,
          context: input.context
        })
    };

    const server = await runAlayaMcpStdioServer({
      memoryToolHandler: handler,
      contextProvider: () => ({
        workspaceId: "workspace-1",
        runId: null,
        agentTarget: "codex",
        sessionId: "stdio-pipe-test"
      }),
      stdin: clientToServer,
      stdout: serverToClient
    });
    const client = new Client({ name: "stdio-pipe-test", version: "test" }, { capabilities: {} });

    try {
      await client.connect(new PipeClientTransport(serverToClient, clientToServer));
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("soul.recall");
      expect(names).toContain("soul.list_pending_proposals");

      const called = await client.callTool({
        name: "soul.list_pending_proposals",
        arguments: {}
      });
      expect(called.isError).toBeUndefined();
      expect(called.structuredContent).toMatchObject({
        ok: true,
        tool_name: "soul.list_pending_proposals",
        output: {
          proposals: [],
          total_count: 0
        }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
