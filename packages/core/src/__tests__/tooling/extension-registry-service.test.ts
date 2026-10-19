import { describe, expect, it, vi } from "vitest";
import { ExtensionRegistryService } from "../../tooling/extension-registry-service.js";
import { createExternalToolSpec, createProvider, createRegistryHarness, validTimestamp } from "./extension-registry-service-test-fixtures.js";

describe("ExtensionRegistryService", () => {
  it("registers a provider with its tool specs before notifying", async () => {
    const f = createRegistryHarness();
    const provider = createProvider();
    const register = vi.spyOn(f.toolSpecService, "registerSync");
    let observed: unknown;
    f.notifyEntry.mockImplementationOnce(async () => {
      observed = {
        inTransaction: f.database.connection.inTransaction,
        provider: f.extensionStore.findToolProviderByIdSync(provider.provider_id),
        spec: f.toolSpecRepo.findByIdSync(provider.tool_specs[0]!.tool_id)
      };
    });

    await expect(f.service.registerProvider(provider)).resolves.toEqual(provider);

    expect(observed).toEqual({
      inTransaction: false,
      provider,
      spec: createExternalToolSpec(provider, provider.tool_specs[0]!.tool_id)
    });
    expect(register).toHaveBeenCalledOnce();
    const { events } = await f.eventLogRepo.queryByType("extension.descriptor_registered");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entity_type: "extension_descriptor",
      entity_id: provider.provider_id,
      workspace_id: "system",
      payload_json: {
        descriptor_type: "tool_provider",
        descriptor_id: provider.provider_id,
        source: provider.source
      }
    });
    expect(f.notifyEntry).toHaveBeenCalledWith(events[0]);
  });

  it("normalizes the system workspace and audit timestamps", async () => {
    const f = createRegistryHarness({ defaultWorkspaceId: "   ", now: () => "2026-04-20T10:00:00Z" });
    await f.service.registerProvider(createProvider());
    expect((await f.eventLogRepo.queryByType("extension.descriptor_registered")).events[0]).toMatchObject({
      workspace_id: "system",
      caused_by: "system",
      payload_json: { registered_at: validTimestamp }
    });
  });

  it("caches a frozen sorted list and refreshes it from storage after registration", async () => {
    const provider = createProvider();
    const f = createRegistryHarness({ initialProviders: [provider] });
    const find = vi.spyOn(f.extensionStore, "findToolProvidersSync");
    const first = await f.service.listProviders();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(await f.service.listProviders()).toBe(first);
    expect(find).toHaveBeenCalledTimes(1);
    const earlier = createProvider({
      provider_id: "provider.earlier", registered_at: "2026-04-20T09:59:59.000Z",
      tool_specs: [{ tool_id: "earlier.tool", name: "Earlier tool", description: "Earlier tool" }]
    });
    await f.service.registerProvider(earlier);
    const refreshed = await f.service.listProviders();
    expect(refreshed).toEqual([earlier, provider]);
    expect(refreshed).not.toBe(first);
    expect(await f.service.findProviderForTool(earlier.tool_specs[0]!.tool_id)).toEqual(earlier);
    expect(await f.service.findProviderForTool("unknown.tool")).toBeNull();
  });

  it("does not cache failed provider reads as an empty registry", async () => {
    const provider = createProvider();
    const f = createRegistryHarness({ initialProviders: [provider] });
    vi.spyOn(f.extensionStore, "findToolProvidersSync").mockImplementationOnce(() => { throw new Error("store offline"); });
    await expect(f.service.listProviders()).rejects.toThrow("store offline");
    await expect(f.service.listProviders()).resolves.toEqual([provider]);
  });

  it.each([false, true])("rejects another provider claiming an owned tool with cache loaded: %s", async cached => {
    const provider = createProvider();
    const f = createRegistryHarness({
      initialProviders: [provider],
      initialToolSpecs: [createExternalToolSpec(provider, provider.tool_specs[0]!.tool_id)]
    });
    if (cached) await f.service.listProviders();
    const conflict = createProvider({ provider_id: "provider.other", source: "builtin" });
    await expect(f.service.registerProvider(conflict)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.extensionStore.findToolProviderByIdSync(conflict.provider_id)).toBeNull();
    await expect(f.service.listProviders()).resolves.toEqual([provider]);
    expect((await f.eventLogRepo.queryByType("extension.descriptor_registered")).events).toEqual([]);
    expect(f.notifyEntry).not.toHaveBeenCalled();
  });

  it("does not use a stale cache to authorize ownership", async () => {
    const f = createRegistryHarness();
    await f.service.listProviders();
    const owner = createProvider();
    // Another writer can register a descriptor after this service cached its list.
    f.extensionStore.registerToolProviderSync(owner);
    await expect(f.service.registerProvider(createProvider({ provider_id: "provider.other", source: "builtin" })))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.service.findProviderForTool(owner.tool_specs[0]!.tool_id)).resolves.toEqual(owner);
  });

  it("rejects an external descriptor claiming a spec without matching ownership", async () => {
    const provider = createProvider();
    const spec = createExternalToolSpec(provider, provider.tool_specs[0]!.tool_id);
    const f = createRegistryHarness({ initialToolSpecs: [spec] });
    await expect(f.service.registerProvider(provider)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.service.listProviders()).resolves.toEqual([]);
    expect(f.toolSpecRepo.findByIdSync(spec.tool_id)).toEqual(spec);
  });

  it("preserves existing builtin spec policy and external spec policy on updates", async () => {
    const provider = createProvider({ source: "builtin" });
    const toolId = provider.tool_specs[0]!.tool_id;
    const spec = { ...createExternalToolSpec(provider, toolId), category: "read" as const, read_only: true, fast_path_eligible: true };
    const f = createRegistryHarness({ initialToolSpecs: [spec] });
    await f.service.registerProvider(provider);
    expect(f.toolSpecRepo.findByIdSync(toolId)).toEqual(spec);
    const external = createProvider({ tool_specs: [{ ...provider.tool_specs[0]!, description: "Updated description" }] });
    await f.service.registerProvider(external);
    expect(f.toolSpecRepo.findByIdSync(toolId)).toEqual({ ...spec, description: "Updated description" });
  });

  it("uses ToolSpecService invariant validation for provider spec mutations", async () => {
    const f = createRegistryHarness();
    const service = new ExtensionRegistryService({
      extensionStore: f.extensionStore, toolSpecService: f.toolSpecService, eventPublisher: f.eventPublisher,
      buildToolSpecForProviderTool: (provider, tool) => ({
        ...createExternalToolSpec(provider, tool.tool_id), fast_path_eligible: true
      })
    });
    await expect(service.registerProvider(createProvider())).rejects.toMatchObject({ code: "VALIDATION" });
    expect(f.extensionStore.findToolProvidersSync()).toEqual([]);
    expect(await f.toolSpecRepo.list()).toEqual([]);
    expect((await f.eventLogRepo.queryByType("extension.descriptor_registered")).events).toEqual([]);
  });
});
