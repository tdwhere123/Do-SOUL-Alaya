import { ToolSpecSchema, type ToolProvider, type ToolProviderToolSpec, type ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseExtensionToolProvider } from "../shared/extension-descriptor-parsers.js";
import type { ProviderCacheSnapshot } from "./extension-registry-service-types.js";

export function normalizeProvider(
  provider: Readonly<ToolProvider>
): Readonly<ToolProvider> {
  return Object.isFrozen(provider) ? provider : parseExtensionToolProvider(provider);
}

export function parseToolSpec(value: ToolSpec): Readonly<ToolSpec> {
  try {
    return deepFreeze(ToolSpecSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid tool spec payload", { cause: error });
  }
}

export function buildDefaultToolSpec(
  provider: Readonly<ToolProvider>,
  tool: Readonly<ToolProviderToolSpec>,
  existing: Readonly<ToolSpec> | null
): ToolSpec {
  if (existing !== null && provider.source === "builtin") {
    return existing;
  }

  if (existing !== null) {
    return {
      ...existing,
      description: tool.description
    };
  }

  return {
    tool_id: tool.tool_id,
    category: "exec",
    description: tool.description,
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

export function createProviderCacheSnapshot(
  providers: readonly Readonly<ToolProvider>[]
): Readonly<ProviderCacheSnapshot> {
  const providerList = freezeProviderList(providers);
  const providerCacheById = new Map<string, Readonly<ToolProvider>>();
  const providerCacheByToolId = new Map<string, Readonly<ToolProvider>>();

  for (const provider of providerList) {
    providerCacheById.set(provider.provider_id, provider);
    for (const tool of provider.tool_specs) {
      const existingOwner = providerCacheByToolId.get(tool.tool_id);
      if (existingOwner !== undefined) {
        throw new CoreError(
          "CONFLICT",
          `Tool ${tool.tool_id} is already owned by provider ${existingOwner.provider_id}; provider ${provider.provider_id} cannot claim it.`
        );
      }

      providerCacheByToolId.set(tool.tool_id, provider);
    }
  }

  return Object.freeze({
    providerCacheById,
    providerCacheByToolId,
    providerList
  });
}

export function mergeProviderIntoCacheSnapshot(
  currentSnapshot: Readonly<ProviderCacheSnapshot>,
  normalizedProvider: Readonly<ToolProvider>
): Readonly<ProviderCacheSnapshot> {
  const nextProviders = [
    ...currentSnapshot.providerList.filter(
      (provider) => provider.provider_id !== normalizedProvider.provider_id
    ),
    normalizedProvider
  ];

  return createProviderCacheSnapshot(nextProviders);
}

export function providerOwnsTool(
  provider: Readonly<ToolProvider> | null,
  toolId: string
): boolean {
  return provider?.tool_specs.some((tool) => tool.tool_id === toolId) ?? false;
}

export function listRemovedToolIds(
  previousProvider: Readonly<ToolProvider> | null,
  nextProvider: Readonly<ToolProvider>
): readonly string[] {
  if (previousProvider === null) {
    return [];
  }

  const nextToolIds = new Set(nextProvider.tool_specs.map((tool) => tool.tool_id));
  return previousProvider.tool_specs
    .map((tool) => tool.tool_id)
    .filter((toolId) => !nextToolIds.has(toolId));
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function freezeProviderList(
  providers: Iterable<Readonly<ToolProvider>>
): readonly Readonly<ToolProvider>[] {
  return Object.freeze(
    [...providers].sort((left, right) => {
      if (left.registered_at !== right.registered_at) {
        return left.registered_at.localeCompare(right.registered_at);
      }
      return left.provider_id.localeCompare(right.provider_id);
    })
  );
}
