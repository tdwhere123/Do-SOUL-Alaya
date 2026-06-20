import type {
  EventLogEntry,
  SkillPackage,
  ToolProvider,
  ToolProviderToolSpec,
  ToolSpec
} from "@do-soul/alaya-protocol";
import type { ToolSpecService } from "./tool-spec-service.js";

export type ExtensionRegistryToolSpecPort = Pick<
  ToolSpecService,
  "findById" | "register" | "update" | "delete"
>;

export interface ToolSpecRollbackSnapshot {
  readonly toolId: string;
  readonly previous: Readonly<ToolSpec> | null;
}

export interface ProviderCacheSnapshot {
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
