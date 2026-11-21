import {
  type McpServerInfo,
  type ToolProviderToolSpec,
  type ToolSpec
} from "@do-soul/alaya-protocol";
import {
  MCP_EXTERNAL_ERROR_MESSAGES,
  type DaemonMcpListFailureCode,
  type DaemonMcpRuntimeHealth,
  type DaemonMcpRuntimeRegistry
} from "./mcp-runtime-registry.js";
import type {
  DaemonMcpCatalogEnvironmentSnapshot,
  DaemonMcpCatalogToolEntry,
  WarnLogger
} from "./mcp-catalog-parsing.js";
type DaemonMcpToolRuntimeExecutor = (input: {
  readonly rawInput: unknown;
  readonly writableRoots: readonly string[];
  readonly abortSignal?: AbortSignal;
}) => Promise< unknown>;

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
  readonly toolServerNames: ReadonlyMap<string, string>;
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
  const toolServerNames = new Map<string, string>();

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
      const toolName = tool.runtimeToolName;
      if (toolName === null) {
        input.warn("skipping MCP tool without daemon runtime binding", {
          serverName,
          toolId: tool.spec.tool_id
        });
        continue;
      }

      executableTools.push(tool.spec);
      toolServerNames.set(tool.spec.tool_id, serverName);
      toolAvailability.set(
        tool.spec.tool_id,
        () =>
          input.isServerAllowed(serverName) &&
          hasActiveRuntimeServer(input.runtimeRegistry, serverName)
      );
      toolExecutors.set(tool.spec.tool_id, ({ rawInput }) =>
        input.runtimeRegistry.callTool({ serverName, toolName, input: rawInput }));
    }

    executableToolCatalog.set(serverName, Object.freeze(executableTools));
  }

  return {
    allowedServerNames: input.environment.allowedServerNames,
    enrolledToolIds: Object.freeze([...toolExecutors.keys()]),
    toolCatalog: executableToolCatalog,
    servers,
    toolAvailability,
    toolExecutors,
    toolServerNames
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
        runtimeToolName: tool.name
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

export async function executeExternalMcpTool(input: {
  readonly toolId: string;
  readonly rawInput: unknown;
  readonly toolAvailability: ReadonlyMap<string, () => boolean>;
  readonly writableRoots: readonly string[];
  readonly abortSignal?: AbortSignal;
  readonly toolExecutors: ReadonlyMap<string, DaemonMcpToolRuntimeExecutor>;
  readonly readLastError?: (toolId: string) => Readonly<{
    readonly code: DaemonMcpListFailureCode;
    readonly message: string;
  }> | null;
}): Promise< unknown> {
  const availabilityCheck = input.toolAvailability.get(input.toolId);
  const runtimeExecutor = input.toolExecutors.get(input.toolId);
  if (availabilityCheck?.() !== true || runtimeExecutor === undefined) {
    const lastError = input.readLastError?.(input.toolId) ?? null;
    if (lastError !== null) {
      return {
        ok: false,
        code: lastError.code,
        message: MCP_EXTERNAL_ERROR_MESSAGES[lastError.code]
      };
    }
    return {
      ok: false,
      code: "MCP_EXTERNAL_UNBOUND",
      message: `External MCP tool ${input.toolId} has no active daemon runtime binding.`
    };
  }

  return await runtimeExecutor({
    rawInput: input.rawInput,
    writableRoots: input.writableRoots,
    abortSignal: input.abortSignal
  });
}

export function readCatalogToolLastError(
  runtimeRegistry: Partial<Pick<DaemonMcpRuntimeRegistry, "getHealth">>,
  serverName: string | undefined
): Readonly<{ readonly code: DaemonMcpListFailureCode; readonly message: string }> | null {
  if (serverName === undefined || typeof runtimeRegistry.getHealth !== "function") {
    return null;
  }
  return runtimeRegistry.getHealth().servers.find((server) => server.server_name === serverName)
    ?.last_error ?? null;
}

export function readDaemonMcpCatalogHealth(
  runtimeRegistry: Pick<DaemonMcpRuntimeRegistry, "listServerInfos"> &
    Partial<Pick<DaemonMcpRuntimeRegistry, "getHealth">>
): DaemonMcpRuntimeHealth {
  if (typeof runtimeRegistry.getHealth === "function") {
    return runtimeRegistry.getHealth();
  }
  return Object.freeze({
    servers: Object.freeze(
      runtimeRegistry.listServerInfos().map((server) =>
        Object.freeze({
          server_name: server.server_name,
          status: server.status === "active" ? "active" as const : "inactive" as const,
          last_error: null
        })
      )
    )
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
