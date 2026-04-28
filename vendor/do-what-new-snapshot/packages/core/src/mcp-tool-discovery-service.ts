import {
  ExtensionToolDiscoveredPayloadSchema,
  McpServerInfoSchema,
  PhaseCEventType,
  ToolProviderToolSpecSchema,
  type EventLogEntry,
  type McpServerInfo,
  type ToolProviderToolSpec,
  type ToolProvider
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { SYSTEM_ACTOR, resolveSystemWorkspaceId } from "./shared/actors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseExtensionToolProvider } from "./shared/extension-descriptor-parsers.js";
import { readNow } from "./shared/time.js";

type McpDiscoveredTool = ToolProviderToolSpec;

export interface McpToolCatalogPort {
  listServerTools(server: Readonly<McpServerInfo>): Promise<readonly Readonly<McpDiscoveredTool>[]>;
}

export interface McpToolDiscoveryDependencies {
  readonly extensionRegistry: {
    registerProvider(provider: ToolProvider): Promise<Readonly<ToolProvider>>;
    listProviders(): Promise<readonly Readonly<ToolProvider>[]>;
  };
  readonly mcpToolCatalog: McpToolCatalogPort;
  readonly eventLogWriter: {
    append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  };
  readonly sseBroadcaster?: {
    broadcastEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly now?: () => string;
  readonly defaultWorkspaceId?: string;
}

export class McpToolDiscoveryService {
  private readonly inFlightDiscoveryEvents = new Map<string, Promise<void>>();
  private readonly knownToolIds = new Set<string>();
  private readonly providerToolIds = new Map<string, ReadonlySet<string>>();

  public constructor(private readonly deps: McpToolDiscoveryDependencies) {}

  public async discoverAndRegister(
    mcpServers: readonly McpServerInfo[]
  ): Promise<readonly Readonly<ToolProvider>[]> {
    this.seedKnownTools(await this.deps.extensionRegistry.listProviders());
    const activeServers = mcpServers
      .map((rawServer) => parseMcpServerInfo(rawServer))
      .filter((server) => server.status === "active");

    const discoveredProviders = await Promise.all(
      activeServers.map(async (server) => {
        const providerId = providerIdForServer(server.server_name);
        const hadKnownProvider = this.providerToolIds.has(providerId);
        const previouslyKnownToolIds = this.providerToolIds.get(providerId) ?? EMPTY_TOOL_IDS;
        const discoveredTools = dedupeDiscoveredTools(
          (await this.deps.mcpToolCatalog.listServerTools(server)).map((tool) =>
            parseDiscoveredTool(tool)
          )
        );
        if (discoveredTools.length === 0) {
          if (hadKnownProvider) {
            await this.deps.extensionRegistry.registerProvider(
              createDiscoveredProvider(server, providerId, [], this.deps.now)
            );
          }
          this.replaceProviderTools(providerId, []);
          return null;
        }

        return {
          previouslyKnownToolIds,
          storedProvider: await this.deps.extensionRegistry.registerProvider(
            createDiscoveredProvider(server, providerId, discoveredTools, this.deps.now)
          )
        };
      })
    );

    const providers: ToolProvider[] = [];
    for (const discoveryResult of discoveredProviders) {
      if (discoveryResult === null) {
        continue;
      }

      const { storedProvider, previouslyKnownToolIds } = discoveryResult;

      providers.push(storedProvider);

      for (const tool of storedProvider.tool_specs) {
        if (previouslyKnownToolIds.has(tool.tool_id)) {
          continue;
        }

        await this.emitToolDiscoveredEventOnce(storedProvider, tool.tool_id, tool.name);
      }

      this.replaceProviderTools(
        storedProvider.provider_id,
        storedProvider.tool_specs.map((tool) => tool.tool_id)
      );
    }

    return Object.freeze(providers);
  }

  private async emitToolDiscoveredEventOnce(
    provider: Readonly<ToolProvider>,
    toolId: string,
    toolName: string
  ): Promise<void> {
    if (this.knownToolIds.has(toolId)) {
      return;
    }

    const inFlightEvent = this.inFlightDiscoveryEvents.get(toolId);
    if (inFlightEvent !== undefined) {
      await inFlightEvent;
      return;
    }

    let emissionPromise: Promise<void> | undefined;
    emissionPromise = this.emitToolDiscoveredEvent(provider, toolId, toolName)
      .then(() => {
        this.knownToolIds.add(toolId);
      })
      .finally(() => {
        if (this.inFlightDiscoveryEvents.get(toolId) === emissionPromise) {
          this.inFlightDiscoveryEvents.delete(toolId);
        }
      });
    this.inFlightDiscoveryEvents.set(toolId, emissionPromise);
    await emissionPromise;
  }

  private async emitToolDiscoveredEvent(
    provider: Readonly<ToolProvider>,
    toolId: string,
    toolName: string
  ): Promise<void> {
    const payload = deepFreeze(
      ExtensionToolDiscoveredPayloadSchema.parse({
        provider_id: provider.provider_id,
        tool_id: toolId,
        tool_name: toolName,
        source: provider.source,
        discovered_at: readNow(this.deps.now)
      })
    );
    const entry = await this.deps.eventLogWriter.append({
      event_type: PhaseCEventType.EXTENSION_TOOL_DISCOVERED,
      entity_type: "extension_provider",
      entity_id: provider.provider_id,
      workspace_id: resolveSystemWorkspaceId(this.deps.defaultWorkspaceId),
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      revision: 0,
      payload_json: payload
    });
    await this.deps.sseBroadcaster?.broadcastEntry(entry);
  }

  private seedKnownTools(providers: readonly Readonly<ToolProvider>[]): void {
    let didSeed = false;

    for (const provider of providers) {
      if (this.providerToolIds.has(provider.provider_id)) {
        continue;
      }

      this.providerToolIds.set(
        provider.provider_id,
        new Set(provider.tool_specs.map((tool) => tool.tool_id))
      );
      didSeed = true;
    }

    if (didSeed) {
      this.rebuildKnownToolIds();
    }
  }

  private replaceProviderTools(providerId: string, toolIds: readonly string[]): void {
    this.providerToolIds.set(providerId, new Set(toolIds));
    this.rebuildKnownToolIds();
  }

  private rebuildKnownToolIds(): void {
    this.knownToolIds.clear();

    for (const toolIds of this.providerToolIds.values()) {
      for (const toolId of toolIds) {
        this.knownToolIds.add(toolId);
      }
    }
  }
}

const EMPTY_TOOL_IDS = Object.freeze(new Set<string>());

function providerIdForServer(serverName: string): string {
  return `provider.mcp.${serverName}`;
}

function createDiscoveredProvider(
  server: Readonly<McpServerInfo>,
  providerId: string,
  discoveredTools: readonly Readonly<McpDiscoveredTool>[],
  now: McpToolDiscoveryDependencies["now"]
): Readonly<ToolProvider> {
  return parseExtensionToolProvider({
    provider_id: providerId,
    name: `${server.server_name} MCP Provider`,
    source: "mcp_external",
    tool_specs: discoveredTools.map((tool) => ({
      tool_id: tool.tool_id,
      name: tool.name,
      description: tool.description
    })),
    requires_permission_check: true,
    records_execution: true,
    registered_at: readNow(now)
  });
}

function parseMcpServerInfo(value: McpServerInfo): Readonly<McpServerInfo> {
  try {
    return deepFreeze(McpServerInfoSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid MCP server info payload", { cause: error });
  }
}

function parseDiscoveredTool(value: McpDiscoveredTool): Readonly<McpDiscoveredTool> {
  try {
    return deepFreeze(ToolProviderToolSpecSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid MCP discovered tool payload", { cause: error });
  }
}

function dedupeDiscoveredTools(
  tools: readonly Readonly<McpDiscoveredTool>[]
): readonly Readonly<McpDiscoveredTool>[] {
  const uniqueTools = new Map<string, Readonly<McpDiscoveredTool>>();

  for (const tool of tools) {
    if (!uniqueTools.has(tool.tool_id)) {
      uniqueTools.set(tool.tool_id, tool);
    }
  }

  return Object.freeze([...uniqueTools.values()]);
}
