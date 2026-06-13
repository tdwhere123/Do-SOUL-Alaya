import {
  type ConversationRuntimeContext,
  type ConversationToolCatalog,
  type ToolProvider,
  type ToolProviderToolSpec,
  type ToolSpec,
  type McpServerInfo
} from "@do-soul/alaya-protocol";
import {
  CoreError,
  type ExtensionRegistryService,
  type McpToolDiscoveryService,
  type ToolSpecService
} from "@do-soul/alaya-core";
import {
  executeConversationToolOrThrow,
  registerConversationToolSpecs,
  type ExternalConversationToolExecutor
} from "./tool-runtime.js";
import {
  getBuiltinConversationToolSpecs,
  isBuiltinConversationToolId
} from "./builtin-conversation-tool-specs.js";
import type { DaemonMcpRuntimeRegistry } from "./mcp-runtime-registry.js";
import {
  defaultWarn,
  parseAllowedMcpServerNames,
  readDaemonMcpCatalogEnvironment,
  type DaemonMcpCatalogEnvironmentSnapshot,
  type DaemonMcpCatalogToolEntry,
  type EnvLookup,
  type WarnLogger
} from "./mcp-catalog-parsing.js";

export { parseDaemonMcpServerRuntimeConfigs } from "./mcp-catalog-parsing.js";

type DaemonMcpToolRuntimeExecutor = (input: {
  readonly rawInput: unknown;
  readonly writableRoots: readonly string[];
}) => Promise< unknown>;
type DaemonConversationToolRuntimeCatalog = Readonly<{
  hasTool(toolId: string): boolean;
  executeTool(input: {
    readonly toolId: string;
    readonly rawInput: unknown;
    readonly runtimeContext: Readonly<ConversationRuntimeContext>;
    readonly writableRoots: readonly string[];
  }): Promise< unknown>;
}>;
export interface DaemonMcpCatalog {
  readonly servers: readonly Readonly<McpServerInfo>[];
  refresh(): Promise<void>;
  listAllowedServerNames(): readonly string[];
  listEnrolledToolIds(): readonly string[];
  listServerTools(server: Readonly<McpServerInfo>): Promise<readonly Readonly<ToolProviderToolSpec>[]>;
  hasTool(toolId: string): boolean;
  executeTool(input: {
    readonly toolId: string;
    readonly rawInput: unknown;
    readonly writableRoots: readonly string[];
  }): Promise< unknown>;
}

export function createConversationToolCatalog(
  initialToolSpecs: readonly Readonly<ToolSpec>[] = []
): ConversationToolCatalog {
  let specs = freezeToolSpecs(initialToolSpecs);
  let toolNames = createStringLookup(specs.map((spec) => spec.tool_id));

  return {
    getSpecs() {
      return specs;
    },
    replaceSpecs(nextSpecs) {
      specs = freezeToolSpecs(nextSpecs);
      toolNames = createStringLookup(specs.map((spec) => spec.tool_id));
      return specs;
    },
    hasToolName(toolName) {
      return hasStringLookup(toolNames, toolName);
    }
  };
}

export function createBuiltinConversationToolProvider(
  specs: readonly Readonly<ToolSpec>[],
  now: () => string
): Readonly<ToolProvider> {
  return Object.freeze({
    provider_id: "provider.builtin.conversation_engine",
    name: "Conversation Engine Built-in Tools",
    source: "builtin",
    tool_specs: Object.freeze(
      specs.map((spec) =>
        Object.freeze({
          tool_id: spec.tool_id,
          name: spec.tool_id,
          description: spec.description
        })
      )
    ),
    requires_permission_check: true,
    records_execution: true,
    registered_at: now()
  });
}

export async function syncConversationToolCatalog(input: {
  readonly catalog: ConversationToolCatalog;
  readonly extensionRegistry: Pick<ExtensionRegistryService, "listProviders">;
  readonly toolSpecService: Pick<ToolSpecService, "findById">;
  readonly allowedExternalToolIds?: ReadonlySet<string>;
  readonly warn?: WarnLogger;
}): Promise<void> {
  const warn = input.warn ?? defaultWarn;
  const nextSpecs: ToolSpec[] = [];
  const knownToolIds = new Set<string>();
  const providers = await input.extensionRegistry.listProviders();
  const pendingLookups = new Map<
    string,
    Readonly<{
      readonly providerId: string;
      readonly providerTool: Readonly<ToolProviderToolSpec>;
    }>
  >();

  for (const provider of providers) {
    for (const providerTool of provider.tool_specs) {
      if (
        provider.source === "mcp_external" &&
        input.allowedExternalToolIds !== undefined &&
        !input.allowedExternalToolIds.has(providerTool.tool_id)
      ) {
        continue;
      }

      if (knownToolIds.has(providerTool.tool_id)) {
        continue;
      }
      const existingLookup = pendingLookups.get(providerTool.tool_id);
      if (existingLookup !== undefined) {
        throw new CoreError(
          "CONFLICT",
          `Tool ${providerTool.tool_id} is claimed by both ${existingLookup.providerId} and ${provider.provider_id}.`
        );
      }

      pendingLookups.set(
        providerTool.tool_id,
        Object.freeze({
          providerId: provider.provider_id,
          providerTool
        })
      );
    }
  }

  const resolvedSpecs = await Promise.all(
    [...pendingLookups.values()].map(async (lookup) => {
      try {
        return await input.toolSpecService.findById(lookup.providerTool.tool_id);
      } catch (error) {
        warn("failed to sync extension tool into daemon conversation catalog", {
          providerId: lookup.providerId,
          toolId: lookup.providerTool.tool_id,
          error
        });
        return null;
      }
    })
  );

  for (const spec of resolvedSpecs) {
    if (spec === null || knownToolIds.has(spec.tool_id)) {
      continue;
    }

    knownToolIds.add(spec.tool_id);
    nextSpecs.push(spec);
  }

  input.catalog.replaceSpecs(nextSpecs);
}

export function createDaemonMcpCatalogFromEnv(input: {
  readonly now: () => string;
  readonly runtimeRegistry: DaemonMcpRuntimeRegistry;
  readonly env?: EnvLookup;
  readonly warn?: WarnLogger;
}): DaemonMcpCatalog {
  const warn = input.warn ?? defaultWarn;
  const env = input.env ?? process.env;
  const rawToolCatalog = readDaemonMcpCatalogEnvironment(env, warn).rawToolCatalog;
  const isServerAllowed = (serverName: string): boolean =>
    parseAllowedMcpServerNames(env.ALAYA_ALLOWED_MCP_SERVERS).includes(serverName);
  const readEnvironment = (): DaemonMcpCatalogEnvironmentSnapshot =>
    Object.freeze({
      allowedServerNames: parseAllowedMcpServerNames(env.ALAYA_ALLOWED_MCP_SERVERS),
      rawToolCatalog
    });
  let environment = readEnvironment();
  let state = buildDaemonMcpCatalogState({
    isServerAllowed,
    now: input.now,
    runtimeRegistry: input.runtimeRegistry,
    environment,
    warn
  });
  const refresh = async () => {
    environment = readEnvironment();
    await input.runtimeRegistry.refresh({
      serverNames: environment.allowedServerNames
    });
    state = buildDaemonMcpCatalogState({
      isServerAllowed,
      now: input.now,
      runtimeRegistry: input.runtimeRegistry,
      environment,
      warn
    });
  };

  return {
    refresh,
    get servers() {
      return state.servers;
    },
    listAllowedServerNames() {
      return state.allowedServerNames;
    },
    listEnrolledToolIds() {
      return state.enrolledToolIds;
    },
    async listServerTools(server) {
      return state.toolCatalog.get(server.server_name) ?? [];
    },
    hasTool(toolId) {
      return state.toolAvailability.get(toolId)?.() ?? false;
    },
    async executeTool({ toolId, rawInput, writableRoots }) {
      return await executeExternalMcpTool({
        toolId,
        rawInput,
        toolAvailability: state.toolAvailability,
        writableRoots,
        toolExecutors: state.toolExecutors
      });
    }
  };
}

export async function bootstrapDaemonConversationTooling(input: {
  readonly builtinConversationToolSpecs?: readonly Readonly<ToolSpec>[];
  readonly daemonMcpCatalog?: DaemonMcpCatalog;
  readonly extensionRegistry: Pick<ExtensionRegistryService, "listProviders" | "registerProvider">;
  readonly mcpToolDiscoveryService: Pick<McpToolDiscoveryService, "discoverAndRegister">;
  readonly now: () => string;
  readonly nowMs?: () => number;
  readonly refreshTtlMs?: number;
  readonly runtimeRegistry: DaemonMcpRuntimeRegistry;
  readonly toolSpecService: Pick<ToolSpecService, "findById" | "register" | "update">;
  readonly warn?: WarnLogger;
}): Promise<Readonly<{
  readonly conversationToolCatalog: ConversationToolCatalog;
  readonly daemonMcpCatalog: DaemonMcpCatalog;
  readonly externalConversationToolExecutor: ExternalConversationToolExecutor;
}>> {
  const builtinConversationToolSpecs =
    input.builtinConversationToolSpecs ?? getBuiltinConversationToolSpecs();
  await registerConversationToolSpecs(input.toolSpecService, builtinConversationToolSpecs);

  const conversationToolCatalog = createConversationToolCatalog();
  await input.extensionRegistry.registerProvider(
    createBuiltinConversationToolProvider(builtinConversationToolSpecs, input.now)
  );

  const daemonMcpCatalog =
    input.daemonMcpCatalog ??
    createDaemonMcpCatalogFromEnv({
      now: input.now,
      runtimeRegistry: input.runtimeRegistry,
      warn: input.warn
    });
  const refreshDiscoveredMcpTools = async () => {
    await daemonMcpCatalog.refresh();
    await input.mcpToolDiscoveryService.discoverAndRegister(daemonMcpCatalog.servers);
    await syncConversationToolCatalog({
      allowedExternalToolIds: new Set(daemonMcpCatalog.listEnrolledToolIds()),
      catalog: conversationToolCatalog,
      extensionRegistry: input.extensionRegistry,
      toolSpecService: input.toolSpecService,
      warn: input.warn
    });
  };

  await refreshDiscoveredMcpTools();

  return Object.freeze({
    conversationToolCatalog,
    daemonMcpCatalog,
    externalConversationToolExecutor: createExternalConversationToolExecutor({
      catalog: createDaemonConversationToolRuntimeCatalog({
        conversationToolCatalog,
        daemonMcpCatalog
      }),
      now: input.nowMs,
      refreshTools: refreshDiscoveredMcpTools,
      refreshTtlMs: input.refreshTtlMs,
      warn: input.warn
    })
  });
}

export function createExternalConversationToolExecutor(
  input: {
    readonly catalog: DaemonConversationToolRuntimeCatalog;
    readonly now?: () => number;
    readonly refreshTtlMs?: number;
    readonly refreshTools: () => Promise<void>;
    readonly warn?: WarnLogger;
  }
): ExternalConversationToolExecutor {
  const now = input.now ?? (() => Date.now());
  const refreshTtlMs = input.refreshTtlMs ?? 1_000;
  const warn = input.warn ?? defaultWarn;
  let lastSuccessfulRefreshAt = Number.NEGATIVE_INFINITY;
  let refreshInFlight: Promise<void> | null = null;

  const scheduleRefresh = (): Promise<void> => {
    if (refreshInFlight !== null) {
      return refreshInFlight;
    }

    const currentTime = now();
    if (currentTime - lastSuccessfulRefreshAt < refreshTtlMs) {
      return Promise.resolve();
    }

    refreshInFlight = input.refreshTools()
      .then(() => {
        lastSuccessfulRefreshAt = currentTime;
      })
      .catch((error) => {
        warn("failed to refresh daemon MCP tool discovery", { error });
        throw error;
      })
      .finally(() => {
        refreshInFlight = null;
      });

    return refreshInFlight;
  };

  return {
    hasTool: (toolId) => input.catalog.hasTool(toolId),
    refreshTools: async () => {
      await scheduleRefresh();
    },
    executeTool: async (executionInput) => await input.catalog.executeTool(executionInput)
  };
}

function createDaemonConversationToolRuntimeCatalog(input: {
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

function buildDaemonMcpCatalogState(input: {
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

async function executeExternalMcpTool(input: {
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

function freezeToolSpecs(specs: readonly Readonly<ToolSpec>[]): readonly Readonly<ToolSpec>[] {
  return Object.freeze(specs.map((spec) => Object.freeze({ ...spec })));
}

function createStringLookup(values: readonly string[]): Readonly<Record<string, true>> {
  const lookup: Record<string, true> = {};
  for (const value of dedupeStrings(values)) {
    lookup[value] = true;
  }

  return Object.freeze(lookup);
}

function hasStringLookup(lookup: Readonly<Record<string, true>>, value: string): boolean {
  return Object.hasOwn(lookup, value);
}
