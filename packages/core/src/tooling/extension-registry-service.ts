import type { SkillPackage, ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import { reportAsyncSideEffectFailure } from "../runtime/async-side-effect-auditor.js";
import { CoreError } from "../shared/errors.js";
import { resolveSystemWorkspaceId } from "../shared/actors.js";
import {
  parseExtensionSkillPackage,
  parseExtensionToolProvider
} from "../shared/extension-descriptor-parsers.js";
import {
  buildDefaultToolSpec,
  createProviderCacheSnapshot,
  listRemovedToolIds,
  mergeProviderIntoCacheSnapshot,
  normalizeProvider,
  parseToolSpec,
  providerOwnsTool,
  toError
} from "./extension-registry-service-helpers.js";
import type {
  ExtensionRegistryDependencies,
  ProviderCacheSnapshot,
  ToolSpecRollbackSnapshot
} from "./extension-registry-service-types.js";
import {
  createDescriptorRegisteredEventEntry,
  createDescriptorRegistrationCompensationFailedEventEntry,
  createDescriptorRegistrationRevertedEventEntry,
  type DescriptorEventInput
} from "./extension-registry/events.js";
export type {
  ExtensionRegistryDependencies,
  ExtensionRegistryToolSpecPort,
  ExtensionStorePort,
  ProviderCacheSnapshot,
  ToolSpecRollbackSnapshot
} from "./extension-registry-service-types.js";

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
    input: DescriptorEventInput,
    mutate: () => Promise<T>,
    rollbackMutation?: () => Promise<void>
  ): Promise<T> {
    const entry = await this.deps.eventLogWriter.append(
      createDescriptorRegisteredEventEntry(input, this.systemWorkspaceId, this.deps.now)
    );

    let result: T;
    try {
      result = await mutate();
    } catch (error) {
      return await this.handleDescriptorMutationFailure(input, entry.event_id, error, rollbackMutation);
    }

    await this.deps.runtimeNotifier?.notifyEntry(entry);
    return result;
  }

  private async handleDescriptorMutationFailure(
    input: DescriptorEventInput,
    originalEventId: string,
    mutationError: unknown,
    rollbackMutation?: () => Promise<void>
  ): Promise<never> {
    if (rollbackMutation !== undefined) {
      await this.rollbackDescriptorMutation(input, originalEventId, mutationError, rollbackMutation);
    }
    await this.deps.eventLogWriter.append(
      createDescriptorRegistrationRevertedEventEntry(
        input,
        originalEventId,
        this.systemWorkspaceId,
        this.deps.now
      )
    );
    throw mutationError;
  }

  private async rollbackDescriptorMutation(
    input: DescriptorEventInput,
    originalEventId: string,
    mutationError: unknown,
    rollbackMutation: () => Promise<void>
  ): Promise<void> {
    try {
      await rollbackMutation();
    } catch (rollbackError) {
      await this.reportDescriptorRollbackFailure(input, originalEventId, mutationError, rollbackError);
    }
  }

  private async reportDescriptorRollbackFailure(
    input: {
      readonly descriptor_type: "tool_provider" | "skill_package";
      readonly descriptor_id: string;
    },
    originalEventId: string,
    mutationError: unknown,
    rollbackError: unknown
  ): Promise<never> {
    try {
      await this.deps.eventLogWriter.append(
        createDescriptorRegistrationCompensationFailedEventEntry(
          input,
          originalEventId,
          this.systemWorkspaceId,
          this.deps.now
        )
      );
    } catch (compensationError) {
      throw this.createDescriptorRollbackError(input, mutationError, rollbackError, compensationError);
    }
    throw this.createDescriptorRollbackError(input, mutationError, rollbackError);
  }

  private createDescriptorRollbackError(
    input: {
      readonly descriptor_type: "tool_provider" | "skill_package";
      readonly descriptor_id: string;
    },
    mutationError: unknown,
    rollbackError: unknown,
    compensationError?: unknown
  ): CoreError {
    return new CoreError(
      "CONFLICT",
      `Failed to roll back ${input.descriptor_type} ${input.descriptor_id} after mutation failure.`,
      {
        cause: new AggregateError(
          compensationError === undefined
            ? [toError(rollbackError)]
            : [toError(rollbackError), toError(compensationError)],
          compensationError === undefined
            ? "Rollback failed after mutation failure."
            : "Rollback failed after mutation failure and failure compensation could not be recorded.",
          { cause: toError(mutationError) }
        )
      }
    );
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
    const mergedPromise = baselinePromise
      .then((baselineSnapshot) => {
        const mergedSnapshot = mergeProviderIntoCacheSnapshot(
          this.providerCacheSnapshot ?? baselineSnapshot,
          normalizedProvider
        );
        this.publishProviderCache(mergedSnapshot);
        return mergedSnapshot;
      })
      .catch(async (error) => {
        // Degrade to last-good (or empty) cache so a failed provider merge
        // cannot wedge the cache load for later callers.
        await reportAsyncSideEffectFailure(
          {
            source: "ExtensionRegistryService",
            operation: "provider_cache_merge",
            subjectType: "extension_descriptor",
            subjectId: normalizedProvider.provider_id,
            workspaceId: this.systemWorkspaceId,
            runId: null,
            causedBy: "system",
            warningCode: "ALAYA_EXTENSION_CACHE_MERGE_DEGRADED",
            warningMessage: "[ExtensionRegistryService] provider cache merge failed; degrading to last-good",
            eventLogRepo: this.deps.eventLogWriter,
            runtimeNotifier: this.deps.runtimeNotifier,
            now: this.deps.now
          },
          error
        );
        return this.providerCacheSnapshot ?? createProviderCacheSnapshot([]);
      });
    this.providerCacheLoadPromise = mergedPromise;

    if (existingLoadPromise !== null) {
      void mergedPromise.then((snapshot) => {
        if (this.providerCacheLoadPromise === mergedPromise) {
          this.providerCacheLoadPromise = null;
        }
        if (this.providerCacheSnapshot === null) {
          this.publishProviderCache(snapshot);
        }
      }).catch(() => undefined);
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
