import { vi } from "vitest";
import type { EventLogEntry, ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { ExtensionRegistryService } from "../../tooling/extension-registry-service.js";

export const validTimestamp = "2026-04-20T10:00:00.000Z";

export function createProvider(overrides: Partial<ToolProvider> = {}): ToolProvider {
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

export function createExternalToolSpec(provider: ToolProvider, toolId: string): ToolSpec {
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

export function createRegistryHarness(input: {
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

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
