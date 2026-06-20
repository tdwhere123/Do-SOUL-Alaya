import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, ToolProvider } from "@do-soul/alaya-protocol";
import { ExtensionRegistryService } from "../../tooling/extension-registry-service.js";
import { validTimestamp, createProvider } from "./extension-registry-service-test-fixtures.js";

describe("ExtensionRegistryService", () => {
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
