import {
  type ConversationRuntimeContext,
  type ConversationToolCatalog,
  type McpServerInfo,
  type ToolProviderToolSpec,
  type ToolSpec
} from "@do-soul/alaya-protocol";
import { executeConversationToolOrThrow } from "./tool-runtime.js";
import { isBuiltinConversationToolId } from "./builtin-conversation-tool-specs.js";
import type { DaemonMcpRuntimeRegistry } from "./mcp-runtime-registry.js";
import type {
  DaemonMcpCatalogEnvironmentSnapshot,
  DaemonMcpCatalogToolEntry,
  WarnLogger
} from "./mcp-catalog-parsing.js";
import type { DaemonMcpCatalog } from "./mcp-catalog.js";

type DaemonMcpToolRuntimeExecutor = (input: {
  readonly rawInput: unknown;
  readonly writableRoots: readonly string[];
}) => Promise< unknown>;

export type DaemonConversationToolRuntimeCatalog = Readonly<{
  hasTool(toolId: string): boolean;
  executeTool(input: {
    readonly toolId: string;
    readonly rawInput: unknown;
    readonly runtimeContext: Readonly<ConversationRuntimeContext>;
    readonly writableRoots: readonly string[];
  }): Promise< unknown>;
}>;

export function createDaemonConversationToolRuntimeCatalog(input: {
  readonly conversationToolCatalog: Pick<ConversationToolCatalog, "hasToolName">;
  readonly daemonMcpCatalog: Pick<DaemonMcpCatalog, "executeTool">;
}): DaemonConversationToolRuntimeCatalog {
  return Object.freeze({
    hasTool: (toolId: string) => input.conversationToolCatalog.hasToolName(toolId),
    executeTool: async (executionInput) => {
      if (!input.conversationToolCatalog.hasToolName(executionInput.toolId)) {
        return {
          ok: false,
          code: "MCP_EXTERNAL_UNBOUND",
          message: `External conversation tool ${executionInput.toolId} is not registered in the daemon catalog.`
        };
      }

      if (isBuiltinConversationToolId(executionInput.toolId)) {
        return await executeConversationToolOrThrow(
          executionInput.toolId,
          executionInput.rawInput,
          executionInput.writableRoots
        );
      }

      return await input.daemonMcpCatalog.executeTool(executionInput);
    }
  });
}

export function buildDaemonMcpCatalogState(input: {
  readonly isServerAllowed: (serverName: string) => boolean;
  readonly now: () => string;
  readonly runtimeRegistry: DaemonMcpRuntimeRegistry;
  readonly environment: DaemonMcpCatalogEnvironmentSnapshot;
  readonly warn: WarnLogger;
}): {
  readonly allowedServerNames: readonly string[];
  readonly enrolledToolIds: readonly string[];
  readonly toolCatalog: ReadonlyMap<string, readonly Readonly<ToolProviderToolSpec>[]>;
  readonly servers: readonly Readonly<McpServerInfo>[];
  readonly toolAvailability: ReadonlyMap<string, () => boolean>;
  readonly toolExecutors: ReadonlyMap<string, DaemonMcpToolRuntimeExecutor>;
} {
  const runtimeServerInfos = input.runtimeRegistry.listServerInfos();
  const runtimeServerInfoByName = new Map(
    runtimeServerInfos.map((server) => [server.server_name, server] as const)
  );
  const serverNames = input.environment.allowedServerNames;
  const servers = Object.freeze(
    serverNames
      .map((serverName) => runtimeServerInfoByName.get(serverName) ?? null)
      .filter((server): server is Readonly<McpServerInfo> => server !== null)
  );
  const executableToolCatalog = new Map<string, readonly Readonly<ToolProviderToolSpec>[]>();
  const toolAvailability = new Map<string, () => boolean>();
  const toolExecutors = new Map<string, DaemonMcpToolRuntimeExecutor>();

  for (const serverName of serverNames) {
    const runtimeServerInfo = runtimeServerInfoByName.get(serverName);
    const tools = resolveDaemonMcpCatalogEntries({
      serverName,
      rawToolCatalog: input.environment.rawToolCatalog,
      runtimeRegistry: input.runtimeRegistry,
      hasLiveRuntimeServer: runtimeServerInfo?.status === "active"
    });
    const executableTools: Readonly<ToolProviderToolSpec>[] = [];
    for (const tool of tools) {
      const executor = createDaemonMcpToolRuntimeExecutor({
        serverName,
        tool,
        runtimeRegistry: input.runtimeRegistry
      });
      if (executor === null) {
        input.warn("skipping MCP tool without daemon runtime binding", {
          serverName,
          toolId: tool.spec.tool_id
        });
        continue;
      }

      executableTools.push(tool.spec);
      toolAvailability.set(
        tool.spec.tool_id,
        () =>
          input.isServerAllowed(serverName) &&
          hasActiveRuntimeServer(input.runtimeRegistry, serverName)
      );
      toolExecutors.set(tool.spec.tool_id, executor);
    }

    executableToolCatalog.set(serverName, Object.freeze(executableTools));
  }

  return {
    allowedServerNames: input.environment.allowedServerNames,
    enrolledToolIds: Object.freeze([...toolExecutors.keys()]),
    toolCatalog: executableToolCatalog,
    servers,
    toolAvailability,
    toolExecutors
  };
}

function resolveDaemonMcpCatalogEntries(input: {
  readonly serverName: string;
  readonly rawToolCatalog: ReadonlyMap<string, readonly DaemonMcpCatalogToolEntry[]>;
  readonly runtimeRegistry: DaemonMcpRuntimeRegistry;
  readonly hasLiveRuntimeServer: boolean;
}): readonly DaemonMcpCatalogToolEntry[] {
  const rawTools = input.rawToolCatalog.get(input.serverName) ?? [];
  if (!input.hasLiveRuntimeServer) {
    return [];
  }

  const liveTools = input.runtimeRegistry.getServerTools(input.serverName);
  if (liveTools.length === 0) {
    return rawTools;
  }

  const rawToolByName = new Map(
    rawTools.map((tool) => [tool.spec.name, tool] as const)
  );
  return Object.freeze(
    liveTools.map((tool) => {
      const override = rawToolByName.get(tool.name);
      if (override !== undefined) {
        return override;
      }

      return Object.freeze({
        spec: Object.freeze({
          tool_id: deriveDaemonMcpToolId(input.serverName, tool.name),
          name: tool.name,
          description: tool.description
        }),
        runtimeBinding: Object.freeze({
          bindingKind: "mcp_tool" as const,
          toolName: tool.name
        })
      });
    })
  );
}

function deriveDaemonMcpToolId(serverName: string, toolName: string): string {
  const rawSuffix = toolName.startsWith(`${serverName}.`)
    ? toolName.slice(serverName.length + 1)
    : toolName;
  const normalizedServer = normalizeDaemonMcpToolIdSegment(serverName);
  const normalizedSuffix = normalizeDaemonMcpToolIdSegment(rawSuffix);
  return `mcp__${normalizedServer}__${normalizedSuffix}`;
}

function normalizeDaemonMcpToolIdSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function createDaemonMcpToolRuntimeExecutor(input: {
  readonly serverName: string;
  readonly tool: Readonly<DaemonMcpCatalogToolEntry>;
  readonly runtimeRegistry: DaemonMcpRuntimeRegistry;
}): DaemonMcpToolRuntimeExecutor | null {
  if (
    input.tool.runtimeBinding !== null &&
    input.tool.runtimeBinding.bindingKind === "builtin_tool"
  ) {
    if (!hasActiveRuntimeServer(input.runtimeRegistry, input.serverName)) {
      return null;
    }
    const binding = input.tool.runtimeBinding;
    return async ({ rawInput, writableRoots }) => {
      const liveTools = await input.runtimeRegistry.listServerTools(input.serverName).catch(() => null);
      if (liveTools === null) {
        return {
          ok: false,
          code: "MCP_EXTERNAL_UNBOUND",
          message: `External MCP tool ${input.tool.spec.tool_id} has no active daemon runtime binding.`
        };
      }

      if (!liveTools.some((tool) => tool.name === input.tool.spec.name)) {
        return {
          ok: false,
          code: "MCP_EXTERNAL_UNBOUND",
          message: `External MCP tool ${input.tool.spec.tool_id} is no longer exposed by daemon runtime server ${input.serverName}.`
        };
      }

      return await executeConversationToolOrThrow(binding.builtinToolId, rawInput, writableRoots);
    };
  }

  const runtimeBinding = input.tool.runtimeBinding;
  if (runtimeBinding !== null && runtimeBinding.bindingKind !== "mcp_tool") {
    return null;
  }

  return async ({ rawInput }) =>
    await input.runtimeRegistry.callTool({
      serverName: input.serverName,
      toolName: runtimeBinding?.toolName ?? input.tool.spec.name,
      input: rawInput
    });
}

export async function executeExternalMcpTool(input: {
  readonly toolId: string;
  readonly rawInput: unknown;
  readonly toolAvailability: ReadonlyMap<string, () => boolean>;
  readonly writableRoots: readonly string[];
  readonly toolExecutors: ReadonlyMap<string, DaemonMcpToolRuntimeExecutor>;
}): Promise< unknown> {
  const availabilityCheck = input.toolAvailability.get(input.toolId);
  const runtimeExecutor = input.toolExecutors.get(input.toolId);
  if (availabilityCheck?.() !== true || runtimeExecutor === undefined) {
    return {
      ok: false,
      code: "MCP_EXTERNAL_UNBOUND",
      message: `External MCP tool ${input.toolId} has no active daemon runtime binding.`
    };
  }

  return await runtimeExecutor({
    rawInput: input.rawInput,
    writableRoots: input.writableRoots
  });
}

function hasActiveRuntimeServer(
  runtimeRegistry: DaemonMcpRuntimeRegistry,
  serverName: string
): boolean {
  return runtimeRegistry
    .listServerInfos()
    .some((server) => server.server_name === serverName && server.status === "active");
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

export function freezeToolSpecs(specs: readonly Readonly<ToolSpec>[]): readonly Readonly<ToolSpec>[] {
  return Object.freeze(specs.map((spec) => Object.freeze({ ...spec })));
}

export function createStringLookup(values: readonly string[]): Readonly<Record<string, true>> {
  const lookup: Record<string, true> = {};
  for (const value of dedupeStrings(values)) {
    lookup[value] = true;
  }

  return Object.freeze(lookup);
}

export function hasStringLookup(lookup: Readonly<Record<string, true>>, value: string): boolean {
  return Object.hasOwn(lookup, value);
}
