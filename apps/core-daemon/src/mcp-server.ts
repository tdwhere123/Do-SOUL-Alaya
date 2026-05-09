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

export const ALAYA_MCP_SERVER_INSTRUCTIONS = [
  "This MCP server exposes tools only (no prompts, no resources).",
  "START every memory-sensitive turn by calling soul.recall BEFORE answering.",
  "You SHOULD call soul.recall when the user message touches: personal preferences, working style, or past corrections; prior decisions, architecture choices, or project context; or any \"do you remember / last time / we agreed\" reference.",
  "Workflow: soul.recall -> soul.open_pointer (only if the preview is insufficient) -> answer -> soul.report_context_usage.",
  "When you find new durable memory candidates: soul.emit_candidate_signal first, then soul.propose_memory_update.",
  "Durable memory mutates only through accepted proposal apply; rejected proposals do not mutate durable memory."
].join(" ");

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
      instructions: ALAYA_MCP_SERVER_INSTRUCTIONS
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
  // p5-system-review-r3 MR-I04: inputSchema is now derived from zod via
  // zod-to-json-schema (Record<string, unknown>). The MCP SDK's Tool
  // shape requires the canonical { type: "object", properties, required,
  // additionalProperties } subset, so we shallow-spread the derived JSON
  // Schema rather than re-typing each field.
  const derived = tool.inputSchema as {
    properties?: Record<string, object>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      ...(derived.properties === undefined ? {} : { properties: { ...derived.properties } }),
      ...(derived.required === undefined ? {} : { required: [...derived.required] }),
      ...(derived.additionalProperties === undefined
        ? {}
        : { additionalProperties: derived.additionalProperties })
    },
    annotations: tool.annotations
  };
}
