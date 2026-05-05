import {
  ExtensionDescriptorRegisteredPayloadSchema,
  ExtensionDescriptorRegistrationCompensationFailedPayloadSchema,
  ExtensionDescriptorRegistrationRevertedPayloadSchema,
  RuntimeGovernanceEventType,
  ToolSpecSchema,
  type EventLogEntry,
  type SkillPackage,
  type ToolProvider,
  type ToolProviderToolSpec,
  type ToolSpec
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import type { ToolSpecService } from "./tool-spec-service.js";
import { SYSTEM_ACTOR, resolveSystemWorkspaceId } from "./shared/actors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import {
  parseExtensionSkillPackage,
  parseExtensionToolProvider
} from "./shared/extension-descriptor-parsers.js";
import { readNow } from "./shared/time.js";

type ExtensionRegistryToolSpecPort = Pick<
  ToolSpecService,
  "findById" | "register" | "update" | "delete"
>;

interface ToolSpecRollbackSnapshot {
  readonly toolId: string;
  readonly previous: Readonly<ToolSpec> | null;
}

interface ProviderCacheSnapshot {
  readonly providerCacheById: ReadonlyMap<string, Readonly<ToolProvider>>;
  readonly providerCacheByToolId: ReadonlyMap<string, Readonly<ToolProvider>>;
  readonly providerList: readonly Readonly<ToolProvider>[];
}

export interface ExtensionStorePort {
  registerToolProvider(provider: ToolProvider): Promise<Readonly<ToolProvider>>;
  deleteToolProvider(providerId: string): Promise<void>;
  registerSkillPackage(pkg: SkillPackage): Promise<Readonly<SkillPackage>>;
  findToolProviders(): Promise<readonly Readonly<ToolProvider>[]>;
  findToolProviderById(providerId: string): Promise<Readonly<ToolProvider> | null>;
}

export interface ExtensionRegistryDependencies {
  readonly extensionStore: ExtensionStorePort;
  readonly toolSpecService: ExtensionRegistryToolSpecPort;
  readonly eventLogWriter: {
    append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  };
  readonly runtimeNotifier?: {
    notifyEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly now?: () => string;
  readonly buildToolSpecForProviderTool?: (
    provider: Readonly<ToolProvider>,
    tool: Readonly<ToolProviderToolSpec>,
    existing: Readonly<ToolSpec> | null
  ) => ToolSpec;
  readonly defaultWorkspaceId?: string;
}

export class ExtensionRegistryService {
  private providerCacheSnapshot: Readonly<ProviderCacheSnapshot> | null = null;
  private providerCacheLoadPromise: Promise<Readonly<ProviderCacheSnapshot>> | null = null;
  private readonly systemWorkspaceId: string;

  public constructor(private readonly deps: ExtensionRegistryDependencies) {
    this.systemWorkspaceId = resolveSystemWorkspaceId(deps.defaultWorkspaceId);
  }

  public async registerProvider(provider: ToolProvider): Promise<Readonly<ToolProvider>> {
    const parsedProvider = parseExtensionToolProvider(provider);
    let storedProvider: Readonly<ToolProvider> | null = null;
    let previousProvider: Readonly<ToolProvider> | null = null;
    const touchedToolSpecs: ToolSpecRollbackSnapshot[] = [];
    return await this.publishDescriptorRegisteredWithMutation(
      {
        descriptor_type: "tool_provider",
        descriptor_id: parsedProvider.provider_id,
        name: parsedProvider.name,
        source: parsedProvider.source
      },
      async () => {
        previousProvider = await this.findStoredProvider(parsedProvider.provider_id);
        storedProvider = normalizeProvider(
          await this.deps.extensionStore.registerToolProvider(parsedProvider)
        );

        for (const tool of storedProvider.tool_specs) {
          const existing = await this.findToolSpec(tool.tool_id);
          this.assertToolOwnershipAvailable(
            storedProvider,
            previousProvider,
            tool.tool_id,
            existing
          );
          const resolvedSpec = parseToolSpec(
            this.deps.buildToolSpecForProviderTool?.(storedProvider, tool, existing) ??
              buildDefaultToolSpec(storedProvider, tool, existing)
          );

          if (existing === null) {
            await this.deps.toolSpecService.register(resolvedSpec);
          } else {
            await this.deps.toolSpecService.update(resolvedSpec);
          }

          touchedToolSpecs.push({
            toolId: tool.tool_id,
            previous: existing
          });
        }

        for (const toolId of listRemovedToolIds(previousProvider, storedProvider)) {
          const existing = await this.findToolSpec(toolId);
          if (existing === null) {
            continue;
          }

          touchedToolSpecs.push({
            toolId,
            previous: existing
          });
          await this.deleteToolSpec(toolId);
        }

        await this.cacheProvider(storedProvider);
        return storedProvider;
      },
      async () => {
        if (storedProvider === null) {
          return;
        }

        await this.rollbackProviderRegistration(
          parsedProvider.provider_id,
          previousProvider,
          touchedToolSpecs
        );
      }
    );
  }

  public async registerSkillPackage(pkg: SkillPackage): Promise<Readonly<SkillPackage>> {
    const parsedPackage = parseExtensionSkillPackage(pkg);
    return await this.publishDescriptorRegisteredWithMutation(
      {
        descriptor_type: "skill_package",
        descriptor_id: parsedPackage.skill_id,
        name: parsedPackage.name,
        source: parsedPackage.source
      },
      async () => await this.deps.extensionStore.registerSkillPackage(parsedPackage)
    );
  }

  public async listProviders(): Promise<readonly Readonly<ToolProvider>[]> {
    return (await this.ensureProviderCache()).providerList;
  }

  public async findProviderForTool(toolId: string): Promise<Readonly<ToolProvider> | null> {
    const cachedProvider = this.providerCacheSnapshot?.providerCacheByToolId.get(toolId);
    if (cachedProvider !== undefined) {
      return cachedProvider;
    }

    return (await this.ensureProviderCache()).providerCacheByToolId.get(toolId) ?? null;
  }

  private async findToolSpec(toolId: string): Promise<Readonly<ToolSpec> | null> {
    try {
      return parseToolSpec(await this.deps.toolSpecService.findById(toolId));
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  private async findStoredProvider(providerId: string): Promise<Readonly<ToolProvider> | null> {
    const storedProvider = await this.deps.extensionStore.findToolProviderById(providerId);

    return storedProvider === null ? null : normalizeProvider(storedProvider);
  }

  private assertToolOwnershipAvailable(
    provider: Readonly<ToolProvider>,
    previousProvider: Readonly<ToolProvider> | null,
    toolId: string,
    existingToolSpec: Readonly<ToolSpec> | null
  ): void {
    const cachedOwner = this.providerCacheSnapshot?.providerCacheByToolId.get(toolId);
    if (cachedOwner !== undefined && cachedOwner.provider_id !== provider.provider_id) {
      throw new CoreError(
        "CONFLICT",
        `Tool ${toolId} is already owned by provider ${cachedOwner.provider_id}; provider ${provider.provider_id} cannot claim it.`
      );
    }

    if (providerOwnsTool(previousProvider, toolId)) {
      return;
    }

    if (existingToolSpec === null || provider.source === "builtin") {
      return;
    }

    throw new CoreError(
      "CONFLICT",
      `Tool ${toolId} already has a registered tool spec; provider ${provider.provider_id} cannot claim it without matching descriptor ownership.`
    );
  }

  private async rollbackProviderRegistration(
    providerId: string,
    previousProvider: Readonly<ToolProvider> | null,
    touchedToolSpecs: readonly ToolSpecRollbackSnapshot[]
  ): Promise<void> {
    await this.rollbackToolSpecs(touchedToolSpecs);

    if (previousProvider !== null) {
      await this.deps.extensionStore.registerToolProvider(previousProvider);
      return;
    }

    await this.deps.extensionStore.deleteToolProvider(providerId);
  }

  private async rollbackToolSpecs(
    touchedToolSpecs: readonly ToolSpecRollbackSnapshot[]
  ): Promise<void> {
    for (const snapshot of [...touchedToolSpecs].reverse()) {
      if (snapshot.previous === null) {
        await this.deleteToolSpec(snapshot.toolId);
        continue;
      }

      await this.deps.toolSpecService.update(snapshot.previous);
    }
  }

  private async deleteToolSpec(toolId: string): Promise<void> {
    await this.deps.toolSpecService.delete(toolId);
  }

  private async publishDescriptorRegisteredWithMutation<T>(
    input: {
      readonly descriptor_type: "tool_provider" | "skill_package";
      readonly descriptor_id: string;
      readonly name: string;
      readonly source: ToolProvider["source"] | SkillPackage["source"];
    },
    mutate: () => Promise<T>,
    rollbackMutation?: () => Promise<void>
  ): Promise<T> {
    const entry = await this.deps.eventLogWriter.append(
      this.createDescriptorRegisteredEventEntry(input)
    );

    let result: T;
    try {
      result = await mutate();
    } catch (error) {
      if (rollbackMutation !== undefined) {
        try {
          await rollbackMutation();
        } catch (rollbackError) {
          try {
            await this.deps.eventLogWriter.append(
              this.createDescriptorRegistrationCompensationFailedEventEntry(
                input,
                entry.event_id
              )
            );
          } catch (compensationError) {
            throw new CoreError(
              "CONFLICT",
              `Failed to roll back ${input.descriptor_type} ${input.descriptor_id} after mutation failure.`,
              {
                cause: new AggregateError(
                  [toError(rollbackError), toError(compensationError)],
                  "Rollback failed after mutation failure and failure compensation could not be recorded.",
                  {
                    cause: toError(error)
                  }
                )
              }
            );
          }
          throw new CoreError(
            "CONFLICT",
            `Failed to roll back ${input.descriptor_type} ${input.descriptor_id} after mutation failure.`,
            {
              cause: new AggregateError(
                [toError(rollbackError)],
                "Rollback failed after mutation failure.",
                {
                  cause: toError(error)
                }
              )
            }
          );
        }
      }
      await this.deps.eventLogWriter.append(
        this.createDescriptorRegistrationRevertedEventEntry(input, entry.event_id)
      );
      throw error;
    }

    await this.deps.runtimeNotifier?.notifyEntry(entry);
    return result;
  }

  private createDescriptorRegisteredEventEntry(input: {
    readonly descriptor_type: "tool_provider" | "skill_package";
    readonly descriptor_id: string;
    readonly name: string;
    readonly source: ToolProvider["source"] | SkillPackage["source"];
  }): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    const payload = deepFreeze(
      ExtensionDescriptorRegisteredPayloadSchema.parse({
        descriptor_type: input.descriptor_type,
        descriptor_id: input.descriptor_id,
        name: input.name,
        source: input.source,
        registered_at: readNow(this.deps.now)
      })
    );

    return {
      event_type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED,
      entity_type: "extension_descriptor",
      entity_id: input.descriptor_id,
      workspace_id: this.systemWorkspaceId,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      payload_json: payload
    };
  }

  private createDescriptorRegistrationRevertedEventEntry(
    input: {
      readonly descriptor_type: "tool_provider" | "skill_package";
      readonly descriptor_id: string;
    },
    originalEventId: string
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    const payload = deepFreeze(
      ExtensionDescriptorRegistrationRevertedPayloadSchema.parse({
        descriptor_type: input.descriptor_type,
        descriptor_id: input.descriptor_id,
        original_event_id: originalEventId,
        reverted_at: readNow(this.deps.now)
      })
    );

    return {
      event_type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED,
      entity_type: "extension_descriptor",
      entity_id: input.descriptor_id,
      workspace_id: this.systemWorkspaceId,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      payload_json: payload
    };
  }

  private createDescriptorRegistrationCompensationFailedEventEntry(
    input: {
      readonly descriptor_type: "tool_provider" | "skill_package";
      readonly descriptor_id: string;
    },
    originalEventId: string
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    const payload = deepFreeze(
      ExtensionDescriptorRegistrationCompensationFailedPayloadSchema.parse({
        descriptor_type: input.descriptor_type,
        descriptor_id: input.descriptor_id,
        original_event_id: originalEventId,
        failed_at: readNow(this.deps.now)
      })
    );

    return {
      event_type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED,
      entity_type: "extension_descriptor",
      entity_id: input.descriptor_id,
      workspace_id: this.systemWorkspaceId,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      payload_json: payload
    };
  }

  private async ensureProviderCache(): Promise<Readonly<ProviderCacheSnapshot>> {
    while (this.providerCacheSnapshot === null) {
      if (this.providerCacheLoadPromise === null) {
        this.providerCacheLoadPromise = this.loadProviderCache();
      }

      const loadPromise = this.providerCacheLoadPromise;
      if (loadPromise === null) {
        continue;
      }
      let pendingSnapshot: Readonly<ProviderCacheSnapshot>;
      try {
        pendingSnapshot = await loadPromise;
      } catch (error) {
        if (this.providerCacheLoadPromise === loadPromise) {
          this.providerCacheLoadPromise = null;
        }
        throw error;
      }

      if (this.providerCacheSnapshot !== null) {
        return this.providerCacheSnapshot;
      }

      if (this.providerCacheLoadPromise === loadPromise) {
        this.publishProviderCache(pendingSnapshot);
        this.providerCacheLoadPromise = null;
        return pendingSnapshot;
      }
    }

    const snapshot = this.providerCacheSnapshot;
    if (snapshot === null) {
      throw new CoreError("CONFLICT", "Provider cache did not resolve.");
    }

    return snapshot;
  }

  private async loadProviderCache(): Promise<Readonly<ProviderCacheSnapshot>> {
    const providers = (await this.deps.extensionStore.findToolProviders()).map(
      (provider) => normalizeProvider(provider)
    );

    return createProviderCacheSnapshot(providers);
  }

  private async cacheProvider(provider: Readonly<ToolProvider>): Promise<void> {
    const normalizedProvider = normalizeProvider(provider);
    if (this.providerCacheSnapshot !== null) {
      this.publishProviderCache(
        mergeProviderIntoCacheSnapshot(this.providerCacheSnapshot, normalizedProvider)
      );
      return;
    }

    const existingLoadPromise = this.providerCacheLoadPromise;
    const baselinePromise = existingLoadPromise ?? this.loadProviderCache();
    const mergedPromise = baselinePromise.then((baselineSnapshot) => {
      const mergedSnapshot = mergeProviderIntoCacheSnapshot(
        this.providerCacheSnapshot ?? baselineSnapshot,
        normalizedProvider
      );
      this.publishProviderCache(mergedSnapshot);
      return mergedSnapshot;
    });
    this.providerCacheLoadPromise = mergedPromise;

    if (existingLoadPromise !== null) {
      void mergedPromise.catch(() => undefined);
      return;
    }

    try {
      await mergedPromise;
    } finally {
      if (this.providerCacheLoadPromise === mergedPromise) {
        this.providerCacheLoadPromise = null;
      }
    }
  }

  private publishProviderCache(snapshot: Readonly<ProviderCacheSnapshot>): void {
    this.providerCacheSnapshot = snapshot;
  }
}

function normalizeProvider(provider: Readonly<ToolProvider>): Readonly<ToolProvider> {
  return Object.isFrozen(provider) ? provider : parseExtensionToolProvider(provider);
}

function parseToolSpec(value: ToolSpec): Readonly<ToolSpec> {
  try {
    return deepFreeze(ToolSpecSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid tool spec payload", { cause: error });
  }
}

function buildDefaultToolSpec(
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

function createProviderCacheSnapshot(
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

function mergeProviderIntoCacheSnapshot(
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

function providerOwnsTool(
  provider: Readonly<ToolProvider> | null,
  toolId: string
): boolean {
  return provider?.tool_specs.some((tool) => tool.tool_id === toolId) ?? false;
}

function listRemovedToolIds(
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
