import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, McpServerInfo, ToolProvider } from "@do-soul/alaya-protocol";
import { McpToolDiscoveryService } from "../../tooling/mcp-tool-discovery-service.js";

const validTimestamp = "2026-04-20T10:30:00.000Z";

function createServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    server_name: "filesystem",
    transport_type: "stdio",
    status: "active",
    registered_at: validTimestamp,
    ...overrides
  };
}

describe("McpToolDiscoveryService", () => {
  it("discovers MCP tools, registers providers, and emits extension.tool_discovered", async () => {
    const server = createServer();
    const listServerTools = vi.fn(async () => [
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      },
      {
        tool_id: "mcp__filesystem__write_file",
        name: "filesystem.write_file",
        description: "Write file through filesystem MCP."
      }
    ]);
    const registeredProviders: ToolProvider[] = [];
    const registerProvider = vi.fn(async (provider: ToolProvider) => {
      registeredProviders.push(provider);
      return provider;
    });
    const appendedEntries: EventLogEntry[] = [];
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const persisted = {
        ...entry,
        event_id: `event-${appendedEntries.length + 1}`,
        created_at: validTimestamp,
      revision: 0
      } satisfies EventLogEntry;
      appendedEntries.push(persisted);
      return persisted;
    });
    const notifyEntry = vi.fn(async () => undefined);

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders: vi.fn(async () => registeredProviders)
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp
    });

    const providers = await service.discoverAndRegister([server]);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      provider_id: "provider.mcp.filesystem",
      source: "mcp_external",
      requires_permission_check: true,
      records_execution: true
    });
    expect(providers[0]?.tool_specs).toEqual([
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      },
      {
        tool_id: "mcp__filesystem__write_file",
        name: "filesystem.write_file",
        description: "Write file through filesystem MCP."
      }
    ]);
    expect(listServerTools).toHaveBeenCalledWith(server);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(appendedEntries.map((entry) => entry.event_type)).toEqual([
      "extension.tool_discovered",
      "extension.tool_discovered"
    ]);
    expect(appendedEntries[0]?.payload_json).toMatchObject({
      provider_id: "provider.mcp.filesystem",
      tool_id: "mcp__filesystem__read_file"
    });
    expect(notifyEntry).toHaveBeenCalledTimes(2);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[0] ?? 0
    );
    expect(append.mock.invocationCallOrder[1]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[1] ?? 0
    );
  });

  it("normalizes blank system workspace fallback and discovered_at timestamps via shared helpers", async () => {
    const appendedEntries: EventLogEntry[] = [];
    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider: vi.fn(async (provider: ToolProvider) => provider),
        listProviders: vi.fn(async () => [])
      },
      mcpToolCatalog: {
        listServerTools: vi.fn(async () => [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ])
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          const persisted = {
            ...entry,
            event_id: "event-1",
            created_at: validTimestamp,
          revision: 0
          } satisfies EventLogEntry;
          appendedEntries.push(persisted);
          return persisted;
        })
      },
      defaultWorkspaceId: "   ",
      now: () => "2026-04-20T10:30:00Z"
    });

    await service.discoverAndRegister([createServer()]);

    expect(appendedEntries[0]).toMatchObject({
      workspace_id: "system",
      caused_by: "system",
      payload_json: expect.objectContaining({
        discovered_at: "2026-04-20T10:30:00.000Z"
      })
    });
  });

  it("skips inactive servers and ignores active servers with no tools", async () => {
    const listServerTools = vi.fn(async () => []);
    const registerProvider = vi.fn();
    const append = vi.fn();

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders: vi.fn(async () => [])
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: { append }
    });

    const providers = await service.discoverAndRegister([
      createServer({ server_name: "filesystem", status: "inactive" }),
      createServer({ server_name: "github", status: "active", transport_type: "http", endpoint: "http://127.0.0.1:3040/mcp" })
    ]);

    expect(providers).toEqual([]);
    expect(listServerTools).toHaveBeenCalledTimes(1);
    expect(registerProvider).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("emits extension.tool_discovered only for genuinely new tools across refresh passes", async () => {
    const server = createServer();
    const discoveredToolPasses = [
      [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        }
      ],
      [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        },
        {
          tool_id: "mcp__filesystem__write_file",
          name: "filesystem.write_file",
          description: "Write file through filesystem MCP."
        }
      ]
    ];
    const listServerTools = vi.fn(async () => discoveredToolPasses.shift() ?? []);
    const storedProviders: ToolProvider[] = [];
    const registerProvider = vi.fn(async (provider: ToolProvider) => {
      const existingIndex = storedProviders.findIndex(
        (candidate) => candidate.provider_id === provider.provider_id
      );
      if (existingIndex === -1) {
        storedProviders.push(provider);
      } else {
        storedProviders.splice(existingIndex, 1, provider);
      }
      return provider;
    });
    const appendedEntries: EventLogEntry[] = [];
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const persisted = {
        ...entry,
        event_id: `event-${appendedEntries.length + 1}`,
        created_at: validTimestamp,
      revision: 0
      } satisfies EventLogEntry;
      appendedEntries.push(persisted);
      return persisted;
    });
    const notifyEntry = vi.fn(async () => undefined);

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders: vi.fn(async () => storedProviders)
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp
    });

    await service.discoverAndRegister([server]);
    await service.discoverAndRegister([server]);

    expect(appendedEntries.map((entry) => (entry.payload_json as { readonly tool_id: string }).tool_id)).toEqual([
      "mcp__filesystem__read_file",
      "mcp__filesystem__write_file"
    ]);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[0] ?? 0
    );
    expect(append.mock.invocationCallOrder[1]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[1] ?? 0
    );
  });

  it("suppresses duplicate extension.tool_discovered emission across overlapping discovery passes", async () => {
    const server = createServer();
    const storedProviders: ToolProvider[] = [];
    const listProvidersBarrierResolvers: Array<() => void> = [];
    const listProviders = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        listProvidersBarrierResolvers.push(resolve);
        if (listProvidersBarrierResolvers.length === 2) {
          for (const release of listProvidersBarrierResolvers.splice(0)) {
            release();
          }
        }
      });

      return [...storedProviders];
    });
    const listServerTools = vi.fn(async () => [
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ]);
    const registerProvider = vi.fn(async (provider: ToolProvider) => {
      const existingIndex = storedProviders.findIndex(
        (candidate) => candidate.provider_id === provider.provider_id
      );
      if (existingIndex === -1) {
        storedProviders.push(provider);
      } else {
        storedProviders.splice(existingIndex, 1, provider);
      }

      return provider;
    });
    const appendedEntries: EventLogEntry[] = [];
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const persisted = {
        ...entry,
        event_id: `event-${appendedEntries.length + 1}`,
        created_at: validTimestamp,
      revision: 0
      } satisfies EventLogEntry;
      appendedEntries.push(persisted);
      return persisted;
    });
    const notifyEntry = vi.fn(async () => undefined);

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp
    });

    const firstPass = service.discoverAndRegister([server]);
    const secondPass = service.discoverAndRegister([server]);

    await expect(Promise.all([firstPass, secondPass])).resolves.toHaveLength(2);

    expect(appendedEntries.map((entry) => (entry.payload_json as { readonly tool_id: string }).tool_id)).toEqual([
      "mcp__filesystem__read_file"
    ]);
    expect(notifyEntry).toHaveBeenCalledTimes(1);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("suppresses duplicate extension.tool_discovered emission when a stale overlapping pass reaches emission after the first pass completed", async () => {
    const server = createServer();
    const storedProviders: ToolProvider[] = [];
    const listProvidersBarrierResolvers: Array<() => void> = [];
    const firstAppendCompleted = createDeferred<void>();
    let listServerToolsCallCount = 0;

    const listProviders = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        listProvidersBarrierResolvers.push(resolve);
        if (listProvidersBarrierResolvers.length === 2) {
          for (const release of listProvidersBarrierResolvers.splice(0)) {
            release();
          }
        }
      });

      return [...storedProviders];
    });
    const listServerTools = vi.fn(async () => {
      listServerToolsCallCount += 1;
      if (listServerToolsCallCount === 2) {
        await firstAppendCompleted.promise;
      }

      return [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        }
      ];
    });
    const registerProvider = vi.fn(async (provider: ToolProvider) => {
      const existingIndex = storedProviders.findIndex(
        (candidate) => candidate.provider_id === provider.provider_id
      );
      if (existingIndex === -1) {
        storedProviders.push(provider);
      } else {
        storedProviders.splice(existingIndex, 1, provider);
      }

      return provider;
    });
    const appendedEntries: EventLogEntry[] = [];
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const persisted = {
        ...entry,
        event_id: `event-${appendedEntries.length + 1}`,
        created_at: validTimestamp,
      revision: 0
      } satisfies EventLogEntry;
      appendedEntries.push(persisted);
      firstAppendCompleted.resolve();
      return persisted;
    });
    const notifyEntry = vi.fn(async () => undefined);

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp
    });

    const firstPass = service.discoverAndRegister([server]);
    const secondPass = service.discoverAndRegister([server]);

    await expect(Promise.all([firstPass, secondPass])).resolves.toHaveLength(2);

    expect(appendedEntries.map((entry) => (entry.payload_json as { readonly tool_id: string }).tool_id)).toEqual([
      "mcp__filesystem__read_file"
    ]);
    expect(notifyEntry).toHaveBeenCalledTimes(1);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("makes a zero-tool shrink authoritative before later rediscovery", async () => {
    const server = createServer();
    const discoveredToolPasses = [
      [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        }
      ],
      [],
      [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        }
      ]
    ];
    const listServerTools = vi.fn(async () => discoveredToolPasses.shift() ?? []);
    const storedProviders: ToolProvider[] = [];
    const registerProvider = vi.fn(async (provider: ToolProvider) => {
      const existingIndex = storedProviders.findIndex(
        (candidate) => candidate.provider_id === provider.provider_id
      );
      if (existingIndex === -1) {
        storedProviders.push(provider);
      } else {
        storedProviders.splice(existingIndex, 1, provider);
      }

      return provider;
    });
    const appendedEntries: EventLogEntry[] = [];
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const persisted = {
        ...entry,
        event_id: `event-${appendedEntries.length + 1}`,
        created_at: validTimestamp,
      revision: 0
      } satisfies EventLogEntry;
      appendedEntries.push(persisted);
      return persisted;
    });
    const notifyEntry = vi.fn(async () => undefined);

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders: vi.fn(async () => storedProviders)
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp
    });

    await service.discoverAndRegister([server]);
    await service.discoverAndRegister([server]);

    expect(storedProviders).toEqual([
      expect.objectContaining({
        provider_id: "provider.mcp.filesystem",
        tool_specs: []
      })
    ]);

    await service.discoverAndRegister([server]);

    expect(appendedEntries.map((entry) => (entry.payload_json as { readonly tool_id: string }).tool_id)).toEqual([
      "mcp__filesystem__read_file",
      "mcp__filesystem__read_file"
    ]);
    expect(notifyEntry).toHaveBeenCalledTimes(2);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[0] ?? 0
    );
    expect(append.mock.invocationCallOrder[1]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[1] ?? 0
    );
    expect(registerProvider).toHaveBeenCalledTimes(3);
    expect(storedProviders).toEqual([
      expect.objectContaining({
        provider_id: "provider.mcp.filesystem",
        tool_specs: [
          expect.objectContaining({
            tool_id: "mcp__filesystem__read_file"
          })
        ]
      })
    ]);
  });

  it("discovers active servers in parallel before awaiting any single server response", async () => {
    const filesystemServer = createServer({ server_name: "filesystem" });
    const githubServer = createServer({
      server_name: "github",
      transport_type: "http",
      endpoint: "http://127.0.0.1:3040/mcp"
    });
    let resolveFilesystemTools:
      | ((
          tools: ReadonlyArray<{
            readonly tool_id: string;
            readonly name: string;
            readonly description: string;
          }>
        ) => void)
      | undefined;
    let resolveGithubTools:
      | ((
          tools: ReadonlyArray<{
            readonly tool_id: string;
            readonly name: string;
            readonly description: string;
          }>
        ) => void)
      | undefined;
    const listServerTools = vi.fn(
      async (server: McpServerInfo) =>
        await new Promise<
          ReadonlyArray<{
            readonly tool_id: string;
            readonly name: string;
            readonly description: string;
          }>
        >((resolve) => {
          if (server.server_name === "filesystem") {
            resolveFilesystemTools = resolve;
            return;
          }

          resolveGithubTools = resolve;
        })
    );
    const registerProvider = vi.fn(async (provider: ToolProvider) => provider);

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders: vi.fn(async () => [])
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      now: () => validTimestamp
    });

    const discoveryPromise = service.discoverAndRegister([filesystemServer, githubServer]);

    await Promise.resolve();

    expect(listServerTools).toHaveBeenCalledTimes(2);
    expect(registerProvider).not.toHaveBeenCalled();

    resolveFilesystemTools?.([
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ]);
    resolveGithubTools?.([
      {
        tool_id: "mcp__github__search_repos",
        name: "github.search_repos",
        description: "Search repositories through GitHub MCP."
      }
    ]);

    await expect(discoveryPromise).resolves.toHaveLength(2);
    expect(registerProvider).toHaveBeenCalledTimes(2);
  });
});

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve
  };
}
