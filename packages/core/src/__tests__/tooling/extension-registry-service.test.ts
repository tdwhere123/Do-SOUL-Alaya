import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../../errors.js";
import { ExtensionRegistryService } from "../../tooling/extension-registry-service.js";

const validTimestamp = "2026-04-20T10:00:00.000Z";

function createProvider(overrides: Partial<ToolProvider> = {}): ToolProvider {
  return {
    provider_id: "provider.mcp.filesystem",
    name: "Filesystem MCP Provider",
    source: "mcp_external",
    tool_specs: [
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ],
    requires_permission_check: true,
    records_execution: true,
    registered_at: validTimestamp,
    ...overrides
  };
}

function createExternalToolSpec(provider: ToolProvider, toolId: string): ToolSpec {
  return {
    tool_id: toolId,
    category: "exec",
    description: provider.tool_specs.find((toolSpec) => toolSpec.tool_id === toolId)?.description ?? "External MCP tool",
    scope_guard: "project",
    read_only: false,
    destructive: false,
    concurrency_safe: false,
    interrupt_behavior: "wait",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: false
  };
}

function createRegistryHarness(input: {
  readonly initialProviders?: readonly ToolProvider[];
  readonly initialToolSpecs?: readonly ToolSpec[];
  readonly failRegisterAt?: number;
  readonly failUpdateAt?: number;
  readonly failDeleteToolProvider?: boolean;
}) {
  const providerStore = new Map(
    (input.initialProviders ?? []).map((provider) => [provider.provider_id, provider] as const)
  );
  const toolSpecStore = new Map(
    (input.initialToolSpecs ?? []).map((spec) => [spec.tool_id, spec] as const)
  );
  const appendedEvents: EventLogEntry[] = [];
  let registerCount = 0;
  let updateCount = 0;

  const registerToolProvider = vi.fn(async (provider: ToolProvider) => {
    providerStore.set(provider.provider_id, provider);
    return provider;
  });
  const deleteToolProvider = vi.fn(async (providerId: string) => {
    if (input.failDeleteToolProvider === true) {
      throw new Error(`delete provider failed for ${providerId}`);
    }
    providerStore.delete(providerId);
  });
  const findToolProviders = vi.fn(async () => [...providerStore.values()]);
  const findToolProviderById = vi.fn(
    async (providerId: string) => providerStore.get(providerId) ?? null
  );
  const findById = vi.fn(async (toolId: string) => {
    const spec = toolSpecStore.get(toolId);
    if (spec === undefined) {
      throw new CoreError("NOT_FOUND", "Tool spec missing");
    }
    return spec;
  });
  const register = vi.fn(async (spec: ToolSpec) => {
    registerCount += 1;
    if (input.failRegisterAt === registerCount) {
      throw new Error(`register failed for ${spec.tool_id}`);
    }
    toolSpecStore.set(spec.tool_id, spec);
    return spec;
  });
  const update = vi.fn(async (spec: ToolSpec) => {
    updateCount += 1;
    if (input.failUpdateAt === updateCount) {
      throw new Error(`update failed for ${spec.tool_id}`);
    }
    toolSpecStore.set(spec.tool_id, spec);
    return spec;
  });
  const deleteToolSpec = vi.fn(async (toolId: string) => {
    toolSpecStore.delete(toolId);
  });
  const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    const persisted = {
      ...entry,
      event_id: `event-${appendedEvents.length + 1}`,
      created_at: validTimestamp,
      revision: appendedEvents.length
    } satisfies EventLogEntry;
    appendedEvents.push(persisted);
    return persisted;
  });
  const notifyEntry = vi.fn(async () => undefined);

  const service = new ExtensionRegistryService({
    extensionStore: {
      registerToolProvider,
      deleteToolProvider,
      registerSkillPackage: vi.fn(),
      findToolProviders,
      findToolProviderById
    },
    toolSpecService: {
      findById,
      register,
      update,
      delete: deleteToolSpec
    },
    eventLogWriter: { append },
    runtimeNotifier: {
      notifyEntry
    },
    now: () => validTimestamp,
    buildToolSpecForProviderTool: (provider, tool) => createExternalToolSpec(provider, tool.tool_id)
  });

  return {
    service,
    providerStore,
    toolSpecStore,
    registerToolProvider,
    deleteToolProvider,
    registerToolSpec: register,
    updateToolSpec: update,
    deleteToolSpec,
    append,
    notifyEntry,
    appendedEvents
  };
}

describe("ExtensionRegistryService", () => {
  it("registers providers, syncs tool specs, and emits extension.descriptor_registered", async () => {
    const provider = createProvider();
    const registerToolProvider = vi.fn(async (value: ToolProvider) => value);
    const findById = vi.fn(async () => {
      throw new CoreError("NOT_FOUND", "Tool spec missing");
    });
    const register = vi.fn(async (spec: ToolSpec) => spec);
    const update = vi.fn(async (spec: ToolSpec) => spec);
    const appendedEvents: EventLogEntry[] = [];
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      const persisted = {
        ...entry,
        event_id: `event-${appendedEvents.length + 1}`,
        created_at: validTimestamp,
      revision: 0
      } satisfies EventLogEntry;
      appendedEvents.push(persisted);
      return persisted;
    });
    const notifyEntry = vi.fn(async () => undefined);

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider,
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => [provider]),
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById,
        register,
        update,
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp,
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    const result = await service.registerProvider(provider);

    expect(result).toEqual(provider);
    expect(registerToolProvider).toHaveBeenCalledWith(provider);
    expect(findById).toHaveBeenCalledWith("mcp__filesystem__read_file");
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "mcp__filesystem__read_file" })
    );
    expect(update).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "extension.descriptor_registered",
        entity_type: "extension_descriptor",
        entity_id: provider.provider_id
      })
    );
    expect(appendedEvents[0]?.payload_json).toMatchObject({
      descriptor_type: "tool_provider",
      descriptor_id: provider.provider_id,
      source: provider.source
    });
    expect(notifyEntry).toHaveBeenCalledTimes(1);
    expect(notifyEntry).toHaveBeenCalledWith(appendedEvents[0]);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      notifyEntry.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("normalizes blank system workspace fallback and registered_at timestamps via shared helpers", async () => {
    const provider = createProvider();
    const appendedEvents: EventLogEntry[] = [];
    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async (value: ToolProvider) => value),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => []),
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Tool spec missing");
        }),
        register: vi.fn(async (spec: ToolSpec) => spec),
        update: vi.fn(async (spec: ToolSpec) => spec),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          const persisted = {
            ...entry,
            event_id: "event-1",
            created_at: validTimestamp,
          revision: 0
          } satisfies EventLogEntry;
          appendedEvents.push(persisted);
          return persisted;
        })
      },
      defaultWorkspaceId: "   ",
      now: () => "2026-04-20T10:00:00Z",
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    await service.registerProvider(provider);

    expect(appendedEvents[0]).toMatchObject({
      workspace_id: "system",
      caused_by: "system",
      payload_json: expect.objectContaining({
        registered_at: "2026-04-20T10:00:00.000Z"
      })
    });
  });

  it("does not let a stale provider cache load overwrite a newer registered provider", async () => {
    const oldProvider = createProvider({
      provider_id: "provider.mcp.old",
      name: "Old Filesystem MCP Provider",
      tool_specs: [
        {
          tool_id: "mcp__filesystem__old_read_file",
          name: "filesystem.old_read_file",
          description: "Old filesystem MCP tool."
        }
      ]
    });
    const newProvider = createProvider({
      provider_id: "provider.mcp.new",
      name: "New Filesystem MCP Provider",
      tool_specs: [
        {
          tool_id: "mcp__filesystem__new_read_file",
          name: "filesystem.new_read_file",
          description: "New filesystem MCP tool."
        }
      ]
    });
    const staleLoad = createDeferred<readonly ToolProvider[]>();
    const appendedEvents: EventLogEntry[] = [];
    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async (provider: ToolProvider) => provider),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => await staleLoad.promise),
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Tool spec missing");
        }),
        register: vi.fn(async (spec: ToolSpec) => spec),
        update: vi.fn(async (spec: ToolSpec) => spec),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          const persisted = {
            ...entry,
            event_id: `event-${appendedEvents.length + 1}`,
            created_at: validTimestamp,
          revision: 0
          } satisfies EventLogEntry;
          appendedEvents.push(persisted);
          return persisted;
        })
      },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      now: () => validTimestamp,
      buildToolSpecForProviderTool: (provider, tool) =>
        createExternalToolSpec(provider, tool.tool_id)
    });

    const pendingList = service.listProviders();
    await Promise.resolve();

    await service.registerProvider(newProvider);
    staleLoad.resolve([oldProvider]);
    await pendingList;

    const providers = await service.listProviders();
    const resolvedProvider = await service.findProviderForTool("mcp__filesystem__new_read_file");

    expect(providers.map((provider) => provider.provider_id)).toContain("provider.mcp.new");
    expect(resolvedProvider?.provider_id).toBe("provider.mcp.new");
  });

  it("merges a cold-start provider registration against the store baseline before the first read", async () => {
    const storedProvider = createProvider({
      provider_id: "provider.mcp.persisted",
      name: "Persisted Provider",
      tool_specs: [
        {
          tool_id: "mcp__filesystem__persisted_read_file",
          name: "filesystem.persisted_read_file",
          description: "Persisted filesystem tool."
        }
      ]
    });
    const builtinProvider = createProvider({
      provider_id: "provider.builtin.conversation_engine",
      name: "Conversation Engine Built-in Tools",
      source: "builtin",
      tool_specs: [
        {
          tool_id: "tools.read_file",
          name: "tools.read_file",
          description: "Read file"
        }
      ]
    });
    const harness = createRegistryHarness({
      initialProviders: [storedProvider]
    });

    await harness.service.registerProvider(builtinProvider);

    await expect(harness.service.listProviders()).resolves.toEqual([
      builtinProvider,
      storedProvider
    ]);
    await expect(
      harness.service.findProviderForTool("mcp__filesystem__persisted_read_file")
    ).resolves.toEqual(storedProvider);
  });

  it("clears the pending cache load after a store read failure so a later read can recover", async () => {
    const provider = createProvider();
    const findToolProviders = vi
      .fn()
      .mockRejectedValueOnce(new Error("store offline"))
      .mockResolvedValueOnce([provider]);
    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async (value: ToolProvider) => value),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders,
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Tool spec missing");
        }),
        register: vi.fn(async (spec: ToolSpec) => spec),
        update: vi.fn(async (spec: ToolSpec) => spec),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      now: () => validTimestamp,
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    await expect(service.listProviders()).rejects.toThrow("store offline");
    await expect(service.listProviders()).resolves.toEqual([provider]);
    expect(findToolProviders).toHaveBeenCalledTimes(2);
  });

  it("updates existing tool specs and resolves provider lookup from the refreshed registry state", async () => {
    const provider = createProvider();
    const existingToolSpec = createExternalToolSpec(provider, "mcp__filesystem__read_file");
    const register = vi.fn();
    const update = vi.fn(async (spec: ToolSpec) => spec);

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async (value: ToolProvider) => value),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => [provider]),
        findToolProviderById: vi.fn(async () => provider)
      },
      toolSpecService: {
        findById: vi.fn(async () => existingToolSpec),
        register,
        update,
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    await service.registerProvider(provider);
    const lookup = await service.findProviderForTool("mcp__filesystem__read_file");

    expect(register).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(existingToolSpec);
    expect(lookup).toEqual(provider);
  });

  it("deletes removed tool specs on shrink so a later re-expansion can reclaim them", async () => {
    const readToolId = "mcp__filesystem__read_file";
    const writeToolId = "mcp__filesystem__write_file";
    const initialProvider = createProvider({
      tool_specs: [
        {
          tool_id: readToolId,
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        },
        {
          tool_id: writeToolId,
          name: "filesystem.write_file",
          description: "Write file through filesystem MCP."
        }
      ]
    });
    const shrunkenProvider = createProvider({
      name: "Filesystem MCP Provider (Shrunken)",
      tool_specs: [
        {
          tool_id: readToolId,
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        }
      ]
    });
    const restoredProvider = createProvider({
      name: "Filesystem MCP Provider (Restored)",
      registered_at: "2026-04-20T10:00:01.000Z",
      tool_specs: [
        {
          tool_id: readToolId,
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        },
        {
          tool_id: writeToolId,
          name: "filesystem.write_file",
          description: "Write file through filesystem MCP."
        }
      ]
    });
    const harness = createRegistryHarness({
      initialProviders: [initialProvider],
      initialToolSpecs: [
        createExternalToolSpec(initialProvider, readToolId),
        createExternalToolSpec(initialProvider, writeToolId)
      ]
    });

    await harness.service.registerProvider(shrunkenProvider);

    await expect(harness.service.listProviders()).resolves.toEqual([shrunkenProvider]);
    expect([...harness.toolSpecStore.keys()].sort()).toEqual([readToolId]);
    expect(harness.deleteToolSpec).toHaveBeenCalledWith(writeToolId);

    await harness.service.registerProvider(restoredProvider);

    await expect(harness.service.listProviders()).resolves.toEqual([restoredProvider]);
    await expect(harness.service.findProviderForTool(writeToolId)).resolves.toEqual(restoredProvider);
    expect([...harness.toolSpecStore.keys()].sort()).toEqual([readToolId, writeToolId]);
    expect(harness.registerToolSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_id: writeToolId
      })
    );
  });

  it("caches provider listings after the first load and refreshes the cache on re-registration", async () => {
    const provider = createProvider();
    const updatedProvider = createProvider({
      name: "Filesystem MCP Provider (Reloaded)"
    });
    const registerToolProvider = vi
      .fn(async (_value: ToolProvider) => provider)
      .mockResolvedValueOnce(updatedProvider);
    const findToolProviders = vi.fn(async () => [provider]);

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider,
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders,
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Tool spec missing");
        }),
        register: vi.fn(async (spec: ToolSpec) => spec),
        update: vi.fn(async (spec: ToolSpec) => spec),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      now: () => validTimestamp,
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    await expect(service.listProviders()).resolves.toEqual([provider]);
    await expect(service.listProviders()).resolves.toEqual([provider]);

    await service.registerProvider(updatedProvider);

    await expect(service.listProviders()).resolves.toEqual([updatedProvider]);
    expect(findToolProviders).toHaveBeenCalledTimes(1);
  });

  it("reuses the same frozen sorted provider list until the cache changes", async () => {
    const laterProvider = createProvider({
      provider_id: "provider.mcp.filesystem.later",
      registered_at: "2026-04-20T10:00:01.000Z",
      tool_specs: [
        {
          tool_id: "mcp__filesystem__later_read_file",
          name: "filesystem.later_read_file",
          description: "Read file through the later filesystem MCP provider."
        }
      ]
    });
    const earlierProvider = createProvider({
      provider_id: "provider.mcp.filesystem.earlier",
      registered_at: "2026-04-20T09:59:59.000Z",
      tool_specs: [
        {
          tool_id: "mcp__filesystem__earlier_read_file",
          name: "filesystem.earlier_read_file",
          description: "Read file through the earlier filesystem MCP provider."
        }
      ]
    });

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async (value: ToolProvider) => value),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => [laterProvider]),
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Tool spec missing");
        }),
        register: vi.fn(async (spec: ToolSpec) => spec),
        update: vi.fn(async (spec: ToolSpec) => spec),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      now: () => validTimestamp,
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    const firstList = await service.listProviders();
    const secondList = await service.listProviders();

    expect(firstList).toEqual([laterProvider]);
    expect(Object.isFrozen(firstList)).toBe(true);
    expect(secondList).toBe(firstList);

    await service.registerProvider(earlierProvider);

    const refreshedList = await service.listProviders();

    expect(refreshedList).toEqual([earlierProvider, laterProvider]);
    expect(refreshedList).not.toBe(firstList);
  });

  it("resolves provider-by-tool from the in-process registry cache after registration", async () => {
    const provider = createProvider();

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async (value: ToolProvider) => value),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => []),
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Tool spec missing");
        }),
        register: vi.fn(async (spec: ToolSpec) => spec),
        update: vi.fn(async (spec: ToolSpec) => spec),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      now: () => validTimestamp,
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    const storedProvider = await service.registerProvider(provider);

    await expect(service.findProviderForTool("mcp__filesystem__read_file")).resolves.toBe(
      storedProvider
    );
  });

  it("rejects provider registrations that try to claim a tool id already owned by another provider", async () => {
    const sharedToolId = "mcp__filesystem__shared_read_file";
    const laterProvider = createProvider({
      provider_id: "provider.mcp.later",
      name: "Later Filesystem Provider",
      registered_at: "2026-04-20T10:00:01.000Z",
      tool_specs: [
        {
          tool_id: sharedToolId,
          name: "filesystem.shared_read_file",
          description: "Later filesystem provider tool."
        }
      ]
    });
    const earlierProvider = createProvider({
      provider_id: "provider.mcp.earlier",
      name: "Earlier Filesystem Provider",
      registered_at: "2026-04-20T10:00:00.000Z",
      tool_specs: [
        {
          tool_id: sharedToolId,
          name: "filesystem.shared_read_file",
          description: "Earlier filesystem provider tool."
        }
      ]
    });
    const harness = createRegistryHarness({
      initialProviders: [laterProvider],
      initialToolSpecs: [createExternalToolSpec(laterProvider, sharedToolId)]
    });

    await harness.service.listProviders();
    await expect(harness.service.registerProvider(earlierProvider)).rejects.toMatchObject({
      code: "CONFLICT"
    });

    await expect(harness.service.listProviders()).resolves.toEqual([laterProvider]);
    await expect(harness.service.findProviderForTool(sharedToolId)).resolves.toMatchObject({
      provider_id: laterProvider.provider_id
    });
  });

  it("rejects duplicate tool ownership even before the provider cache has been loaded", async () => {
    const sharedToolId = "mcp__filesystem__shared_read_file";
    const existingProvider = createProvider({
      provider_id: "provider.mcp.existing",
      name: "Existing Filesystem Provider",
      tool_specs: [
        {
          tool_id: sharedToolId,
          name: "filesystem.shared_read_file",
          description: "Existing filesystem provider tool."
        }
      ]
    });
    const conflictingProvider = createProvider({
      provider_id: "provider.mcp.conflicting",
      name: "Conflicting Filesystem Provider",
      registered_at: "2026-04-20T10:00:01.000Z",
      tool_specs: [
        {
          tool_id: sharedToolId,
          name: "filesystem.shared_read_file",
          description: "Conflicting filesystem provider tool."
        }
      ]
    });
    const harness = createRegistryHarness({
      initialProviders: [existingProvider],
      initialToolSpecs: [createExternalToolSpec(existingProvider, sharedToolId)]
    });

    await expect(harness.service.registerProvider(conflictingProvider)).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(harness.providerStore.get(conflictingProvider.provider_id)).toBeUndefined();
    await expect(harness.service.findProviderForTool(sharedToolId)).resolves.toMatchObject({
      provider_id: existingProvider.provider_id
    });
  });

  it("rejects duplicate tool ownership while a stale provider cache load is still in flight", async () => {
    const sharedToolId = "mcp__filesystem__shared_read_file";
    const existingProvider = createProvider({
      provider_id: "provider.mcp.existing",
      name: "Existing Filesystem Provider",
      tool_specs: [
        {
          tool_id: sharedToolId,
          name: "filesystem.shared_read_file",
          description: "Existing filesystem provider tool."
        }
      ]
    });
    const conflictingProvider = createProvider({
      provider_id: "provider.mcp.conflicting",
      name: "Conflicting Filesystem Provider",
      registered_at: "2026-04-20T10:00:01.000Z",
      tool_specs: [
        {
          tool_id: sharedToolId,
          name: "filesystem.shared_read_file",
          description: "Conflicting filesystem provider tool."
        }
      ]
    });
    const staleLoad = createDeferred<readonly ToolProvider[]>();
    const providerStore = new Map<string, ToolProvider>([
      [existingProvider.provider_id, existingProvider]
    ]);
    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async (provider: ToolProvider) => {
          providerStore.set(provider.provider_id, provider);
          return provider;
        }),
        deleteToolProvider: vi.fn(async (providerId: string) => {
          providerStore.delete(providerId);
        }),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => await staleLoad.promise),
        findToolProviderById: vi.fn(
          async (providerId: string) => providerStore.get(providerId) ?? null
        )
      },
      toolSpecService: {
        findById: vi.fn(async (toolId: string) => {
          if (toolId === sharedToolId) {
            return createExternalToolSpec(existingProvider, sharedToolId);
          }
          throw new CoreError("NOT_FOUND", "Tool spec missing");
        }),
        register: vi.fn(async (spec: ToolSpec) => spec),
        update: vi.fn(async (spec: ToolSpec) => spec),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      now: () => validTimestamp,
      buildToolSpecForProviderTool: (registeredProvider, tool) =>
        createExternalToolSpec(registeredProvider, tool.tool_id)
    });

    const pendingList = service.listProviders();
    await Promise.resolve();

    await expect(service.registerProvider(conflictingProvider)).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(providerStore.get(conflictingProvider.provider_id)).toBeUndefined();

    staleLoad.resolve([existingProvider]);

    await expect(pendingList).resolves.toEqual([existingProvider]);
    await expect(service.findProviderForTool(sharedToolId)).resolves.toMatchObject({
      provider_id: existingProvider.provider_id
    });
  });

  it("appends a compensation event when provider persistence fails after EventLog append", async () => {
    const provider = createProvider();
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      ...entry,
      event_id: "event-rollback-provider",
      created_at: validTimestamp,
          revision: 0
    }));
    const notifyEntry = vi.fn(async () => undefined);

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(async () => {
          throw new Error("provider upsert failed");
        }),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders: vi.fn(async () => []),
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp
    });

    await expect(service.registerProvider(provider)).rejects.toThrow("provider upsert failed");
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]?.[0]).toMatchObject({
      event_type: "extension.descriptor_registration_reverted",
      entity_type: "extension_descriptor",
      entity_id: provider.provider_id,
      payload_json: {
        descriptor_type: "tool_provider",
        descriptor_id: provider.provider_id,
        original_event_id: "event-rollback-provider",
        reverted_at: validTimestamp
      }
    });
    expect(notifyEntry).not.toHaveBeenCalled();
  });

  it("removes a newly persisted provider when the first tool-spec write fails", async () => {
    const provider = createProvider();
    const harness = createRegistryHarness({
      failRegisterAt: 1
    });

    await expect(harness.service.registerProvider(provider)).rejects.toThrow(
      "register failed for mcp__filesystem__read_file"
    );

    expect([...harness.providerStore.values()]).toEqual([]);
    expect([...harness.toolSpecStore.values()]).toEqual([]);
    expect(harness.deleteToolProvider).toHaveBeenCalledWith(provider.provider_id);
    expect(harness.deleteToolSpec).not.toHaveBeenCalled();
    expect(harness.appendedEvents[1]).toMatchObject({
      event_type: "extension.descriptor_registration_reverted",
      entity_id: provider.provider_id,
      payload_json: {
        descriptor_type: "tool_provider",
        descriptor_id: provider.provider_id,
        original_event_id: "event-1",
        reverted_at: validTimestamp
      }
    });
    expect(harness.notifyEntry).not.toHaveBeenCalled();
  });

  it("appends a compensation failure event when provider rollback throws", async () => {
    const provider = createProvider();
    const harness = createRegistryHarness({
      failRegisterAt: 1,
      failDeleteToolProvider: true
    });

    await expect(harness.service.registerProvider(provider)).rejects.toMatchObject({
      message:
        "Failed to roll back tool_provider provider.mcp.filesystem after mutation failure.",
      cause: expect.objectContaining({
        message: "Rollback failed after mutation failure.",
        cause: expect.objectContaining({
          message: "register failed for mcp__filesystem__read_file"
        }),
        errors: [expect.objectContaining({ message: "delete provider failed for provider.mcp.filesystem" })]
      })
    });

    expect(harness.deleteToolProvider).toHaveBeenCalledWith(provider.provider_id);
    expect(harness.appendedEvents[1]).toMatchObject({
      event_type: "extension.descriptor_registration_compensation_failed",
      entity_id: provider.provider_id,
      payload_json: {
        descriptor_type: "tool_provider",
        descriptor_id: provider.provider_id,
        original_event_id: "event-1",
        failed_at: validTimestamp
      }
    });
    expect(harness.notifyEntry).not.toHaveBeenCalled();
  });

  it("restores the previous provider and touched tool specs when a later tool-spec write fails", async () => {
    const initialProvider = createProvider({
      name: "Filesystem MCP Provider (Initial)"
    });
    const updatedProvider = createProvider({
      name: "Filesystem MCP Provider (Updated)",
      tool_specs: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP (updated)."
        },
        {
          tool_id: "mcp__filesystem__write_file",
          name: "filesystem.write_file",
          description: "Write file through filesystem MCP."
        }
      ]
    });
    const initialReadSpec = createExternalToolSpec(
      initialProvider,
      "mcp__filesystem__read_file"
    );
    const harness = createRegistryHarness({
      initialProviders: [initialProvider],
      initialToolSpecs: [initialReadSpec],
      failRegisterAt: 1
    });

    await expect(harness.service.registerProvider(updatedProvider)).rejects.toThrow(
      "register failed for mcp__filesystem__write_file"
    );

    expect([...harness.providerStore.values()]).toEqual([initialProvider]);
    expect([...harness.toolSpecStore.values()]).toEqual([initialReadSpec]);
    expect(harness.registerToolProvider).toHaveBeenNthCalledWith(1, updatedProvider);
    expect(harness.registerToolProvider).toHaveBeenNthCalledWith(2, initialProvider);
    expect(harness.updateToolSpec).toHaveBeenCalledWith(
      createExternalToolSpec(updatedProvider, "mcp__filesystem__read_file")
    );
    expect(harness.deleteToolSpec).not.toHaveBeenCalledWith("mcp__filesystem__read_file");
    expect(harness.appendedEvents[1]).toMatchObject({
      event_type: "extension.descriptor_registration_reverted",
      entity_id: updatedProvider.provider_id,
      payload_json: {
        descriptor_type: "tool_provider",
        descriptor_id: updatedProvider.provider_id,
        original_event_id: "event-1",
        reverted_at: validTimestamp
      }
    });
    expect(harness.notifyEntry).not.toHaveBeenCalled();
  });

  it("appends a compensation event when skill package persistence fails after EventLog append", async () => {
    const skillPackage = {
      skill_id: "skill.filesystem",
      name: "Filesystem Skill Package",
      version: "1.0.0",
      source: "skill_package" as const,
      tool_ids: ["mcp__filesystem__read_file"],
      registered_at: validTimestamp
    };
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      ...entry,
      event_id: "event-rollback-skill",
      created_at: validTimestamp,
          revision: 0
    }));
    const notifyEntry = vi.fn(async () => undefined);

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(async () => {
          throw new Error("skill package upsert failed");
        }),
        findToolProviders: vi.fn(async () => []),
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: { append },
      runtimeNotifier: { notifyEntry },
      now: () => validTimestamp
    });

    await expect(service.registerSkillPackage(skillPackage)).rejects.toThrow(
      "skill package upsert failed"
    );
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]?.[0]).toMatchObject({
      event_type: "extension.descriptor_registration_reverted",
      entity_type: "extension_descriptor",
      entity_id: skillPackage.skill_id,
      payload_json: {
        descriptor_type: "skill_package",
        descriptor_id: skillPackage.skill_id,
        original_event_id: "event-rollback-skill",
        reverted_at: validTimestamp
      }
    });
    expect(notifyEntry).not.toHaveBeenCalled();
  });

  it("shares the in-flight provider cache load across concurrent lookups", async () => {
    const provider = createProvider();
    let resolveProviders: ((providers: readonly ToolProvider[]) => void) | undefined;
    const findToolProviders = vi.fn(
      () =>
        new Promise<readonly ToolProvider[]>((resolve) => {
          resolveProviders = resolve;
        })
    );

    const service = new ExtensionRegistryService({
      extensionStore: {
        registerToolProvider: vi.fn(),
        deleteToolProvider: vi.fn(async () => undefined),
        registerSkillPackage: vi.fn(),
        findToolProviders,
        findToolProviderById: vi.fn(async () => null)
      },
      toolSpecService: {
        findById: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(async () => undefined)
      },
      eventLogWriter: {
        append: vi.fn()
      }
    });

    const listPromise = service.listProviders();
    const lookupPromise = service.findProviderForTool("mcp__filesystem__read_file");

    await Promise.resolve();

    expect(findToolProviders).toHaveBeenCalledTimes(1);

    resolveProviders?.([provider]);

    await expect(listPromise).resolves.toEqual([provider]);
    await expect(lookupPromise).resolves.toEqual(provider);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
