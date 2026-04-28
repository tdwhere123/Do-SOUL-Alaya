import { vi } from "vitest";
import type {
  ConversationRuntimeContext,
  ToolProvider,
  ToolSpec,
  ToolUseBlock
} from "@do-what/protocol";
import type { ConversationServiceDependencies } from "@do-what/core";

type MockToolResultBlock = Readonly<{
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}>;

type MockToolsHandler = (
  toolUse: ToolUseBlock,
  runtimeContext?: Readonly<ConversationRuntimeContext>
) => Promise<MockToolResultBlock>;

type MockMcpBridgeDeps = Readonly<{
  readonly toolsHandler?: MockToolsHandler;
  readonly soulHandler?: MockToolsHandler;
  readonly hasConversationToolName?: (toolName: string) => boolean;
}>;

type MockConversationServiceDeps = Pick<
  ConversationServiceDependencies,
  "contextLensAssembler" | "engine" | "gardenComputeProvider" | "resolveExecutionStance"
>;

const hoisted = vi.hoisted(() => {
  const conversationToolSpecs = [
    {
      tool_id: "tools.read_file",
      category: "read",
      description: "Read a file",
      scope_guard: "workspace",
      read_only: true,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: true
    },
    {
      tool_id: "tools.list_directory",
      category: "read",
      description: "List a directory",
      scope_guard: "workspace",
      read_only: true,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: true
    },
    {
      tool_id: "tools.search_files",
      category: "read",
      description: "Search files",
      scope_guard: "workspace",
      read_only: true,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: true
    },
    {
      tool_id: "tools.write_file",
      category: "write",
      description: "Write a file",
      scope_guard: "workspace",
      read_only: false,
      destructive: false,
      concurrency_safe: false,
      interrupt_behavior: "wait",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "best_effort",
      fast_path_eligible: false
    },
    {
      tool_id: "tools.exec_shell",
      category: "exec",
      description: "Execute a command",
      scope_guard: "project",
      read_only: false,
      destructive: true,
      concurrency_safe: false,
      interrupt_behavior: "abort",
      requires_confirmation: true,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: false
    }
  ] as const satisfies readonly Readonly<ToolSpec>[];

  const database = {
    filename: ":memory:",
    connection: {},
    close: vi.fn()
  };

  const workspace = {
    workspace_id: "workspace-1",
    root_path: "/workspace/project"
  };

  const eventLogRepo = {
    append: vi.fn(async (entry: unknown) => ({
      event_id: "event-1",
      created_at: "2026-04-12T10:00:00.000Z",
      ...((entry as Record<string, unknown>) ?? {})
    })),
    queryByRun: vi.fn(async () => [])
  };

  const sseManager = {
    broadcastEntry: vi.fn(async () => undefined)
  };

  const toolSpecMap = new Map<string, Readonly<ToolSpec>>(
    conversationToolSpecs.map((spec) => [spec.tool_id, { ...spec }])
  );
  const resetToolSpecMap = () => {
    toolSpecMap.clear();
    for (const spec of conversationToolSpecs) {
      toolSpecMap.set(spec.tool_id, { ...spec });
    }
  };

  const toolSpecService = {
    register: vi.fn(async (spec: Readonly<ToolSpec>) => {
      toolSpecMap.set(spec.tool_id, { ...spec });
      return spec;
    }),
    update: vi.fn(async (spec: Readonly<ToolSpec>) => {
      toolSpecMap.set(spec.tool_id, { ...spec });
      return spec;
    }),
    findById: vi.fn(async (toolId: string) => {
      const spec = toolSpecMap.get(toolId);
      if (spec !== undefined) {
        return spec;
      }

      return {
        tool_id: toolId,
        category: "exec",
        description: `Discovered tool ${toolId}`,
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
    })
  };

  const readFile = vi.fn(async () => ({
    ok: true,
    content: "hello",
    bytesRead: 5
  }));

  const listDirectory = vi.fn(async () => ({
    ok: true,
    entries: []
  }));

  const searchFiles = vi.fn(async () => ({
    ok: true,
    paths: []
  }));

  const writeFile = vi.fn(async () => ({
    ok: true,
    bytesWritten: 5
  }));

  const execShell = vi.fn(async () => ({
    ok: true,
    exitCode: 0,
    stdout: "ok\n",
    stderr: ""
  }));

  const pathGraphSnapshot = {
    snapshot_id: "snapshot-1",
    workspace_id: "workspace-1",
    total_active_paths: 0,
    total_retired_paths: 0,
    strength_distribution: {
      very_weak: 0,
      weak: 0,
      moderate: 0,
      strong: 0,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 0,
      normal: 0,
      stable: 0,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 0,
      attention_only: 0,
      recall_allowed: 0,
      strictly_governed: 0
    },
    connectivity: {
      unique_source_anchors: 0,
      unique_target_anchors: 0,
      max_out_degree: 0,
      max_in_degree: 0,
      isolated_anchors: 0
    },
    paths_reinforced_since_last: 0,
    paths_weakened_since_last: 0,
    paths_retired_since_last: 0,
    paths_created_since_last: 0,
    snapshot_at: "2026-04-12T10:00:00.000Z"
  };

  const toolHotPathExecute = vi.fn(async (request: {
    readonly toolId: string;
    readonly rawInput: unknown;
    readonly handler: (context: { readonly writableRoots: readonly string[] }, input: unknown) => Promise<unknown>;
  }) => ({
    result: await request.handler({ writableRoots: [workspace.root_path] }, request.rawInput),
    executionRecord: {
      execution_id: "exec-1",
      tool_id: request.toolId,
      requested_by: "principal",
      requesting_run_id: "run-1",
      governance_decision_ref: "fast-path://skipped",
      permission_result: "allow",
      executed: true,
      started_at: "2026-04-12T10:00:00.000Z",
      ended_at: "2026-04-12T10:00:01.000Z",
      result_summary: "ok",
      rollback_status: "none"
    },
    permissionResult: "allow"
  }));

  const bridgeCtor = vi.fn().mockImplementation(function McpBridge(deps: MockMcpBridgeDeps) {
    hoisted.mcpBridgeDeps = deps;
    return {};
  });
  const canonicalAliasServiceInstance = {
    publishGovernanceSubjectCanonicalization: vi.fn(async () => ({
      subject_domain: "tooling.policy",
      subject_qualifiers: { scope: "project", tool: "tools.write_file" },
      canonical_key: "tooling.policy::scope=project,tool=tools.write_file"
    })),
    planGovernanceSubjectCanonicalization: vi.fn(() => ({
      governanceSubject: {
        subject_domain: "code_style",
        subject_qualifiers: { language: "typescript" },
        canonical_key: "code_style::language=typescript"
      },
      eventInputs: [],
      nextRevision: 0
    }))
  };
  const canonicalAliasServiceCtor = vi.fn().mockImplementation(function CanonicalAliasService(deps) {
    hoisted.canonicalAliasServiceDeps = deps;
    return canonicalAliasServiceInstance;
  });
  const claimServiceCtor = vi.fn().mockImplementation(function ClaimService(deps) {
    hoisted.claimServiceDeps = deps;
    return {};
  });
  const conversationToolExecutorCtor = vi.fn().mockImplementation(function ConversationToolExecutor(deps) {
    hoisted.conversationToolExecutorDeps = deps;
    return {
      execute: hoisted.toolHotPathExecute
    };
  });
  const computeRoutingRoute = vi.fn(async () => ({
    decision_id: "decision-1",
    workspace_id: "workspace-1",
    selected_provider: "stub",
    model_id: "local-heuristics",
    adapter: "garden.local_heuristics",
    selection_reason: "stub selected as configured fallback compute provider",
    decided_at: "2026-04-12T10:00:00.000Z"
  }));
  const computeRoutingToModelRef = vi.fn(() => ({
    provider: "stub",
    model_id: "local-heuristics",
    adapter: "garden.local_heuristics"
  }));
  const localHeuristicsInstance = {
    provider_kind: "local_heuristics" as const,
    compile: vi.fn(async () => [])
  };
  const localHeuristicsCtor = vi.fn().mockImplementation(function LocalHeuristics() {
    return localHeuristicsInstance;
  });
  const officialGardenProviderInstance = {
    provider_kind: "official_api" as const,
    compile: vi.fn(async () => [])
  };
  const officialGardenProviderCtor = vi.fn().mockImplementation(function OfficialGardenProvider(deps) {
    hoisted.officialGardenProviderDeps = deps;
    return officialGardenProviderInstance;
  });
  const computeRoutingServiceCtor = vi.fn().mockImplementation(function ComputeRoutingService(deps) {
    hoisted.computeRoutingServiceDeps = deps;
    return {
      route: hoisted.computeRoutingRoute,
      toModelRef: hoisted.computeRoutingToModelRef,
      getDefaultProvider: vi.fn(() => deps.providers[0]?.provider ?? localHeuristicsInstance),
      resolveProvider: vi.fn((modelRef) => {
        if (modelRef == null) {
          return null;
        }

        return (
          deps.providers.find(
            (candidate: {
              readonly kind: string;
              readonly model_id: string;
              readonly adapter?: string;
              readonly provider: unknown;
            }) =>
              candidate.kind === modelRef.provider &&
              candidate.model_id === modelRef.model_id &&
              (candidate.adapter ?? null) === (modelRef.adapter ?? null)
          )?.provider ?? null
        );
      })
    };
  });
  const stanceResolutionResolve = vi.fn(async () => ({
    resolution_id: "resolution-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    verification_attention: "standard",
    conservatism: "balanced",
    contributing_candidate_ids: [],
    model_ref: {
      provider: "stub",
      model_id: "local-heuristics",
      adapter: "garden.local_heuristics"
    },
    resolved_at: "2026-04-12T10:00:00.000Z"
  }));
  const extensionProviders: Readonly<ToolProvider>[] = [];
  const runtimeConversationToolSpecs = [...conversationToolSpecs];
  const resetRuntimeConversationToolSpecs = () => {
    runtimeConversationToolSpecs.splice(0, runtimeConversationToolSpecs.length, ...conversationToolSpecs);
  };
  const mcpDiscoverAndRegister = vi.fn(async () => []);
  const engineToolSnapshots: string[][] = [];
  const mcpRuntimeServerTools = new Map<
    string,
    readonly {
      readonly name: string;
      readonly description: string;
    }[]
  >();
  const mcpRuntimeServerInfos: Array<{
    readonly server_name: string;
    readonly transport_type: "stdio" | "http";
    readonly endpoint?: string;
    readonly status: "active";
    readonly registered_at: string;
  }> = [];
  const mcpRuntimeRefresh = vi.fn(async () => undefined);
  const mcpRuntimeClose = vi.fn(async () => undefined);
  const mcpRuntimeCallTool = vi.fn(async ({ serverName, toolName, input }: {
    readonly serverName: string;
    readonly toolName: string;
    readonly input: unknown;
  }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, serverName, toolName, input })
      }
    ]
  }));
  const resetMcpRuntimeState = () => {
    mcpRuntimeServerTools.clear();
    mcpRuntimeServerInfos.splice(0, mcpRuntimeServerInfos.length);
  };
  const apiConversationEngineSendMessage = vi.fn(async () => {
    engineToolSnapshots.push(
      ((hoisted.apiConversationToolDefsFactory?.() ?? []) as Array<{ readonly name?: unknown }>).map((def) =>
        String(def.name ?? "")
      )
    );
    return {
      message: {
        role: "assistant",
        content: "ok",
        message_id: "msg-assistant-1"
      },
      finish_reason: "stop"
    };
  });
  const apiConversationEngineStreamMessage = vi.fn(async function* () {});
  const apiConversationEngineCtor = vi.fn().mockImplementation(function APIConversationEngine(deps: {
    readonly getConversationToolDefs?: () => readonly { readonly name?: unknown }[];
  }) {
    hoisted.apiConversationToolDefsFactory =
      deps.getConversationToolDefs as (() => readonly { readonly name: string }[]) | undefined;
    return {
      sendMessage: apiConversationEngineSendMessage,
      streamMessage: apiConversationEngineStreamMessage
    };
  });
  const serverClose = vi.fn();

  return {
    conversationToolSpecs,
    resetToolSpecMap,
    database,
    workspace,
    eventLogRepo,
    sseManager,
    toolSpecService,
    readFile,
    listDirectory,
    searchFiles,
    writeFile,
    execShell,
    toolHotPathExecute,
    bridgeCtor,
    extensionProviders,
    mcpDiscoverAndRegister,
    engineToolSnapshots,
    mcpRuntimeServerTools,
    mcpRuntimeServerInfos,
    mcpRuntimeRefresh,
    mcpRuntimeClose,
    mcpRuntimeCallTool,
    resetMcpRuntimeState,
    apiConversationEngineCtor,
    apiConversationEngineSendMessage,
    apiConversationEngineStreamMessage,
    resetRuntimeConversationToolSpecs,
    apiConversationToolDefsFactory: undefined as
      | undefined
      | (() => readonly { readonly name: string }[]),
    computeRoutingRoute,
    computeRoutingToModelRef,
    computeRoutingServiceCtor,
    computeRoutingServiceDeps: null as null | Record<string, unknown>,
    stanceResolutionResolve,
    createApp: vi.fn(() => ({ fetch: vi.fn() })),
    createEnvironmentStatusService: vi.fn(() => ({
      getStatus: vi.fn(async () => ({
        tools: {
          git: true,
          node: true,
          pnpm: true,
          rg: true,
          claude: true,
          bwrap: true,
          socat: false
        },
        active_worktrees: 0,
        db_path: ":memory:",
        files_dir: "/tmp/do-what-files"
      }))
    })),
    mcpBridgeDeps: null as MockMcpBridgeDeps | null,
    canonicalAliasServiceDeps: null as null | Record<string, unknown>,
    claimServiceDeps: null as null | Record<string, unknown>,
    conversationToolExecutorDeps: null as null | Record<string, unknown>,
    canonicalAliasServiceCtor,
    claimServiceCtor,
    conversationToolExecutorCtor,
    conversationServiceDeps: null as MockConversationServiceDeps | null,
    localHeuristicsCtor,
    localHeuristicsInstance,
    officialGardenProviderCtor,
    officialGardenProviderDeps: null as null | Record<string, unknown>,
    officialGardenProviderInstance,
    serve: vi.fn(() => ({ close: serverClose })),
    serverClose,
    backgroundManagerStart: vi.fn(),
    backgroundManagerStop: vi.fn(),
    backgroundManagers: [] as Array<{
      readonly services: readonly {
        readonly name: string;
        readonly intervalMs: number;
        readonly task: () => Promise<void>;
      }[];
      readonly start: ReturnType<typeof vi.fn>;
      readonly stop: ReturnType<typeof vi.fn>;
    }>,
    gardenBacklogTelemetryServices: [] as Array<{
      readonly start: ReturnType<typeof vi.fn>;
      readonly stop: ReturnType<typeof vi.fn>;
      readonly capture: ReturnType<typeof vi.fn>;
      readonly getSnapshot: ReturnType<typeof vi.fn>;
    }>,
    pathGraphSnapshotterBuildSnapshot: vi.fn(async () => pathGraphSnapshot),
    reviewPathGraphSnapshotHistory: vi.fn(() => null),
    contextLensAssemble: vi.fn(async () => ({
      contextLens: null,
      workingProjection: {
        entries: [],
        total_token_estimate: 0
      }
    })),
    manifestationResolve: vi.fn(async () => [])
  };
});

const ORIGINAL_DO_WHAT_MCP_TOOL_CATALOG_JSON = process.env.DO_WHAT_MCP_TOOL_CATALOG_JSON;
const ORIGINAL_DO_WHAT_ALLOWED_MCP_SERVERS = process.env.DO_WHAT_ALLOWED_MCP_SERVERS;
const ORIGINAL_DO_WHAT_MCP_SERVER_CONFIG_JSON = process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_OFFICIAL_GARDEN_MODEL = process.env.OFFICIAL_GARDEN_MODEL;

vi.mock("@do-what/protocol", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-what/protocol");

  return {
    ...actual,
    WriteFileToolInputSchema: actual["WriteFileToolInputSchema"],
    WriteFileToolResultSchema: actual["WriteFileToolResultSchema"],
    ExecShellToolInputSchema: actual["ExecShellToolInputSchema"],
    ExecShellToolResultSchema: actual["ExecShellToolResultSchema"]
  };
});

vi.mock("@hono/node-server", () => ({
  serve: hoisted.serve
}));

vi.mock("../app.js", () => ({
  createApp: hoisted.createApp
}));

vi.mock("../background/bootstrap.js", () => ({
  BackgroundServiceManager: vi.fn().mockImplementation(function BackgroundServiceManager(services) {
    const manager = {
      services,
      start: hoisted.backgroundManagerStart,
      stop: hoisted.backgroundManagerStop
    };
    hoisted.backgroundManagers.push(manager);
    return manager;
  })
}));

vi.mock("../budget-wiring.js", () => ({
  createBudgetProposalPort: vi.fn(() => ({}))
}));

vi.mock("../files-data-dir.js", () => ({
  resolveCoreDaemonFilesDirectory: vi.fn(() => "/tmp/do-what-files")
}));

vi.mock("../orphan-query.js", () => ({
  findOrphanedMemoriesForWorkspace: vi.fn(async () => [])
}));

vi.mock("../services/config-service.js", () => ({
  createConfigService: vi.fn(() => ({}))
}));

vi.mock("../services/environment-status-service.js", () => ({
  createEnvironmentStatusService: hoisted.createEnvironmentStatusService
}));

vi.mock("../services/soul-approval-service.js", () => ({
  createSoulApprovalService: vi.fn(() => ({}))
}));

vi.mock("../sse/sse-manager.js", () => ({
  SseManager: vi.fn().mockImplementation(function SseManager() {
    return hoisted.sseManager;
  })
}));

vi.mock("../handoff-gap-adapter.js", () => ({
  SqliteHandoffGapAdapter: vi.fn().mockImplementation(function SqliteHandoffGapAdapter() {
    return {};
  })
}));

vi.mock("../mcp-runtime-registry.js", () => ({
  createDaemonMcpRuntimeRegistry: vi.fn(() => ({
    listServerInfos: vi.fn(() => hoisted.mcpRuntimeServerInfos),
    refresh: hoisted.mcpRuntimeRefresh,
    close: hoisted.mcpRuntimeClose,
    getServerTools: vi.fn((serverName: string) => hoisted.mcpRuntimeServerTools.get(serverName) ?? []),
    listServerTools: vi.fn(async (serverName: string) => hoisted.mcpRuntimeServerTools.get(serverName) ?? []),
    callTool: hoisted.mcpRuntimeCallTool
  }))
}));

vi.mock("@do-what/storage", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-what/storage");
  const makeRepo = (extra: Record<string, unknown> = {}) =>
    vi.fn().mockImplementation(function MockRepo() {
      return extra;
    });

  const gardenBackgroundDataPorts = {
    tieringPort: {},
    evidenceCheckPort: {},
    pointerHealthPort: {},
    greenMaintenancePort: {},
    bootstrappingPort: {},
    mergePort: {},
    neighborPort: {},
    compressionPort: {},
    synthesisPort: {}
  };

  return {
    ...actual,
    initDatabase: vi.fn(() => hoisted.database),
    createGardenBackgroundDataPorts: vi.fn(() => gardenBackgroundDataPorts),
    SqliteMemoryEmbeddingRepo: undefined,
    SqliteWorkspaceRepo: vi.fn().mockImplementation(function SqliteWorkspaceRepo() {
      return {
        getById: vi.fn(async () => hoisted.workspace),
        list: vi.fn(async () => [])
      };
    }),
    SqliteRunRepo: makeRepo({
      getById: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: hoisted.workspace.workspace_id
      }))
    }),
    SqliteEngineBindingRepo: makeRepo(),
    SqliteEventLogRepo: vi.fn().mockImplementation(function SqliteEventLogRepo() {
      return hoisted.eventLogRepo;
    }),
    SqliteSignalRepo: makeRepo(),
    SqliteEvidenceCapsuleRepo: makeRepo(),
    SqliteMemoryEntryRepo: makeRepo(),
    SqliteMemoryGraphEdgeRepo: makeRepo(),
    SqliteOrphanRadarRepo: makeRepo(),
    SqliteProjectMappingAnchorRepo: makeRepo(),
    SqliteSynthesisCapsuleRepo: makeRepo(),
    SqliteClaimFormRepo: makeRepo({
      findByWorkspaceId: vi.fn(async () => [])
    }),
    SqliteConflictMatrixRepo: makeRepo(),
    SqliteSlotRepo: makeRepo({
      findByWorkspace: vi.fn(async () => [])
    }),
    SqliteSurfaceIdentityRepo: makeRepo(),
    SqliteSurfaceAnchorRepo: makeRepo(),
    SqliteSurfaceBindingRepo: makeRepo(),
    SqliteCrossCuttingPermissionRepo: makeRepo(),
    SqliteProposalRepo: makeRepo(),
    SqliteGreenStatusRepo: makeRepo(),
    SqliteHealthJournalRepo: makeRepo(),
    SqliteFileRepo: makeRepo(),
    SqliteKarmaEventRepo: makeRepo(),
    SqliteConfigRepo: makeRepo(),
    SqliteHandoffGapRepo: makeRepo({
      findExpiredObjectsByWorkspace: vi.fn(async () => []),
      deleteById: vi.fn(() => undefined)
    }),
    SqliteToolSpecRepo: makeRepo(),
    SqliteToolExecutionRecordRepo: makeRepo(),
    SqliteExtensionDescriptorRepo: makeRepo({
      registerToolProvider: vi.fn(async (provider: unknown) => provider),
      registerSkillPackage: vi.fn(async (pkg: unknown) => pkg),
      findToolProviders: vi.fn(async () => []),
      findToolProviderByToolId: vi.fn(async () => null)
    }),
    SqliteStrongRefRepo: makeRepo(),
    SqlitePathRelationRepo: makeRepo({
      findActive: vi.fn(async () => [])
    }),
    SqliteBootstrappingRecordRepo: makeRepo({
      create: vi.fn(async (record: unknown) => record),
      findByWorkspace: vi.fn(async () => null)
    }),
    SqlitePathGraphSnapshotRepo: makeRepo({
      findLatest: vi.fn(async () => null),
      create: vi.fn(async (snapshot: unknown) => snapshot),
      findHistory: vi.fn(async () => []),
      deleteOlderThan: vi.fn(async () => 0)
    }),
    SqliteDriftLeaseRepo: makeRepo({
      create: vi.fn(async (lease: unknown) => lease),
      findActive: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      deleteExpired: vi.fn(async () => 0)
    }),
    SqliteDeferredObligationRepo: makeRepo(),
    SqliteDirtyStateDossierRepo: makeRepo(),
    SqliteWorkerRunRepo: makeRepo()
  };
});

vi.mock("@do-what/core", () => {
  const makeClass = (instance: Record<string, unknown> = {}) =>
    vi.fn().mockImplementation(function MockClass() {
      return instance;
    });
  class CoreError extends Error {
    public readonly code: "VALIDATION" | "NOT_FOUND" | "CONFLICT";

    public constructor(
      code: "VALIDATION" | "NOT_FOUND" | "CONFLICT",
      message: string,
      options?: ErrorOptions
    ) {
      super(message, options);
      this.name = "CoreError";
      this.code = code;
    }
  }

  return {
    ArbitrationService: makeClass(),
    ApprovalSink: vi.fn().mockImplementation(function ApprovalSink() {
      return { requestApproval: vi.fn(async () => "approved") };
    }),
    BudgetBankruptcyService: makeClass({
      getSnapshot: vi.fn(async () => ({ current_mode: "full" }))
    }),
    CanonicalAliasService: hoisted.canonicalAliasServiceCtor,
    ConstraintProxy: makeClass(),
    CircuitBreaker: vi.fn().mockImplementation(function CircuitBreaker() {
      return {
        getState: vi.fn(() => ({
          postureLevel: 0,
          additionalDeniedCategories: [],
          cooldownUntil: null
        })),
        recordOutcome: vi.fn(async () => undefined)
      };
    }),
    ClaimService: hoisted.claimServiceCtor,
    ConstitutionalFragmentService: makeClass({
      ensureRegistered: vi.fn(async (fragment: unknown) => fragment),
      listForWorkspace: vi.fn(async () => [])
    }),
    ConversationToolExecutor: hoisted.conversationToolExecutorCtor,
    ContextLensAssembler: vi.fn().mockImplementation(function ContextLensAssembler() {
      return {
        assemble: hoisted.contextLensAssemble,
        getLastLens: vi.fn(() => null),
        clearLens: vi.fn(() => undefined)
      };
    }),
    ConversationService: vi.fn().mockImplementation(function ConversationService(deps: MockConversationServiceDeps) {
      hoisted.conversationServiceDeps = deps;
      return {};
    }),
    createGlobalMemoryRecallPort: vi.fn().mockImplementation(() => ({
      recall: vi.fn(async () => [])
    })),
    CrossCuttingPermissionService: makeClass(),
    ClaudeRuntimeAdapter: makeClass(),
    DynamicsService: makeClass(),
    DeferredObligationService: makeClass(),
    DirtyStatePanicService: makeClass(),
    EngineBindingService: makeClass({
      resolveConversationBinding: vi.fn(async () => ({
        binding_id: "binding-1",
        provider: "openai",
        base_url: null,
        model: "gpt-4o-mini",
        api_key: "sk-test",
        config: {}
      }))
    }),
    EventPublisher: makeClass(),
    EvidenceService: makeClass(),
    ExtensionRegistryService: vi.fn().mockImplementation(function ExtensionRegistryService() {
      return {
        registerProvider: vi.fn(async (provider: Readonly<ToolProvider>) => {
          const providerId = provider.provider_id;
          if (providerId.length > 0) {
            const existingIndex = hoisted.extensionProviders.findIndex(
              (candidate) => candidate.provider_id === providerId
            );
            if (existingIndex >= 0) {
              hoisted.extensionProviders.splice(existingIndex, 1, provider);
            } else {
              hoisted.extensionProviders.push(provider);
            }
          }
          return provider;
        }),
        registerSkillPackage: vi.fn(async (pkg: unknown) => pkg),
        listProviders: vi.fn(async () => hoisted.extensionProviders),
        findProviderForTool: vi.fn(async (toolId: string) => {
          const provider = hoisted.extensionProviders.find((candidate) =>
            candidate.tool_specs.some((spec) => spec.tool_id === toolId)
          );
          return provider ?? null;
        })
      };
    }),
    GovernanceLeaseService: makeClass(),
    SurfaceDriftService: makeClass(),
    GraphExploreService: makeClass(),
    GardenBacklogTelemetryService: vi.fn().mockImplementation(function GardenBacklogTelemetryService() {
      const instance = {
        start: vi.fn(() => undefined),
        stop: vi.fn(async () => undefined),
        capture: vi.fn(async () => undefined),
        getSnapshot: vi.fn(() => ({
          workspace_id: null,
          observed_at: "2026-04-23T08:00:00.000Z",
          queue_depth_total: 0,
        queue_depth_by_tier: {
          tier_0: 0,
          tier_1: 0,
          tier_2: 0
        },
        in_flight_total: 0,
        warning_active: false
      }))
      };
      hoisted.gardenBacklogTelemetryServices.push(instance);
      return instance;
    }),
    GreenService: makeClass(),
    HealthJournalService: makeClass(),
    IntegrationGate: makeClass(),
    MemoryService: makeClass({
      findById: vi.fn(async () => null)
    }),
    McpToolDiscoveryService: vi.fn().mockImplementation(function McpToolDiscoveryService(deps: {
      readonly extensionRegistry: { registerProvider(provider: Readonly<ToolProvider>): Promise<unknown> };
      readonly mcpToolCatalog: {
        listServerTools(server: { readonly server_name: string }): Promise<readonly Readonly<ToolProvider["tool_specs"][number]>[]>;
      };
    }) {
      return {
        discoverAndRegister: vi.fn(async (servers: readonly { readonly server_name: string }[]) => {
          await hoisted.mcpDiscoverAndRegister(servers);
          for (const server of servers) {
            const tools = await deps.mcpToolCatalog.listServerTools(server);
            if (tools.length === 0) {
              continue;
            }

            await deps.extensionRegistry.registerProvider({
              provider_id: `provider.mcp.${server.server_name}`,
              name: `${server.server_name} MCP Provider`,
              source: "mcp_external",
              tool_specs: tools,
              requires_permission_check: true,
              records_execution: true,
              registered_at: "2026-04-20T12:00:00.000Z"
            });
          }

          return [];
        })
      };
    }),
    NarrativeBudgetService: makeClass({
      checkBudget: vi.fn(async () => ({
        digest_count: 0,
        digest_bytes: 0,
        exceeds_limit: false
      })),
      triggerConsolidation: vi.fn(async () => undefined)
    }),
    ManifestationResolver: vi.fn().mockImplementation(function ManifestationResolver() {
      return {
        resolve: hoisted.manifestationResolve
      };
    }),
    NodeClaudeSDKClientFactory: makeClass(),
    OutputShapingService: makeClass(),
    PromptAssetRegistry: vi.fn().mockImplementation(function PromptAssetRegistry() {
      return {
        register: vi.fn(() => undefined),
        getById: vi.fn(() => null),
        listByKind: vi.fn(() => [])
      };
    }),
    ProjectMappingService: makeClass(),
    ProposalService: makeClass(),
    RecallService: makeClass(),
    RuntimeEventNormalizer: makeClass(),
    RunHotStateService: makeClass(),
    RunService: makeClass({
      getById: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: hoisted.workspace.workspace_id
      }))
    }),
    SecurityStatusService: makeClass({
      close: vi.fn()
    }),
    SerialDelegationService: makeClass(),
    SessionOverrideService: makeClass({
      getActiveFor: vi.fn(async () => []),
      apply: vi.fn(async () => undefined)
    }),
    SignalService: makeClass({
      receiveSignal: vi.fn(async () => undefined)
    }),
    SlashCommandService: makeClass(),
    SlotService: makeClass(),
    SqliteKarmaEventStore: makeClass(),
    StanceResolutionService: makeClass({
      resolve: hoisted.stanceResolutionResolve
    }),
    SurfaceBindingService: makeClass(),
    SurfaceService: makeClass(),
    SynthesisService: makeClass(),
    StrongRefService: makeClass({
      protect: vi.fn(async () => undefined),
      releaseBySource: vi.fn(async () => undefined),
      isProtected: vi.fn(async () => false)
    }),
    systemNow: vi.fn(() => "2026-04-12T10:00:00.000Z"),
    STRATEGY_RECALL_DEFAULTS: {
      chat: { coarse: { semantic_supplement: { embedding_enabled: false } } },
      analyze: { coarse: { semantic_supplement: { embedding_enabled: false } } },
      build: { coarse: { semantic_supplement: { embedding_enabled: false } } },
      govern: { coarse: { semantic_supplement: { embedding_enabled: false } } }
    },
    TaskSurfaceBuilder: makeClass(),
    ToolFastPath: makeClass({
      execute: vi.fn(async () => ({
        result: {
          ok: true,
          content: "hello",
          bytesRead: 5
        },
        executionRecord: {
          execution_id: "exec-1",
          tool_id: "tools.read_file",
          requested_by: "principal",
          requesting_run_id: "run-1",
          governance_decision_ref: "fast-path://skipped",
          permission_result: "allow",
          executed: true,
          started_at: "2026-04-12T10:00:00.000Z",
          ended_at: "2026-04-12T10:00:01.000Z",
          result_summary: "ok",
          rollback_status: "none"
        }
      }))
    }),
    ToolGovernanceClient: makeClass({
      query: vi.fn(async () => ({
        final_result: "allow",
        matched_claim_refs: [],
        matched_slot_refs: [],
        hard_constraints_present: false,
        requires_red_card: false,
        explanation_summary: "ok"
      }))
    }),
    ToolHotPathFull: vi.fn().mockImplementation(function ToolHotPathFull() {
      return {
        execute: hoisted.toolHotPathExecute
      };
    }),
    CoreError,
    ToolSpecService: vi.fn().mockImplementation(function ToolSpecService() {
      return hoisted.toolSpecService;
    }),
    ToolSubstrate: makeClass(),
    TargetRevalidateService: makeClass(),
    VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE: {
      kind: "claude_code",
      capabilities: {
        supports_resume: false,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: true,
        supports_terminal_events: false
      },
      criticalMismatches: ["supports_streaming_updates"]
    },
    WORKER_IDENTITY_FRAGMENT: {},
    WorkerDispatchPromptAssembler: makeClass({
      assemble: vi.fn(() => "worker prompt"),
      assembleWithMetadata: vi.fn(() => ({
        prompt: "worker prompt",
        resolvedHardConstraintRefs: [],
        constitutionalAssetsBound: []
      }))
    }),
    WorkerSafetyGate: makeClass(),
    WorkerTrustAssessor: makeClass({
      assess: vi.fn(async () => undefined)
    }),
    WorkerRunLifecycleService: makeClass(),
    ZeroDaySecurityLayer: makeClass(),
    WorkspaceService: makeClass()
  };
});

vi.mock("@do-what/engine-gateway", () => ({
  APIConversationEngine: hoisted.apiConversationEngineCtor,
  McpBridge: hoisted.bridgeCtor,
  buildConversationToolDefs: (specs: readonly { readonly tool_id: string; readonly description: string }[]) =>
    specs.map((spec) => ({
      name: spec.tool_id,
      description: spec.description,
      parametersSchema: {}
    })),
  READ_FILE_TOOL_SPEC: hoisted.conversationToolSpecs[0],
  LIST_DIRECTORY_TOOL_SPEC: hoisted.conversationToolSpecs[1],
  SEARCH_FILES_TOOL_SPEC: hoisted.conversationToolSpecs[2],
  WRITE_FILE_TOOL_SPEC: hoisted.conversationToolSpecs[3],
  EXEC_SHELL_TOOL_SPEC: hoisted.conversationToolSpecs[4],
  readFile: hoisted.readFile,
  listDirectory: hoisted.listDirectory,
  searchFiles: hoisted.searchFiles,
  writeFile: hoisted.writeFile,
  execShell: hoisted.execShell
}));

vi.mock("@do-what/soul", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-what/soul");
  const makeClass = (instance: Record<string, unknown> = {}) =>
    vi.fn().mockImplementation(function MockClass() {
      return instance;
    });
  return {
    ...actual,
    Auditor: makeClass(),
    ComputeRoutingService: hoisted.computeRoutingServiceCtor,
    DegradationPipeline: makeClass(),
    GardenScheduler: makeClass({
      enqueue: vi.fn(),
      dispatchNext: vi.fn(async () => null),
      reportCompletion: vi.fn(async () => undefined),
      getBacklogSnapshot: vi.fn(() => ({
        workspace_id: null,
        observed_at: "2026-04-23T08:00:00.000Z",
        queue_depth_total: 0,
        queue_depth_by_tier: {
          tier_0: 0,
          tier_1: 0,
          tier_2: 0
        },
        in_flight_total: 0,
        warning_active: false
      })),
      peekBacklogWarningTransition: vi.fn(() => null),
      peekLastBacklogWarningTransitionId: vi.fn(() => null),
      acknowledgeBacklogWarningTransition: vi.fn(() => false)
    }),
    Janitor: makeClass(),
    Librarian: makeClass(),
    LocalHeuristics: hoisted.localHeuristicsCtor,
    MaterializationRouter: makeClass(),
    OfficialApiGardenProvider: hoisted.officialGardenProviderCtor,
    PathGraphSnapshotter: vi.fn().mockImplementation(function PathGraphSnapshotter() {
      return {
        buildSnapshot: hoisted.pathGraphSnapshotterBuildSnapshot
      };
    }),
    reviewPathGraphSnapshotHistory: hoisted.reviewPathGraphSnapshotHistory,
    SessionOverrideRemediation: makeClass({
      evaluatePending: vi.fn(async () => undefined)
    }),
    SoulWorkerSafetyAdapter: makeClass(),
    SoulWorkerSafetyReader: makeClass(),
    SoulSignalHandler: makeClass({
      handleToolUse: vi.fn(async () => undefined)
    }),
    SoulToolGovernanceAdapter: vi.fn().mockImplementation(function SoulToolGovernanceAdapter() {
      return {
        queryToolGovernance: vi.fn(async () => ({
          final_result: "allow",
          matched_claim_refs: [],
          matched_slot_refs: [],
          hard_constraints_present: false,
          requires_red_card: false,
          explanation_summary: "ok"
        }))
      };
    })
  };
});

export function resetToolRuntimeWiringState(): void {
  vi.clearAllMocks();
  vi.resetModules();
  hoisted.resetToolSpecMap();
  hoisted.extensionProviders.splice(0, hoisted.extensionProviders.length);
  hoisted.resetRuntimeConversationToolSpecs();
  hoisted.resetMcpRuntimeState();
  hoisted.engineToolSnapshots.splice(0, hoisted.engineToolSnapshots.length);
  hoisted.backgroundManagers.splice(0, hoisted.backgroundManagers.length);
  hoisted.gardenBacklogTelemetryServices.splice(0, hoisted.gardenBacklogTelemetryServices.length);
  hoisted.mcpBridgeDeps = null;
  hoisted.canonicalAliasServiceDeps = null;
  hoisted.claimServiceDeps = null;
  hoisted.computeRoutingServiceDeps = null;
  hoisted.conversationToolExecutorDeps = null;
  hoisted.conversationServiceDeps = null;
  hoisted.officialGardenProviderDeps = null;

  if (ORIGINAL_DO_WHAT_MCP_TOOL_CATALOG_JSON === undefined) {
    delete process.env.DO_WHAT_MCP_TOOL_CATALOG_JSON;
  } else {
    process.env.DO_WHAT_MCP_TOOL_CATALOG_JSON = ORIGINAL_DO_WHAT_MCP_TOOL_CATALOG_JSON;
  }

  if (ORIGINAL_DO_WHAT_ALLOWED_MCP_SERVERS === undefined) {
    delete process.env.DO_WHAT_ALLOWED_MCP_SERVERS;
  } else {
    process.env.DO_WHAT_ALLOWED_MCP_SERVERS = ORIGINAL_DO_WHAT_ALLOWED_MCP_SERVERS;
  }

  if (ORIGINAL_DO_WHAT_MCP_SERVER_CONFIG_JSON === undefined) {
    delete process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON;
  } else {
    process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON = ORIGINAL_DO_WHAT_MCP_SERVER_CONFIG_JSON;
  }

  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  }

  if (ORIGINAL_OFFICIAL_GARDEN_MODEL === undefined) {
    delete process.env.OFFICIAL_GARDEN_MODEL;
  } else {
    process.env.OFFICIAL_GARDEN_MODEL = ORIGINAL_OFFICIAL_GARDEN_MODEL;
  }
}

export function getToolRuntimeWiringFixture() {
  return hoisted;
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
