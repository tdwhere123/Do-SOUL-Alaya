/**
 * @internal Exposed via `@do-soul/alaya/mcp-server` for the in-process
 * bench harness in `@do-soul/alaya-bench-runner`. Not a stability promise:
 * the export surface, symbol names, and signatures may change without a
 * deprecation period. If you rename or split this module, also update:
 *   - apps/core-daemon/package.json `exports."./mcp-server"`
 *   - apps/bench-runner/src/harness/daemon.ts (the only known consumer)
 * @see apps/bench-runner/src/harness/daemon.ts
 */
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
} from "../mcp-memory/tool-catalog.js";
import { readRuntimeVersion } from "../runtime/build-info.js";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandler
} from "../mcp-memory/tool-handler.js";

export interface AlayaMcpServerOptions {
  readonly memoryToolHandler: McpMemoryToolHandler;
  readonly contextProvider: () => McpMemoryToolCallContext;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly tools?: readonly AlayaMemoryToolDefinition[];
  readonly version?: string;
}

export interface AlayaMcpStdioServer {
  close(): Promise<void>;
}

export const ALAYA_MCP_SERVER_INSTRUCTIONS = [
  "This MCP server exposes tools only (no prompts, no resources).",
  "START every memory-sensitive turn by calling soul.recall BEFORE answering.",
  "You SHOULD call soul.recall when the user message touches: personal preferences, working style, or past corrections; prior decisions, architecture choices, or project context; or any \"do you remember / last time / we agreed\" reference.",
  "Workflow: soul.recall -> soul.open_pointer (only if the preview is insufficient) -> answer -> soul.report_context_usage.",
  "On soul.recall, pass the user's latest message verbatim in recent_turn; on soul.report_context_usage, include turn_index and turn_digest.last_messages. Alaya passively extracts durable candidates from that text, so you do not need to file every preference or decision yourself.",
  "You MAY still call soul.emit_candidate_signal then soul.propose_memory_update for a fact you judge clearly worth recording explicitly; routine preferences and decisions are already covered by the passive extraction above.",
  "Durable memory mutates only through accepted proposal apply; rejected proposals do not mutate durable memory.",
  "GARDEN HOST-WORKER LOOP: when the operator has set garden compute provider_kind=host_worker, Alaya queues POST_TURN_EXTRACT background tasks for an attached CLI agent (Codex / Claude Code / similar) to run as host worker.",
  "When you have spare capacity between user turns (or are explicitly asked to flush the garden queue), you MAY: garden.list_pending_tasks -> garden.claim_task -> run your own sub-agent extraction on the task payload -> garden.complete_task with candidate_signals.",
  "Only the agent target that claimed a task can complete it; another attached host completing it is rejected. Task payload carries the run_id bound by the MCP context; attached MCP sessions without ALAYA_RUN_ID are first canonicalized as session runs. Never substitute a different run id."
].join(" ");

export function createAlayaMcpServerInfo(options: Pick<AlayaMcpServerOptions, "version"> = {}): Readonly<{
  readonly name: "do-soul-alaya";
  readonly version: string;
}> {
  return Object.freeze({
    name: "do-soul-alaya",
    version: options.version ?? readRuntimeVersion()
  });
}

export function createAlayaMcpServer(options: AlayaMcpServerOptions): Server {
  const tools = options.tools ?? listAlayaMemoryTools();
  const server = new Server(
    createAlayaMcpServerInfo(options),
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
  options: Pick<AlayaMcpServerOptions, "memoryToolHandler" | "contextProvider" | "warn">,
  toolName: string,
  rawArguments: unknown
): Promise<CallToolResult> {
  let result: Awaited<ReturnType<McpMemoryToolHandler["call"]>>;
  try {
    result = await options.memoryToolHandler.call({
      toolName,
      arguments: rawArguments,
      context: options.contextProvider()
    });
  } catch (error) {
    options.warn?.("MCP memory tool handler rejected", {
      error: error instanceof Error ? error.message : String(error),
      toolName
    });
    const payload = {
      ok: false as const,
      error: {
        code: "INTERNAL" as const,
        message: "Unexpected MCP tool failure"
      }
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload
    };
  }

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
  // inputSchema is a JSON-Schema-derived Record<string, unknown>; the
  // MCP SDK's Tool shape requires the canonical { type: "object", properties,
  // required, additionalProperties } subset, so we shallow-spread the derived
  // JSON Schema rather than re-typing each field.
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
