import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CoreError,
  ExtensionRegistryService,
  McpToolDiscoveryService,
  ToolSpecService
} from "@do-soul/alaya-core";

import {
  RuntimeGovernanceEventType,
  type McpServerInfo,
  type ToolProvider,
  type ToolProviderToolSpec,
  type ToolSpec
} from "@do-soul/alaya-protocol";

import {
  bootstrapDaemonConversationTooling,
  createDaemonMcpCatalogFromEnv,
  createConversationToolCatalog,
  syncConversationToolCatalog
} from "../../mcp/mcp-catalog.js";

import {
  SqliteEventLogRepo,
  SqliteExtensionDescriptorRepo,
  SqliteToolSpecRepo,
  initDatabase
} from "@do-soul/alaya-storage";

import { createRuntimeNotifier } from "../../runtime/runtime-notifier.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createProvider(
  providerId: string,
  toolSpecs: readonly Readonly<{ readonly tool_id: string; readonly name: string; readonly description: string; }>[]
): ToolProvider {
  return {
    provider_id: providerId,
    name: providerId,
    source: "mcp_external",
    tool_specs: toolSpecs,
    requires_permission_check: true,
    records_execution: true,
    registered_at: "2026-04-21T00:00:00.000Z"
  };
}

function createProviderTool(toolId: string) {
  return {
    tool_id: toolId,
    name: toolId,
    description: `Provider tool ${toolId}`
  } as const;
}

function createToolSpec(toolId: string): ToolSpec {
  return {
    tool_id: toolId,
    category: toolId === "tools.read_file" ? "read" : "exec",
    description: `Spec for ${toolId}`,
    scope_guard: toolId === "tools.read_file" ? "workspace" : "project",
    read_only: toolId === "tools.read_file",
    destructive: false,
    concurrency_safe: toolId === "tools.read_file",
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: toolId === "tools.read_file"
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("daemon conversation tool catalog", () => {

  it("appends and broadcasts extension.tool_discovered on the daemon bootstrap discovery path", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);

    const toolSpecService = new ToolSpecService({
      toolSpecRepo: new SqliteToolSpecRepo(database)
    });
    const eventLogRepo = new SqliteEventLogRepo(database);
    const runtimeNotifier = createRuntimeNotifier();
    const notifyEntrySpy = vi.spyOn(runtimeNotifier, "notifyEntry");
    const extensionRegistry = new ExtensionRegistryService({
      extensionStore: new SqliteExtensionDescriptorRepo(database),
      toolSpecService,
      eventLogWriter: eventLogRepo,
      runtimeNotifier,
      defaultWorkspaceId: "system"
    });
    const server: McpServerInfo = {
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: "2026-04-21T00:00:00.000Z"
    };
    const discoveredTool: ToolProviderToolSpec = {
      tool_id: "mcp__filesystem__read_file",
      name: "filesystem.read_file",
      description: "Read file through filesystem MCP."
    };
    const daemonMcpCatalog = {
      servers: [server] as const,
      refresh: vi.fn(async () => undefined),
      listAllowedServerNames: vi.fn(() => ["filesystem"]),
      listEnrolledToolIds: vi.fn(() => [discoveredTool.tool_id]),
      listServerTools: vi.fn(async () => [discoveredTool]),
      hasTool: vi.fn(() => true),
      executeTool: vi.fn(async () => ({ ok: true }))
    };
    const mcpToolDiscoveryService = new McpToolDiscoveryService({
      extensionRegistry,
      mcpToolCatalog: daemonMcpCatalog,
      eventLogWriter: eventLogRepo,
      runtimeNotifier,
      now: () => "2026-04-21T00:00:00.000Z",
      defaultWorkspaceId: "system"
    });
    const tooling = await bootstrapDaemonConversationTooling({
      now: () => "2026-04-21T00:00:00.000Z",
      daemonMcpCatalog,
      extensionRegistry,
      mcpToolDiscoveryService,
      runtimeRegistry: {
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined),
        getServerTools: vi.fn(() => []),
        listServerInfos: vi.fn(() => []),
        listServerTools: vi.fn(async () => []),
        refresh: vi.fn(async () => undefined)
      },
      toolSpecService
    });

    await waitForCondition(() =>
      notifyEntrySpy.mock.calls.some(
        ([entry]) => entry.event_type === RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED
      )
    );

    await expect(eventLogRepo.queryByType(RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED)).resolves.toEqual([
      expect.objectContaining({
        workspace_id: "system",
        entity_type: "extension_provider",
        entity_id: "provider.mcp.filesystem",
        payload_json: expect.objectContaining({
          tool_id: discoveredTool.tool_id,
          tool_name: discoveredTool.name,
          source: "mcp_external"
        })
      })
    ]);
    expect(tooling.conversationToolCatalog.getSpecs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_id: discoveredTool.tool_id
        })
      ])
    );
    expect(notifyEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED
      })
    );
  });
});
