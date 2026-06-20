import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { ExtensionRegistryService } from "../../tooling/extension-registry-service.js";
import { validTimestamp, createProvider, createExternalToolSpec, createRegistryHarness, createDeferred } from "./extension-registry-service-test-fixtures.js";

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
});
