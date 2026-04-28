import {
  ExtensionRegistryService,
  McpToolDiscoveryService,
  type ToolSpecService
} from "@do-what/core";
import type { ToolSpec } from "@do-what/protocol";
import {
  bootstrapDaemonConversationTooling,
  createDaemonMcpCatalogFromEnv,
  parseDaemonMcpServerRuntimeConfigs
} from "./mcp-catalog.js";
import { createDaemonMcpRuntimeRegistry } from "./mcp-runtime-registry.js";
import type { WarnLogger } from "./daemon-runtime-helpers.js";

type ExtensionRegistryDeps = ConstructorParameters<typeof ExtensionRegistryService>[0];
type McpToolDiscoveryDeps = ConstructorParameters<typeof McpToolDiscoveryService>[0];
type EventLogWriterPort = ExtensionRegistryDeps["eventLogWriter"];
type SseBroadcasterPort = NonNullable<McpToolDiscoveryDeps["sseBroadcaster"]>;
type ExtensionStorePort = ExtensionRegistryDeps["extensionStore"];
type ExtensionRegistryToolSpecPort = ExtensionRegistryDeps["toolSpecService"];

export async function bootstrapDaemonMcpTooling(input: {
  readonly eventLogRepo: EventLogWriterPort;
  readonly extensionDescriptorRepo: ExtensionStorePort;
  readonly now: () => string;
  readonly nowMs?: () => number;
  readonly sseBroadcaster: SseBroadcasterPort;
  readonly toolSpecService: ExtensionRegistryToolSpecPort &
    Pick<ToolSpecService, "findById" | "register" | "update">;
  readonly warnLogger: WarnLogger;
  readonly builtinConversationToolSpecs?: readonly Readonly<ToolSpec>[];
}) {
  const extensionRegistryService = new ExtensionRegistryService({
    extensionStore: input.extensionDescriptorRepo,
    toolSpecService: input.toolSpecService,
    eventLogWriter: input.eventLogRepo,
    sseBroadcaster: input.sseBroadcaster,
    defaultWorkspaceId: "system"
  });
  const daemonMcpRuntimeRegistry = createDaemonMcpRuntimeRegistry({
    serverConfigs: parseDaemonMcpServerRuntimeConfigs(
      process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON,
      input.warnLogger.warn
    ),
    now: input.now,
    warn: input.warnLogger.warn
  });
  const daemonMcpCatalog = createDaemonMcpCatalogFromEnv({
    now: input.now,
    runtimeRegistry: daemonMcpRuntimeRegistry,
    warn: input.warnLogger.warn
  });
  const mcpToolDiscoveryService = new McpToolDiscoveryService({
    extensionRegistry: extensionRegistryService,
    mcpToolCatalog: daemonMcpCatalog,
    eventLogWriter: input.eventLogRepo,
    sseBroadcaster: input.sseBroadcaster,
    defaultWorkspaceId: "system"
  });
  const daemonConversationTooling = await bootstrapDaemonConversationTooling({
    builtinConversationToolSpecs: input.builtinConversationToolSpecs,
    daemonMcpCatalog,
    extensionRegistry: extensionRegistryService,
    mcpToolDiscoveryService,
    now: input.now,
    nowMs: input.nowMs,
    runtimeRegistry: daemonMcpRuntimeRegistry,
    toolSpecService: input.toolSpecService,
    warn: input.warnLogger.warn
  });

  return Object.freeze({
    daemonMcpRuntimeRegistry,
    daemonMcpCatalog,
    extensionRegistryService,
    conversationToolCatalog: daemonConversationTooling.conversationToolCatalog,
    externalConversationToolExecutor: daemonConversationTooling.externalConversationToolExecutor
  });
}
