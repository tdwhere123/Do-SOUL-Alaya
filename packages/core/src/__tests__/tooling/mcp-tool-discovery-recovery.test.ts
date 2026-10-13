import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, ToolProvider } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { McpToolDiscoveryService } from "../../tooling/mcp-tool-discovery-service.js";
import { createServer, validTimestamp } from "./mcp-tool-discovery-service.test-support.js";

describe("MCP tool discovery audit recovery", () => {
  it("does not rediscover an audited tool beyond the first SQLite entity page after restart", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const eventLogWriter = new SqliteEventLogRepo(database);
      const providers = new Map<string, ToolProvider>();
      const notifyEntry = vi.fn();
      const service = () => new McpToolDiscoveryService({
        extensionRegistry: {
          listProviders: async () => [...providers.values()],
          registerProvider: async provider => { providers.set(provider.provider_id, provider); return provider; }
        },
        mcpToolCatalog: { listServerTools: async () => Array.from({ length: 501 }, (_, index) => ({
          tool_id: `mcp__filesystem__tool_${index}`, name: `tool_${index}`, description: "Read"
        })) },
        eventLogWriter, runtimeNotifier: { notifyEntry }, now: () => validTimestamp
      });
      await service().discoverAndRegister([createServer()]);
      const providerId = [...providers.keys()][0]!;
      expect(await eventLogWriter.queryByEntity("extension_provider", providerId)).toHaveLength(500);
      expect(await eventLogWriter.queryByEntityAll("extension_provider", providerId)).toHaveLength(501);
      notifyEntry.mockClear();
      await service().discoverAndRegister([createServer()]);
      expect(await eventLogWriter.queryByEntityAll("extension_provider", providerId)).toHaveLength(501);
      expect(notifyEntry).not.toHaveBeenCalled();
    } finally { database.close(); }
  });
  it("repairs a registry-only tool after append failure and suppresses an audited tool after restart", async () => {
    const fixture = recoveryFixture();
    fixture.append.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(fixture.service().discoverAndRegister([createServer()])).rejects.toThrow("audit unavailable");
    expect(fixture.providers.size).toBe(1);
    expect(fixture.events).toEqual([]);
    await fixture.service().discoverAndRegister([createServer()]);
    expect(fixture.events.map(row => row.event_type)).toEqual(["extension.tool_discovered"]);
    await fixture.service().discoverAndRegister([createServer()]);
    expect(fixture.events).toHaveLength(1);
    expect(fixture.notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("does not append discovery twice after committed notification failure", async () => {
    const fixture = recoveryFixture();
    fixture.notifyEntry.mockRejectedValueOnce(new Error("listener offline"));
    const service = fixture.service();
    await expect(service.discoverAndRegister([createServer()])).resolves.toHaveLength(1);
    await service.discoverAndRegister([createServer()]);
    await fixture.service().discoverAndRegister([createServer()]);
    expect(fixture.events.filter(row => row.event_type === "extension.tool_discovered")).toHaveLength(1);
    expect(fixture.events.some(row => row.event_type === "runtime.side_effect_failed")).toBe(true);
  });

  it("propagates an incomplete audit-history read without treating known tools as unaudited", async () => {
    const fixture = recoveryFixture();
    await fixture.service().discoverAndRegister([createServer()]);
    fixture.queryByEntityAll.mockRejectedValueOnce(new Error("audit history overflow"));
    await expect(fixture.service().discoverAndRegister([createServer()])).rejects.toThrow("audit history overflow");
    expect(fixture.events).toHaveLength(1);
    expect(fixture.notifyEntry).toHaveBeenCalledTimes(1);
  });
});

function recoveryFixture() {
  const providers = new Map<string, ToolProvider>();
  const events: EventLogEntry[] = [];
  const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    const persisted = { ...entry, event_id: `event-${events.length}`, created_at: validTimestamp, revision: events.length };
    events.push(persisted);
    return persisted;
  });
  const notifyEntry = vi.fn(async (_entry: EventLogEntry) => undefined);
  const queryByEntityAll = vi.fn(async (type: string, id: string) => events.filter(row => row.entity_type === type && row.entity_id === id));
  return { providers, events, append, notifyEntry, queryByEntityAll, service: () => new McpToolDiscoveryService({
    extensionRegistry: {
      listProviders: async () => [...providers.values()],
      registerProvider: async provider => { providers.set(provider.provider_id, provider); return provider; }
    },
    mcpToolCatalog: { listServerTools: async () => [{ tool_id: "mcp__filesystem__read_file", name: "read_file", description: "Read" }] },
    eventLogWriter: { append, queryByEntityAll },
    runtimeNotifier: { notifyEntry }, now: () => validTimestamp
  }) };
}
