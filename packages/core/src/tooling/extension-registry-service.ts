import type { SkillPackage, ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { resolveSystemWorkspaceId } from "../shared/actors.js";
import {
  parseExtensionSkillPackage,
  parseExtensionToolProvider
} from "./extension-descriptor-parsers.js";
import {
  buildDefaultToolSpec,
  createProviderCacheSnapshot,
  listRemovedToolIds,
  normalizeProvider,
  providerOwnsTool
} from "./extension-registry-service-helpers.js";
import type {
  ExtensionRegistryDependencies,
  ProviderCacheSnapshot
} from "./extension-registry-service-types.js";
import { createDescriptorRegisteredEventEntry } from "./extension-registry/events.js";
export type {
  ExtensionRegistryDependencies,
  ExtensionRegistryToolSpecPort,
  ExtensionStorePort,
  ProviderCacheSnapshot
} from "./extension-registry-service-types.js";

export class ExtensionRegistryService {
  private providerCacheSnapshot: Readonly<ProviderCacheSnapshot> | null = null;
  private readonly systemWorkspaceId: string;

  public constructor(private readonly deps: ExtensionRegistryDependencies) {
    this.systemWorkspaceId = resolveSystemWorkspaceId(deps.defaultWorkspaceId);
  }

  public async registerProvider(provider: ToolProvider): Promise<Readonly<ToolProvider>> {
    const parsedProvider = parseExtensionToolProvider(provider);
    const entry = createDescriptorRegisteredEventEntry({
      descriptor_type: "tool_provider",
      descriptor_id: parsedProvider.provider_id,
      name: parsedProvider.name,
      source: parsedProvider.source
    }, this.systemWorkspaceId, this.deps.now);
    // No await separates invalidation from the synchronous transaction. Listeners
    // can only refill from committed storage, even if propagation later fails.
    this.providerCacheSnapshot = null;
    return await this.deps.eventPublisher.appendManyWithMutation([entry], () =>
      this.applyProviderRegistration(parsedProvider)
    );
  }

  private applyProviderRegistration(provider: Readonly<ToolProvider>): Readonly<ToolProvider> {
    const owners = createProviderCacheSnapshot(this.deps.extensionStore.findToolProvidersSync());
    const previousProvider = this.deps.extensionStore.findToolProviderByIdSync(provider.provider_id);
    const storedProvider = normalizeProvider(this.deps.extensionStore.registerToolProviderSync(provider));
    for (const tool of storedProvider.tool_specs) {
      const existing = this.findToolSpec(tool.tool_id);
      this.assertToolOwnershipAvailable(storedProvider, previousProvider, owners, tool.tool_id, existing);
      const spec = this.deps.buildToolSpecForProviderTool?.(storedProvider, tool, existing) ??
        buildDefaultToolSpec(storedProvider, tool, existing);
      if (existing === null) {
        this.deps.toolSpecService.registerSync(spec);
      } else {
        this.deps.toolSpecService.updateSync(spec);
      }
    }
    for (const toolId of listRemovedToolIds(previousProvider, storedProvider)) {
      this.deps.toolSpecService.deleteSync(toolId);
    }
    return storedProvider;
  }

  public async registerSkillPackage(pkg: SkillPackage): Promise<Readonly<SkillPackage>> {
    const parsedPackage = parseExtensionSkillPackage(pkg);
    return await this.deps.eventPublisher.appendManyWithMutation([
      createDescriptorRegisteredEventEntry({
        descriptor_type: "skill_package",
        descriptor_id: parsedPackage.skill_id,
        name: parsedPackage.name,
        source: parsedPackage.source
      }, this.systemWorkspaceId, this.deps.now)
    ], () => this.deps.extensionStore.registerSkillPackageSync(parsedPackage));
  }

  public async listProviders(): Promise<readonly Readonly<ToolProvider>[]> {
    return this.ensureProviderCache().providerList;
  }

  public async findProviderForTool(toolId: string): Promise<Readonly<ToolProvider> | null> {
    return this.ensureProviderCache().providerCacheByToolId.get(toolId) ?? null;
  }

  private findToolSpec(toolId: string): Readonly<ToolSpec> | null {
    try {
      return this.deps.toolSpecService.findByIdSync(toolId);
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  private assertToolOwnershipAvailable(
    provider: Readonly<ToolProvider>,
    previousProvider: Readonly<ToolProvider> | null,
    owners: Readonly<ProviderCacheSnapshot>,
    toolId: string,
    existingToolSpec: Readonly<ToolSpec> | null
  ): void {
    const owner = owners.providerCacheByToolId.get(toolId);
    if (owner !== undefined && owner.provider_id !== provider.provider_id) {
      throw new CoreError(
        "CONFLICT",
        `Tool ${toolId} is already owned by provider ${owner.provider_id}; provider ${provider.provider_id} cannot claim it.`
      );
    }
    if (providerOwnsTool(previousProvider, toolId) || existingToolSpec === null || provider.source === "builtin") {
      return;
    }
    throw new CoreError(
      "CONFLICT",
      `Tool ${toolId} already has a registered tool spec; provider ${provider.provider_id} cannot claim it without matching descriptor ownership.`
    );
  }

  private ensureProviderCache(): Readonly<ProviderCacheSnapshot> {
    if (this.providerCacheSnapshot === null) {
      this.providerCacheSnapshot = createProviderCacheSnapshot(
        this.deps.extensionStore.findToolProvidersSync().map(normalizeProvider)
      );
    }
    return this.providerCacheSnapshot;
  }
}
