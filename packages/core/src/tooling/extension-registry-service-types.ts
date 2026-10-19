import type {
  SkillPackage,
  ToolProvider,
  ToolProviderToolSpec,
  ToolSpec
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../runtime/event-publisher.js";
import type { ToolSpecService } from "./tool-spec-service.js";

export type ExtensionRegistryToolSpecPort = Pick<
  ToolSpecService,
  "findByIdSync" | "registerSync" | "updateSync" | "deleteSync"
>;

export interface ProviderCacheSnapshot {
  readonly providerCacheById: ReadonlyMap<string, Readonly<ToolProvider>>;
  readonly providerCacheByToolId: ReadonlyMap<string, Readonly<ToolProvider>>;
  readonly providerList: readonly Readonly<ToolProvider>[];
}

export interface ExtensionStorePort {
  registerToolProviderSync(provider: ToolProvider): Readonly<ToolProvider>;
  registerSkillPackageSync(pkg: SkillPackage): Readonly<SkillPackage>;
  findToolProvidersSync(): readonly Readonly<ToolProvider>[];
  findToolProviderByIdSync(providerId: string): Readonly<ToolProvider> | null;
}

export interface ExtensionRegistryDependencies {
  readonly extensionStore: ExtensionStorePort;
  readonly toolSpecService: ExtensionRegistryToolSpecPort;
  readonly eventPublisher: EventPublisher;
  readonly now?: () => string;
  readonly buildToolSpecForProviderTool?: (
    provider: Readonly<ToolProvider>,
    tool: Readonly<ToolProviderToolSpec>,
    existing: Readonly<ToolSpec> | null
  ) => ToolSpec;
  readonly defaultWorkspaceId?: string;
}
