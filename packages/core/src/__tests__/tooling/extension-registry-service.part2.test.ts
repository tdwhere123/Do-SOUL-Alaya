import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { ExtensionRegistryService } from "../../tooling/extension-registry-service.js";
import { validTimestamp, createProvider, createExternalToolSpec, createRegistryHarness, createDeferred } from "./extension-registry-service-test-fixtures.js";

describe("ExtensionRegistryService", () => {
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
});
