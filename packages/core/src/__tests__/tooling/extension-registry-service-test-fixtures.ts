import { afterEach, vi } from "vitest";
import type { ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteExtensionDescriptorRepo,
  SqliteToolSpecRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { ExtensionRegistryService } from "../../tooling/extension-registry-service.js";
import { ToolSpecService } from "../../tooling/tool-spec-service.js";

export const validTimestamp = "2026-04-20T10:00:00.000Z";
const databases = new Set<StorageDatabase>();
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

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
  readonly defaultWorkspaceId?: string;
  readonly now?: () => string;
} = {}) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const extensionStore = new SqliteExtensionDescriptorRepo(database);
  const toolSpecRepo = new SqliteToolSpecRepo(database);
  for (const provider of input.initialProviders ?? []) extensionStore.registerToolProviderSync(provider);
  for (const spec of input.initialToolSpecs ?? []) toolSpecRepo.insertSync(spec);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const notifyEntry = vi.fn(async () => undefined);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runtimeNotifier: { notify: () => undefined, notifyEntry },
    runHotStateService: { apply: () => undefined }
  });
  const toolSpecService = new ToolSpecService({ toolSpecRepo });
  const service = new ExtensionRegistryService({
    extensionStore,
    toolSpecService,
    eventPublisher,
    now: input.now ?? (() => validTimestamp),
    ...(input.defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId: input.defaultWorkspaceId })
  });
  return { database, extensionStore, toolSpecRepo, toolSpecService, eventLogRepo, eventPublisher, notifyEntry, service };
}
