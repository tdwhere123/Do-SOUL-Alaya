import { describe, expect, it, vi } from "vitest";
import { createExternalToolSpec, createProvider, createRegistryHarness } from "./extension-registry-service-test-fixtures.js";

const oldTool = { tool_id: "filesystem.retired", name: "Retired tool", description: "Old tool" };
const newTool = { tool_id: "filesystem.added", name: "Added tool", description: "New tool" };

function replacementProviders() {
  const original = createProvider();
  const initial = createProvider({ tool_specs: [...original.tool_specs, oldTool] });
  const updated = createProvider({
    name: "Updated Filesystem Provider",
    tool_specs: [{ ...original.tool_specs[0]!, description: "Updated read description" }, newTool]
  });
  return { initial, updated };
}

describe("ExtensionRegistryService atomic SQLite registration", () => {
  it("commits descriptor, spec updates, additions and removals together before notification", async () => {
    const { initial, updated } = replacementProviders();
    const f = createRegistryHarness({
      initialProviders: [initial],
      initialToolSpecs: initial.tool_specs.map(tool => createExternalToolSpec(initial, tool.tool_id))
    });
    const first = await f.service.listProviders();
    let observed: unknown;
    f.notifyEntry.mockImplementationOnce(async () => {
      observed = {
        inTransaction: f.database.connection.inTransaction,
        providers: await f.service.listProviders(),
        specs: await f.toolSpecRepo.list(),
        eventCount: (await f.eventLogRepo.queryByType("extension.descriptor_registered")).events.length
      };
    });

    await f.service.registerProvider(updated);

    expect(observed).toEqual({
      inTransaction: false,
      providers: [updated],
      specs: updated.tool_specs.map(tool => createExternalToolSpec(updated, tool.tool_id))
        .sort((a, b) => a.tool_id.localeCompare(b.tool_id)),
      eventCount: 1
    });
    expect(f.extensionStore.findToolProviderByIdSync(initial.provider_id)).toEqual(updated);
    expect(await f.service.listProviders()).not.toBe(first);
    await expect(f.service.findProviderForTool(oldTool.tool_id)).resolves.toBeNull();
    // Re-expansion can reclaim a removed id without a competing tool-spec row.
    await f.service.registerProvider(initial);
    expect(f.toolSpecRepo.findByIdSync(oldTool.tool_id)).toEqual(createExternalToolSpec(initial, oldTool.tool_id));
  });

  it("rolls back the event, descriptor and earlier spec mutations when a later SQLite deletion fails", async () => {
    const { initial, updated } = replacementProviders();
    const specs = initial.tool_specs.map(tool => createExternalToolSpec(initial, tool.tool_id));
    const f = createRegistryHarness({ initialProviders: [initial], initialToolSpecs: specs });
    await f.service.listProviders();
    f.database.connection.exec(`
      CREATE TEMP TRIGGER refuse_retirement BEFORE DELETE ON tool_specs
      WHEN OLD.tool_id = 'filesystem.retired'
      BEGIN SELECT RAISE(ABORT, 'retirement refused'); END;
    `);

    await expect(f.service.registerProvider(updated)).rejects.toThrow("Failed to delete tool spec");

    expect(f.extensionStore.findToolProviderByIdSync(initial.provider_id)).toEqual(initial);
    expect(await f.toolSpecRepo.list()).toEqual([...specs].sort((a, b) => a.tool_id.localeCompare(b.tool_id)));
    expect(f.toolSpecRepo.findByIdSync(newTool.tool_id)).toBeNull();
    await expect(f.service.listProviders()).resolves.toEqual([initial]);
    expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toEqual({ n: 0 });
    expect(f.notifyEntry).not.toHaveBeenCalled();

    f.database.connection.exec("DROP TRIGGER refuse_retirement");
    await f.service.registerProvider(updated);
    expect((await f.eventLogRepo.queryByType("extension.descriptor_registered")).events).toHaveLength(1);
  });

  it("leaves no new descriptor, specs or event when a later spec insertion fails", async () => {
    const f = createRegistryHarness();
    const provider = createProvider({ tool_specs: [...createProvider().tool_specs, newTool] });
    f.database.connection.exec(`
      CREATE TEMP TRIGGER refuse_addition BEFORE INSERT ON tool_specs
      WHEN NEW.tool_id = 'filesystem.added'
      BEGIN SELECT RAISE(ABORT, 'addition refused'); END;
    `);
    await expect(f.service.registerProvider(provider)).rejects.toThrow("Failed to insert tool spec");
    expect(f.extensionStore.findToolProvidersSync()).toEqual([]);
    expect(await f.toolSpecRepo.list()).toEqual([]);
    expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toEqual({ n: 0 });
    expect(f.notifyEntry).not.toHaveBeenCalled();
  });

  it("keeps committed registration and refreshes a warm cache when notification fails", async () => {
    const { initial, updated } = replacementProviders();
    const f = createRegistryHarness({
      initialProviders: [initial],
      initialToolSpecs: initial.tool_specs.map(tool => createExternalToolSpec(initial, tool.tool_id))
    });
    await f.service.listProviders();
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let observed: unknown;
    f.notifyEntry.mockImplementationOnce(async () => {
      observed = {
        inTransaction: f.database.connection.inTransaction,
        providers: await f.service.listProviders()
      };
      throw new Error("listener offline");
    });

    await expect(f.service.registerProvider(updated)).resolves.toEqual(updated);

    expect(observed).toEqual({ inTransaction: false, providers: [updated] });
    expect(f.extensionStore.findToolProviderByIdSync(updated.provider_id)).toEqual(updated);
    expect(f.toolSpecRepo.findByIdSync(oldTool.tool_id)).toBeNull();
    expect(f.toolSpecRepo.findByIdSync(newTool.tool_id)).not.toBeNull();
    await expect(f.service.listProviders()).resolves.toEqual([updated]);
    await expect(f.service.findProviderForTool(oldTool.tool_id)).resolves.toBeNull();
    const { events } = await f.eventLogRepo.queryByType("extension.descriptor_registered");
    expect(events).toHaveLength(1);
    const { events: diagnostics } = await f.eventLogRepo.queryByType("runtime.side_effect_failed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.payload_json).toMatchObject({ committed_event_id: events[0]!.event_id });
    expect((await f.eventLogRepo.queryByType("extension.descriptor_registration_reverted")).events).toEqual([]);
  });
});
