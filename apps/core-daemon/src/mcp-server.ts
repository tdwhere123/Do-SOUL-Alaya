import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import {
  listAlayaMemoryTools,
  type AlayaMemoryToolDefinition
} from "./mcp-memory-tool-catalog.js";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandler
} from "./mcp-memory-tool-handler.js";

export interface AlayaMcpServerOptions {
  readonly memoryToolHandler: McpMemoryToolHandler;
  readonly contextProvider: () => McpMemoryToolCallContext;
  readonly tools?: readonly AlayaMemoryToolDefinition[];
}

export interface AlayaMcpStdioServer {
  close(): Promise<void>;
}

export function createAlayaMcpServer(options: AlayaMcpServerOptions): Server {
  const tools = options.tools ?? listAlayaMemoryTools();
  const server = new Server(
    {
      name: "do-soul-alaya",
      version: "0.0.1"
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: "Use the soul.* memory tools for Alaya memory recall, pointer open, proposals, overrides, graph exploration, and usage proof."
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => createAlayaMcpToolsResult(tools));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> =>
    await callAlayaMcpMemoryTool(options, request.params.name, request.params.arguments ?? {})
  );

  return server;
}

export function createAlayaMcpToolsResult(tools: readonly AlayaMemoryToolDefinition[] = listAlayaMemoryTools()): {
  readonly tools: readonly Tool[];
} {
  return {
    tools: tools.map(toMcpTool)
  };
}

export async function callAlayaMcpMemoryTool(
  options: Pick<AlayaMcpServerOptions, "memoryToolHandler" | "contextProvider">,
  toolName: string,
  rawArguments: unknown
): Promise<CallToolResult> {
  const result = await options.memoryToolHandler.call({
    toolName,
    arguments: rawArguments,
    context: options.contextProvider()
  });

  if (!result.ok) {
    const payload = {
      ok: false,
      error: result.error
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload
    };
  }

  const payload = {
    ok: true,
    tool_name: result.tool_name,
    output: result.output
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload.output) }],
    structuredContent: payload
  };
}

export async function runAlayaMcpStdioServer(
  options: AlayaMcpServerOptions & {
    readonly stdin?: ConstructorParameters<typeof StdioServerTransport>[0];
    readonly stdout?: ConstructorParameters<typeof StdioServerTransport>[1];
  }
): Promise<AlayaMcpStdioServer> {
  const server = createAlayaMcpServer(options);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  return {
    async close() {
      await transport.close();
      await server.close();
    }
  };
}

function toMcpTool(tool: AlayaMemoryToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      ...(tool.inputSchema.properties === undefined ? {} : { properties: { ...tool.inputSchema.properties } }),
      ...(tool.inputSchema.required === undefined ? {} : { required: [...tool.inputSchema.required] }),
      ...(tool.inputSchema.additionalProperties === undefined
        ? {}
        : { additionalProperties: tool.inputSchema.additionalProperties })
    },
    annotations: tool.annotations
  };
}
