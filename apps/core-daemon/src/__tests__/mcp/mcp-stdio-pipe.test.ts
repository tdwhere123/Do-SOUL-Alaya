import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { runAlayaMcpStdioServer } from "../../mcp/server/mcp-server.js";
import { createMcpMemoryToolDispatcher } from "../../mcp-memory/tool/tool-handler-dispatch.js";
import type { McpMemoryToolOperations, GardenTaskOperations } from "../../mcp-memory/tool/tool-handler-operations.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool/tool-handler.js";
import { ALAYA_MEMORY_TOOL_NAMES, listAlayaMemoryTools, type AlayaMemoryToolName } from "../../mcp-memory/tool/tool-catalog.js";
import { expectedEffectiveDescriptionByName } from "../mcp-memory/tool/mcp-memory-tool-effective-description.fixture.js";

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
      captureHostSession: unused,
      interpretation: unused,
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
      expect(names).not.toContain("soul.interpretation");
      for (const published of listed.tools) {
        const definition = listAlayaMemoryTools().find(tool => tool.name === published.name)!;
        expect(published.inputSchema).toEqual({ ...definition.inputSchema, type: "object" });
      }
      const update = listed.tools.find(tool => tool.name === "soul.propose_memory_update")!;
      expect(update.inputSchema.anyOf).toEqual(expect.any(Array));
      expect(listed.tools.find(tool => tool.name === "soul.recall")?.description)
        .toContain("`recent_turn` is ignored for extraction");

      const invalid = await client.callTool({
        name: "soul.interpretation", arguments: { operation: "not-an-operation" }
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" }
      });

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

  it("serves exact effective descriptions over real stdio list_tools", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const handler: McpMemoryToolHandler = {
      call: async () => {
        throw new Error("stdio effective-description list_tools test must not call tools");
      }
    };
    const server = await runAlayaMcpStdioServer({
      memoryToolHandler: handler,
      contextProvider: () => ({
        workspaceId: "workspace-1",
        runId: null,
        agentTarget: "inspector",
        sessionId: "stdio-pipe-effective-description"
      }),
      stdin: clientToServer,
      stdout: serverToClient
    });
    const client = new Client({ name: "stdio-pipe-effective-description", version: "test" }, { capabilities: {} });

    try {
      await client.connect(new PipeClientTransport(serverToClient, clientToServer));
      const listed = await client.listTools();
      const expectedByName = expectedEffectiveDescriptionByName();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...ALAYA_MEMORY_TOOL_NAMES]);
      const interpretation = listed.tools.find(tool => tool.name === "soul.interpretation")!;
      expect(interpretation.inputSchema.oneOf).toEqual(expect.any(Array));
      expect(interpretation.description).toContain("external embedding attempts are reported separately");
      expect(interpretation.description).not.toMatch(/provider-free|no operation calls a provider/iu);
      for (const published of listed.tools) {
        expect(published.description).toBe(expectedByName.get(published.name as AlayaMemoryToolName));
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("omits soul.interpretation from codex stdio list_tools while dispatching it and listing it on host-interpretation", async () => {
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
      captureHostSession: unused,
      interpretation: unused,
      operations: {} as unknown as McpMemoryToolOperations
    });
    const handler: McpMemoryToolHandler = {
      call: async (input) =>
        dispatcher.dispatchToolCall({
          toolName: input.toolName as AlayaMemoryToolName,
          rawArguments: input.arguments,
          context: input.context
        })
    };

    for (const [agentTarget, expectAdvertised] of [["codex", false], ["host-interpretation", true]] as const) {
      const clientToServer = new PassThrough();
      const serverToClient = new PassThrough();
      const server = await runAlayaMcpStdioServer({
        memoryToolHandler: handler,
        contextProvider: () => ({
          workspaceId: "workspace-1",
          runId: null,
          agentTarget,
          sessionId: `stdio-pipe-${agentTarget}`
        }),
        stdin: clientToServer,
        stdout: serverToClient
      });
      const client = new Client({ name: `stdio-pipe-${agentTarget}`, version: "test" }, { capabilities: {} });
      try {
        await client.connect(new PipeClientTransport(serverToClient, clientToServer));
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name);
        expect(names).not.toContain("soul.review_memory_proposal");
        expect(names).not.toContain("soul.batch_review_edge_proposals");
        if (expectAdvertised) {
          expect(names).toContain("soul.interpretation");
          const interpretation = listed.tools.find((tool) => tool.name === "soul.interpretation")!;
          expect(interpretation.inputSchema.oneOf).toEqual(expect.any(Array));
          expect(interpretation.description).toContain("external embedding attempts are reported separately");
        } else {
          expect(names).not.toContain("soul.interpretation");
        }
        const invalid = await client.callTool({
          name: "soul.interpretation",
          arguments: { operation: "not-an-operation" }
        });
        expect(invalid.isError).toBe(true);
        expect(invalid.structuredContent).toMatchObject({
          ok: false,
          error: { code: "VALIDATION" }
        });
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
});
