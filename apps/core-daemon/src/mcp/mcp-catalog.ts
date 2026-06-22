import {
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
import { registerConversationToolSpecs, type ExternalConversationToolExecutor } from "./tool-runtime.js";
import { getBuiltinConversationToolSpecs } from "./builtin-conversation-tool-specs.js";
import type { DaemonMcpRuntimeRegistry } from "./mcp-runtime-registry.js";
import {
  defaultWarn,
  parseAllowedMcpServerNames,
  readDaemonMcpCatalogEnvironment,
  type DaemonMcpCatalogEnvironmentSnapshot,
  type EnvLookup,
  type WarnLogger
} from "./mcp-catalog-parsing.js";
import {
  buildDaemonMcpCatalogState,
  createDaemonConversationToolRuntimeCatalog,
  createStringLookup,
  executeExternalMcpTool,
  freezeToolSpecs,
  hasStringLookup,
  type DaemonConversationToolRuntimeCatalog
} from "./mcp-catalog-runtime.js";

export { parseDaemonMcpServerRuntimeConfigs } from "./mcp-catalog-parsing.js";

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

type ProviderToolLookup = Readonly<{
  readonly providerId: string;
  readonly providerTool: Readonly<ToolProviderToolSpec>;
}>;

export async function syncConversationToolCatalog(input: {
  readonly catalog: ConversationToolCatalog;
  readonly extensionRegistry: Pick<ExtensionRegistryService, "listProviders">;
  readonly toolSpecService: Pick<ToolSpecService, "findById">;
  readonly allowedExternalToolIds?: ReadonlySet<string>;
  readonly warn?: WarnLogger;
}): Promise<void> {
  const providers = await input.extensionRegistry.listProviders();
  const pendingLookups = collectProviderToolLookups(providers, input.allowedExternalToolIds);
  const nextSpecs = await resolveUniqueToolSpecs(
    pendingLookups,
    input.toolSpecService,
    input.warn ?? defaultWarn
  );
  input.catalog.replaceSpecs(nextSpecs);
}

function collectProviderToolLookups(
  providers: readonly ToolProvider[],
  allowedExternalToolIds: ReadonlySet<string> | undefined
): ReadonlyMap<string, ProviderToolLookup> {
  const pendingLookups = new Map<string, ProviderToolLookup>();
  for (const provider of providers) {
    for (const providerTool of provider.tool_specs) {
      if (
        provider.source === "mcp_external" &&
        allowedExternalToolIds !== undefined &&
        !allowedExternalToolIds.has(providerTool.tool_id)
      ) {
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
        Object.freeze({ providerId: provider.provider_id, providerTool })
      );
    }
  }
  return pendingLookups;
}

async function resolveUniqueToolSpecs(
  pendingLookups: ReadonlyMap<string, ProviderToolLookup>,
  toolSpecService: Pick<ToolSpecService, "findById">,
  warn: WarnLogger
): Promise<ToolSpec[]> {
  const resolvedSpecs = await Promise.all(
    [...pendingLookups.values()].map(async (lookup) => {
      try {
        return await toolSpecService.findById(lookup.providerTool.tool_id);
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

  const nextSpecs: ToolSpec[] = [];
  const knownToolIds = new Set<string>();
  for (const spec of resolvedSpecs) {
    if (spec === null || knownToolIds.has(spec.tool_id)) {
      continue;
    }
    knownToolIds.add(spec.tool_id);
    nextSpecs.push(spec);
  }
  return nextSpecs;
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
