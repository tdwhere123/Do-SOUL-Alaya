import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type OrphanRadar,
  type ToolProvider
} from "@do-what/protocol";
import type { DaemonMcpRuntimeRegistry } from "../mcp-runtime-registry.js";

type MockAuditorDeps = Readonly<{
  readonly eventLogRepo?: Readonly<{
    append(entry: unknown): Promise<unknown>;
    queryByWorkspace(): Promise<readonly unknown[]>;
  }>;
  readonly orphanDetectionPort?: Readonly<{
    readonly findOrphanedMemories?: (workspaceId: string) => Promise<readonly unknown[]>;
    readonly createOrphanRadarRecord?: (record: Readonly<OrphanRadar>) => Promise<void>;
  }>;
}>;

const hoisted = vi.hoisted(() => {
  const database = {
    filename: ":memory:",
    connection: {},
    close: vi.fn()
  };

  const orphanRadarRepo = {
    create: vi.fn(async (record: Readonly<OrphanRadar>) => record)
  };

  const eventLogRepo = {
    append: vi.fn(async (entry: unknown) => entry),
    queryByWorkspace: vi.fn(async () => [])
  };

  const pathGraphSnapshot = {
    snapshot_id: "snapshot-1",
    workspace_id: "workspace-1",
    total_active_paths: 2,
    total_retired_paths: 0,
    strength_distribution: {
      very_weak: 0,
      weak: 1,
      moderate: 1,
      strong: 0,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 1,
      normal: 1,
      stable: 0,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 1,
      attention_only: 1,
      recall_allowed: 0,
      strictly_governed: 0
    },
    connectivity: {
      unique_source_anchors: 1,
      unique_target_anchors: 2,
      max_out_degree: 2,
      max_in_degree: 1,
      isolated_anchors: 2
    },
    paths_reinforced_since_last: 1,
    paths_weakened_since_last: 0,
    paths_retired_since_last: 0,
    paths_created_since_last: 2,
    snapshot_at: "2026-04-17T00:00:00.000Z"
  };

  const backgroundManagers: Array<{
    readonly services: readonly {
      readonly name: string;
      readonly intervalMs: number;
      readonly task: () => Promise<void>;
    }[];
  }> = [];

  const gardenSchedulers: Array<{
    readonly enqueue: ReturnType<typeof vi.fn>;
    readonly dispatchNext: ReturnType<typeof vi.fn>;
    readonly reportCompletion: ReturnType<typeof vi.fn>;
  }> = [];
  const gardenBacklogTelemetryServices: Array<{
    readonly start: ReturnType<typeof vi.fn>;
    readonly stop: ReturnType<typeof vi.fn>;
    readonly capture: ReturnType<typeof vi.fn>;
    readonly getSnapshot: ReturnType<typeof vi.fn>;
  }> = [];

  const auditorDeps: MockAuditorDeps[] = [];

  return {
    database,
    orphanRadarRepo,
    eventLogRepo,
    pathGraphSnapshot,
    backgroundManagers,
    gardenSchedulers,
    gardenBacklogTelemetryServices,
    auditorDeps,
    healthJournalAppend: vi.fn(async () => undefined),
    workspaceList: vi.fn(async () => [{ workspace_id: "workspace-1" }]),
    findOrphanedMemoriesForWorkspace: vi.fn(async () => []),
    sqliteOrphanRadarRepoCtor: vi.fn(() => orphanRadarRepo),
    serve: vi.fn(() => ({ close: vi.fn() })),
    backgroundManagerStart: vi.fn(),
    backgroundManagerStop: vi.fn(),
    enqueue: vi.fn(),
    dispatcher: vi.fn(async () => null),
    eventPublisherPublishWithMutation: vi.fn(async (_event: unknown, mutate: () => Promise<unknown>) => await mutate()),
    pathGraphSnapshotRepoFindLatest: vi.fn(async () => null),
    pathGraphSnapshotRepoFindHistory: vi.fn(async () => []),
    pathGraphSnapshotRepoCreate: vi.fn(async (snapshot: typeof pathGraphSnapshot) => snapshot),
    pathGraphSnapshotterBuildSnapshot: vi.fn(async () => pathGraphSnapshot),
    pathGraphSnapshotterDeps: null as null | Record<string, unknown>,
    reviewPathGraphSnapshotHistory: vi.fn(() => null)
  };
});

vi.mock("@hono/node-server", () => ({
  serve: hoisted.serve
}));

vi.mock("../orphan-query.js", () => ({
  findOrphanedMemoriesForWorkspace: hoisted.findOrphanedMemoriesForWorkspace
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

vi.mock("../app.js", () => ({
  createApp: vi.fn(() => ({ fetch: vi.fn() }))
}));

vi.mock("../budget-wiring.js", () => ({
  createBudgetProposalPort: vi.fn(() => ({ }))
}));

vi.mock("../files-data-dir.js", () => ({
  resolveCoreDaemonFilesDirectory: vi.fn(() => "/tmp/do-what-files")
}));

vi.mock("../services/config-service.js", () => ({
  createConfigService: vi.fn(() => ({ }))
}));

vi.mock("../services/environment-status-service.js", () => ({
  createEnvironmentStatusService: vi.fn(() => ({
    getStatus: vi.fn(async () => ({
      tools: {
        git: true,
        node: true,
        pnpm: true,
        rg: true,
        claude: true,
        bwrap: true,
        socat: true
      },
      active_worktrees: 0,
      db_path: ":memory:",
      files_dir: "/tmp/do-what-files"
    }))
  }))
}));

vi.mock("../services/soul-approval-service.js", () => ({
  createSoulApprovalService: vi.fn(() => ({ }))
}));

vi.mock("../sse/sse-manager.js", () => ({
  SseManager: vi.fn().mockImplementation(function SseManager() {
    return {
      broadcastEntry: vi.fn(async () => undefined)
    };
  })
}));

vi.mock("../handoff-gap-adapter.js", () => ({
  SqliteHandoffGapAdapter: vi.fn().mockImplementation(function SqliteHandoffGapAdapter() {
    return {};
  })
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
    SqliteWorkspaceRepo: vi.fn().mockImplementation(function SqliteWorkspaceRepo() {
      return {
        list: hoisted.workspaceList
      };
    }),
    SqliteRunRepo: makeRepo(),
    SqliteEngineBindingRepo: makeRepo(),
    SqliteEventLogRepo: vi.fn().mockImplementation(function SqliteEventLogRepo() {
      return hoisted.eventLogRepo;
    }),
    SqliteSignalRepo: makeRepo(),
    SqliteEvidenceCapsuleRepo: makeRepo(),
    SqliteMemoryEntryRepo: makeRepo(),
    SqliteMemoryGraphEdgeRepo: makeRepo(),
    SqliteProjectMappingAnchorRepo: makeRepo(),
    SqliteSynthesisCapsuleRepo: makeRepo(),
    SqliteClaimFormRepo: makeRepo(),
    SqliteConflictMatrixRepo: makeRepo(),
    SqliteSlotRepo: makeRepo(),
    SqliteSurfaceIdentityRepo: makeRepo(),
    SqliteSurfaceAnchorRepo: makeRepo(),
    SqliteSurfaceBindingRepo: makeRepo(),
    SqliteCrossCuttingPermissionRepo: makeRepo(),
    SqliteProposalRepo: makeRepo(),
    SqliteGreenStatusRepo: makeRepo(),
    SqliteHealthJournalRepo: makeRepo({
      append: hoisted.healthJournalAppend,
      findByWorkspace: vi.fn(async () => [])
    }),
    SqliteFileRepo: makeRepo(),
    SqliteKarmaEventRepo: makeRepo(),
    SqliteToolSpecRepo: makeRepo(),
    SqliteToolExecutionRecordRepo: makeRepo(),
    SqliteExtensionDescriptorRepo: makeRepo({
      registerToolProvider: vi.fn(async (provider: unknown) => provider),
      registerSkillPackage: vi.fn(async (pkg: unknown) => pkg),
      findToolProviders: vi.fn(async () => []),
      findToolProviderByToolId: vi.fn(async () => null)
    }),
    SqliteBootstrappingRecordRepo: makeRepo({
      create: vi.fn(async (record: unknown) => record),
      findByWorkspace: vi.fn(async () => null)
    }),
    SqliteDriftLeaseRepo: makeRepo({
      create: vi.fn(async (lease: unknown) => lease),
      findActive: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      deleteExpired: vi.fn(async () => 0)
    }),
    SqliteStrongRefRepo: makeRepo(),
    SqlitePathRelationRepo: makeRepo({
      findActive: vi.fn(async () => [])
    }),
    SqlitePathGraphSnapshotRepo: vi.fn().mockImplementation(function SqlitePathGraphSnapshotRepo() {
      return {
        findLatest: hoisted.pathGraphSnapshotRepoFindLatest,
        findHistory: hoisted.pathGraphSnapshotRepoFindHistory,
        create: hoisted.pathGraphSnapshotRepoCreate,
        deleteOlderThan: vi.fn(async () => 0)
      };
    }),
    SqliteWorkerRunRepo: makeRepo(),
    SqliteDeferredObligationRepo: makeRepo(),
    SqliteDirtyStateDossierRepo: makeRepo(),
    SqliteHandoffGapRepo: vi.fn().mockImplementation(function SqliteHandoffGapRepo() {
      return {
        findExpiredObjectsByWorkspace: vi.fn(async () => []),
        deleteById: vi.fn(() => undefined)
      };
    }),
    SqliteOrphanRadarRepo: vi.fn().mockImplementation(function SqliteOrphanRadarRepo() {
      return hoisted.sqliteOrphanRadarRepoCtor();
    }),
    SqliteConfigRepo: makeRepo()
  };
});

vi.mock("@do-what/core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-what/core");
  const makeClass = (instance = {}) => vi.fn().mockImplementation(function MockClass() {
    return instance;
  });

  return {
    ArbitrationService: makeClass(),
    BudgetBankruptcyService: makeClass(),
    CanonicalAliasService: makeClass(),
    ClaimService: makeClass(),
    ConstitutionalFragmentService: makeClass({
      ensureRegistered: vi.fn(async (fragment: unknown) => fragment),
      listForWorkspace: vi.fn(async () => [])
    }),
    ConstraintProxy: makeClass(),
    ClaudeRuntimeAdapter: makeClass(),
    ContextLensAssembler: makeClass(),
    ConversationService: makeClass(),
    createGlobalMemoryRecallPort: vi.fn().mockImplementation(() => ({
      recall: vi.fn(async () => [])
    })),
    CrossCuttingPermissionService: makeClass(),
    DeferredObligationService: makeClass(),
    DirtyStatePanicService: makeClass(),
    EngineBindingService: makeClass(),
    EventPublisher: vi.fn().mockImplementation(function EventPublisher() {
      return {
      publishWithMutation: hoisted.eventPublisherPublishWithMutation,
      publish: vi.fn(async () => undefined)
      };
    }),
    DynamicsService: makeClass(),
    EvidenceService: makeClass(),
    ExtensionRegistryService: vi.fn().mockImplementation(function ExtensionRegistryService() {
      const providers: Readonly<ToolProvider>[] = [];
      return {
        registerProvider: vi.fn(async (provider: Readonly<ToolProvider>) => {
          providers.push(provider);
          return provider;
        }),
        registerSkillPackage: vi.fn(async (pkg: unknown) => pkg),
        listProviders: vi.fn(async () => providers),
        findProviderForTool: vi.fn(async () => null)
      };
    }),
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
    GovernanceLeaseService: makeClass(),
    GraphExploreService: makeClass(),
    IntegrationGate: makeClass(),
    MemoryService: makeClass(),
    McpToolDiscoveryService: vi.fn().mockImplementation(function McpToolDiscoveryService() {
      return {
      discoverAndRegister: vi.fn(async () => [])
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
    ManifestationResolver: makeClass({
      resolve: vi.fn(async () => [])
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
    SessionOverrideService: makeClass(),
    ProposalService: makeClass(),
    ProjectMappingService: makeClass(),
    RecallService: makeClass(),
    RuntimeEventNormalizer: makeClass(),
    RunHotStateService: makeClass(),
    RunService: makeClass(),
    SecurityStatusService: makeClass({
      close: vi.fn()
    }),
    SerialDelegationService: makeClass(),
    SignalService: makeClass(),
    SlashCommandService: makeClass(),
    SlotService: makeClass(),
    SqliteKarmaEventStore: makeClass(),
    StanceResolutionService: makeClass({
      resolve: vi.fn(async () => ({
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
      }))
    }),
    SurfaceBindingService: makeClass(),
    SurfaceDriftService: makeClass(),
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
    ToolFastPath: makeClass(),
    ToolGovernanceClient: makeClass(),
    CoreError: actual["CoreError"],
    ToolSpecService: makeClass({
      findById: vi.fn(async () => {
        throw new (actual["CoreError"] as typeof import("@do-what/core").CoreError)(
          "NOT_FOUND",
          "Tool spec missing"
        );
      }),
      register: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined)
    }),
    ToolSubstrate: makeClass(),
    TargetRevalidateService: makeClass(),
    CircuitBreaker: makeClass(),
    ConversationToolExecutor: makeClass(),
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
  APIConversationEngine: vi.fn().mockImplementation(function APIConversationEngine() {
    return { streamMessage: vi.fn(async () => undefined) };
  }),
  McpBridge: vi.fn().mockImplementation(function McpBridge() {
    return {};
  }),
  buildConversationToolDefs: vi.fn(() => []),
  READ_FILE_TOOL_SPEC: {
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
  LIST_DIRECTORY_TOOL_SPEC: {
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
  SEARCH_FILES_TOOL_SPEC: {
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
  WRITE_FILE_TOOL_SPEC: {
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
  EXEC_SHELL_TOOL_SPEC: {
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
  },
  readFile: vi.fn(async () => ({ ok: true, content: "", bytesRead: 0 })),
  listDirectory: vi.fn(async () => ({ ok: true, entries: [] })),
  searchFiles: vi.fn(async () => ({ ok: true, paths: [] }))
}));

vi.mock("@do-what/soul", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-what/soul");

  return {
    ...actual,
    Auditor: vi.fn().mockImplementation(function Auditor(deps: MockAuditorDeps) {
      hoisted.auditorDeps.push(deps);
      return {
        deps,
        run: vi.fn(async () => ({ success: true }))
      };
    }),
    ComputeRoutingService: vi.fn().mockImplementation(function ComputeRoutingService() {
      const localHeuristicsProvider = {
        provider_kind: "local_heuristics" as const,
        compile: vi.fn(async () => [])
      };

      return {
      route: vi.fn(async () => ({
        decision_id: "decision-1",
        workspace_id: "workspace-1",
        selected_provider: "stub",
        model_id: "local-heuristics",
        adapter: "garden.local_heuristics",
        selection_reason: "stub selected as configured fallback compute provider",
        decided_at: "2026-04-12T10:00:00.000Z"
      })),
      toModelRef: vi.fn(() => ({
        provider: "stub",
        model_id: "local-heuristics",
        adapter: "garden.local_heuristics"
      })),
      getDefaultProvider: vi.fn(() => localHeuristicsProvider),
      resolveProvider: vi.fn((modelRef) =>
        modelRef?.provider === "stub" &&
        modelRef.model_id === "local-heuristics" &&
        (modelRef.adapter ?? null) === "garden.local_heuristics"
          ? localHeuristicsProvider
          : null
      )
    };
    }),
  DegradationPipeline: vi.fn().mockImplementation(function DegradationPipeline() {
    return {};
  }),
  GardenScheduler: vi.fn().mockImplementation(function GardenScheduler() {
    const instance = {
      enqueue: hoisted.enqueue,
      dispatchNext: hoisted.dispatcher,
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
    };
    hoisted.gardenSchedulers.push(instance);
    return instance;
  }),
  Janitor: vi.fn().mockImplementation(function Janitor() {
    return { run: vi.fn(async () => undefined) };
  }),
  Librarian: vi.fn().mockImplementation(function Librarian() {
    return { run: vi.fn(async () => undefined) };
  }),
  LocalHeuristics: vi.fn().mockImplementation(function LocalHeuristics() {
    return {};
  }),
  MaterializationRouter: vi.fn().mockImplementation(function MaterializationRouter() {
    return {};
  }),
  PathGraphSnapshotter: vi.fn().mockImplementation(function PathGraphSnapshotter(deps) {
    hoisted.pathGraphSnapshotterDeps = deps;
    return {
      buildSnapshot: hoisted.pathGraphSnapshotterBuildSnapshot
    };
  }),
  reviewPathGraphSnapshotHistory: hoisted.reviewPathGraphSnapshotHistory,
  SessionOverrideRemediation: vi.fn().mockImplementation(function SessionOverrideRemediation() {
    return {};
  }),
  SoulWorkerSafetyAdapter: vi.fn().mockImplementation(function SoulWorkerSafetyAdapter() {
    return {};
  }),
  SoulWorkerSafetyReader: vi.fn().mockImplementation(function SoulWorkerSafetyReader() {
    return {};
  }),
  SoulSignalHandler: vi.fn().mockImplementation(function SoulSignalHandler() {
    return { handleToolUse: vi.fn(async () => undefined) };
  }),
  SoulToolGovernanceAdapter: vi.fn().mockImplementation(function SoulToolGovernanceAdapter() {
    return {};
  })
  };
});

describe("daemon orphan detection wiring", () => {
  const originalOrphanDetectionEnabled = process.env.ORPHAN_DETECTION_ENABLED;

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    hoisted.backgroundManagers.length = 0;
    hoisted.gardenBacklogTelemetryServices.length = 0;
    hoisted.gardenSchedulers.length = 0;
    hoisted.auditorDeps.length = 0;
    hoisted.pathGraphSnapshotterDeps = null;
    if (originalOrphanDetectionEnabled === undefined) {
      delete process.env.ORPHAN_DETECTION_ENABLED;
    } else {
      process.env.ORPHAN_DETECTION_ENABLED = originalOrphanDetectionEnabled;
    }
  });

  it("passes the scheduler health journal port through daemon runtime wiring", async () => {
    const soul = await import("@do-what/soul");

    await import("../index.js");

    const gardenSchedulerCtor = vi.mocked(soul.GardenScheduler);
    expect(gardenSchedulerCtor).toHaveBeenCalled();
    expect(gardenSchedulerCtor.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        record: expect.any(Function)
      })
    );
  });

  it("instantiates the orphan radar repo, wires orphan detection, and enqueues both auditor tasks", async () => {
    delete process.env.ORPHAN_DETECTION_ENABLED;
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await import("../index.js");

    expect(hoisted.sqliteOrphanRadarRepoCtor).toHaveBeenCalledTimes(1);
    expect(hoisted.findOrphanedMemoriesForWorkspace).not.toHaveBeenCalled();

    expect(hoisted.gardenSchedulers).toHaveLength(1);
    const auditorTask = hoisted.backgroundManagers[0].services.find((service) => service.name === "Auditor");
    expect(auditorTask).toBeDefined();

    await auditorTask!.task();

    expect(hoisted.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
        required_tier: GardenTier.TIER_1,
        workspace_id: "workspace-1"
      })
    );
    expect(hoisted.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        task_kind: GardenTaskKind.ORPHAN_DETECTION,
        required_tier: GardenTier.TIER_1,
        workspace_id: "workspace-1"
      })
    );

    const auditorDeps = hoisted.auditorDeps[0];

    expect(consoleSpy).toHaveBeenCalledWith(
      "daemon orphan detection configured",
      expect.objectContaining({ enabled: true })
    );
    expect(auditorDeps.eventLogRepo).toBeDefined();
    await auditorDeps.eventLogRepo!.append({ event_type: "test" });
    expect(hoisted.eventLogRepo.append).toHaveBeenCalledWith({ event_type: "test" });
    expect(auditorDeps.orphanDetectionPort).toBeDefined();
    await auditorDeps.orphanDetectionPort!.findOrphanedMemories!("workspace-1");
    expect(hoisted.findOrphanedMemoriesForWorkspace).toHaveBeenCalledWith(hoisted.database.connection, "workspace-1");

    const radarRecord = {
      radar_id: "radar-1",
      target_memory_id: "memory-1",
      workspace_id: "workspace-1",
      suspected_surface_gaps: ["surface://gap"],
      suggested_action: "re_anchor_candidate",
      confidence: 0.8,
      detected_at: "2026-03-28T10:00:00.000Z",
      expires_at: "2026-03-30T10:00:00.000Z",
      requires_review: true
    } as const satisfies Readonly<OrphanRadar>;

    await auditorDeps.orphanDetectionPort!.createOrphanRadarRecord!(radarRecord);
    expect(hoisted.orphanRadarRepo.create).toHaveBeenCalledWith(radarRecord);
    consoleSpy.mockRestore();
  });

  it("does not capture backlog telemetry after a failed dispatch", async () => {
    delete process.env.ORPHAN_DETECTION_ENABLED;
    await import("../index.js");

    const services = hoisted.backgroundManagers[0].services;
    const gardenSchedulerService = services.find((service) => service.name === "GardenScheduler");
    const backlogTelemetryService = hoisted.gardenBacklogTelemetryServices[0];

    expect(gardenSchedulerService).toBeDefined();
    expect(backlogTelemetryService).toBeDefined();

    hoisted.dispatcher.mockRejectedValueOnce(new Error("simulated-dispatch-failure"));

    await expect(gardenSchedulerService!.task()).rejects.toThrow("simulated-dispatch-failure");
    expect(backlogTelemetryService!.capture).not.toHaveBeenCalled();
  });

  it("fires backlog telemetry capture without awaiting enqueue or dispatch hot paths", async () => {
    delete process.env.ORPHAN_DETECTION_ENABLED;
    await import("../index.js");

    const services = hoisted.backgroundManagers[0].services;
    const auditorTask = services.find((service) => service.name === "Auditor");
    const gardenSchedulerService = services.find((service) => service.name === "GardenScheduler");
    const backlogTelemetryService = hoisted.gardenBacklogTelemetryServices[0];

    expect(auditorTask).toBeDefined();
    expect(gardenSchedulerService).toBeDefined();
    expect(backlogTelemetryService).toBeDefined();

    backlogTelemetryService!.capture.mockImplementation(() => new Promise<void>(() => undefined));

    await expect(auditorTask!.task()).resolves.toBeUndefined();
    await expect(gardenSchedulerService!.task()).resolves.toBeUndefined();

    expect(backlogTelemetryService!.capture).toHaveBeenCalledTimes(5);
  });

  it("keeps orphan detection disabled when ORPHAN_DETECTION_ENABLED is false", async () => {
    process.env.ORPHAN_DETECTION_ENABLED = "false";
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await import("../index.js");

    expect(hoisted.sqliteOrphanRadarRepoCtor).not.toHaveBeenCalled();
    const auditorTask = hoisted.backgroundManagers[0].services.find((service) => service.name === "Auditor");
    expect(auditorTask).toBeDefined();

    await auditorTask!.task();

    expect(hoisted.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
        required_tier: GardenTier.TIER_1,
        workspace_id: "workspace-1"
      })
    );
    expect(hoisted.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({
        task_kind: GardenTaskKind.ORPHAN_DETECTION
      })
    );

    const auditorDeps = hoisted.auditorDeps[0];
    expect(auditorDeps.orphanDetectionPort).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      "daemon orphan detection configured",
      expect.objectContaining({ enabled: false })
    );
    consoleSpy.mockRestore();
  });

  it("registers path graph snapshots as librarian-scheduled work and persists them through the scheduler loop", async () => {
    await import("../index.js");

    const services = hoisted.backgroundManagers[0].services;
    expect(services.some((service) => service.name === "PathGraphSnapshotter")).toBe(false);
    const librarianTask = services.find((service) => service.name === "Librarian");
    expect(librarianTask).toBeDefined();

    await librarianTask!.task();

    expect(hoisted.pathGraphSnapshotRepoFindHistory).not.toHaveBeenCalled();
    expect(hoisted.reviewPathGraphSnapshotHistory).not.toHaveBeenCalled();
    expect(hoisted.healthJournalAppend).not.toHaveBeenCalled();

    expect(hoisted.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        task_kind: GardenTaskKind.MERGE_PROPOSAL,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-1"
      })
    );
    expect(hoisted.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-1",
        target_object_refs: ["workspace-1"]
      })
    );

    const gardenSchedulerService = services.find((service) => service.name === "GardenScheduler");
    expect(gardenSchedulerService).toBeDefined();
    hoisted.dispatcher
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        task_id: "task-path-graph-snapshot",
        task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-1",
        run_id: null,
        target_object_refs: ["workspace-1"],
        priority: 10,
        created_at: "2026-04-17T00:15:00.000Z"
      });

    await gardenSchedulerService!.task();

    expect(hoisted.dispatcher).toHaveBeenCalledTimes(3);
    expect(hoisted.pathGraphSnapshotterDeps).toEqual(
      expect.objectContaining({
        pathRelationRepo: expect.objectContaining({
          findActive: expect.any(Function)
        })
      })
    );
    expect(hoisted.pathGraphSnapshotterDeps).not.toHaveProperty("retirementSummaryPort");
    expect(hoisted.pathGraphSnapshotRepoFindLatest).toHaveBeenCalledWith("workspace-1");
    expect(hoisted.pathGraphSnapshotterBuildSnapshot).toHaveBeenCalledWith("workspace-1", null);
    expect(hoisted.eventPublisherPublishWithMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "path.graph.snapshot_created",
        entity_type: "path_graph_snapshot",
        workspace_id: "workspace-1",
        entity_id: "snapshot-1"
      }),
      expect.any(Function)
    );
    expect(hoisted.pathGraphSnapshotRepoCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot_id: "snapshot-1",
        workspace_id: "workspace-1"
      })
    );
    expect(hoisted.gardenSchedulers[0].reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "task-path-graph-snapshot",
        task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: "workspace-1",
        success: true
      })
    );
  });

  it("reviews recent snapshot history immediately after a snapshot persist succeeds", async () => {
    const history = [
      {
        ...hoisted.pathGraphSnapshot,
        snapshot_id: "snapshot-latest",
        connectivity: {
          ...hoisted.pathGraphSnapshot.connectivity,
          isolated_anchors: 3
        },
        snapshot_at: "2026-04-17T00:15:00.000Z"
      },
      {
        ...hoisted.pathGraphSnapshot,
        snapshot_id: "snapshot-previous",
        connectivity: {
          ...hoisted.pathGraphSnapshot.connectivity,
          isolated_anchors: 1
        },
        snapshot_at: "2026-04-17T00:00:00.000Z"
      }
    ] as const;
    hoisted.pathGraphSnapshotRepoFindHistory.mockResolvedValueOnce(history);
    hoisted.reviewPathGraphSnapshotHistory.mockReturnValueOnce({
      summary: "Path graph isolation drift detected for workspace-1",
      detail_json: {
        latest_snapshot_id: "snapshot-latest",
        previous_snapshot_id: "snapshot-previous",
        latest_snapshot_at: "2026-04-17T00:15:00.000Z",
        previous_snapshot_at: "2026-04-17T00:00:00.000Z",
        isolated_anchor_delta: 2,
        isolated_anchor_count: 3,
        total_active_paths: 2
      }
    });

    await import("../index.js");

    const services = hoisted.backgroundManagers[0].services;
    const librarianTask = services.find((service) => service.name === "Librarian");
    expect(librarianTask).toBeDefined();

    await librarianTask!.task();

    expect(hoisted.pathGraphSnapshotRepoFindHistory).not.toHaveBeenCalled();
    expect(hoisted.reviewPathGraphSnapshotHistory).not.toHaveBeenCalled();
    expect(hoisted.healthJournalAppend).not.toHaveBeenCalled();

    const gardenSchedulerService = services.find((service) => service.name === "GardenScheduler");
    expect(gardenSchedulerService).toBeDefined();
    hoisted.dispatcher
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        task_id: "task-path-graph-snapshot",
        task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-1",
        run_id: null,
        target_object_refs: ["workspace-1"],
        priority: 10,
        created_at: "2026-04-17T00:15:00.000Z"
      });

    await gardenSchedulerService!.task();

    expect(hoisted.pathGraphSnapshotRepoFindHistory).toHaveBeenCalledWith("workspace-1", 2);
    expect(hoisted.reviewPathGraphSnapshotHistory).toHaveBeenCalledWith("workspace-1", history);
    expect(hoisted.healthJournalAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: "garden_backlog",
        workspace_id: "workspace-1",
        summary: "Path graph isolation drift detected for workspace-1",
        detail_json: expect.objectContaining({
          latest_snapshot_id: "snapshot-latest",
          previous_snapshot_id: "snapshot-previous",
          isolated_anchor_delta: 2
        })
      })
    );
  });

  it("does not record a backlog note when the post-persist soul history reviewer declines one", async () => {
    hoisted.pathGraphSnapshotRepoFindHistory.mockResolvedValueOnce([
      {
        ...hoisted.pathGraphSnapshot,
        snapshot_id: "snapshot-latest",
        connectivity: {
          ...hoisted.pathGraphSnapshot.connectivity,
          isolated_anchors: 1
        },
        snapshot_at: "2026-04-17T00:15:00.000Z"
      },
      {
        ...hoisted.pathGraphSnapshot,
        snapshot_id: "snapshot-previous",
        connectivity: {
          ...hoisted.pathGraphSnapshot.connectivity,
          isolated_anchors: 1
        },
        snapshot_at: "2026-04-17T00:00:00.000Z"
      }
    ]);
    hoisted.reviewPathGraphSnapshotHistory.mockReturnValueOnce(null);

    await import("../index.js");

    const services = hoisted.backgroundManagers[0].services;
    const librarianTask = services.find((service) => service.name === "Librarian");
    expect(librarianTask).toBeDefined();

    await librarianTask!.task();

    expect(hoisted.pathGraphSnapshotRepoFindHistory).not.toHaveBeenCalled();
    expect(hoisted.reviewPathGraphSnapshotHistory).not.toHaveBeenCalled();
    expect(hoisted.healthJournalAppend).not.toHaveBeenCalled();

    const gardenSchedulerService = services.find((service) => service.name === "GardenScheduler");
    expect(gardenSchedulerService).toBeDefined();
    hoisted.dispatcher
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        task_id: "task-path-graph-snapshot",
        task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
        required_tier: GardenTier.TIER_2,
        workspace_id: "workspace-1",
        run_id: null,
        target_object_refs: ["workspace-1"],
        priority: 10,
        created_at: "2026-04-17T00:15:00.000Z"
      });

    await gardenSchedulerService!.task();

    expect(hoisted.pathGraphSnapshotRepoFindHistory).toHaveBeenCalledWith("workspace-1", 2);
    expect(hoisted.reviewPathGraphSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(hoisted.healthJournalAppend).not.toHaveBeenCalled();
  });

  it("reports snapshot task completion without rebuilding when a recent snapshot already exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:10:00.000Z"));
    hoisted.pathGraphSnapshotRepoFindLatest.mockResolvedValueOnce({
      ...hoisted.pathGraphSnapshot,
      snapshot_at: "2026-04-17T00:05:00.000Z"
    });

    try {
      await import("../index.js");

      const gardenSchedulerService = hoisted.backgroundManagers[0].services.find(
        (service) => service.name === "GardenScheduler"
      );
      expect(gardenSchedulerService).toBeDefined();
      hoisted.dispatcher
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          task_id: "task-path-graph-snapshot",
          task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
          required_tier: GardenTier.TIER_2,
          workspace_id: "workspace-1",
          run_id: null,
          target_object_refs: ["workspace-1"],
          priority: 10,
          created_at: "2026-04-17T00:15:00.000Z"
        });

      await gardenSchedulerService!.task();

      expect(hoisted.pathGraphSnapshotRepoFindLatest).toHaveBeenCalledWith("workspace-1");
      expect(hoisted.pathGraphSnapshotterBuildSnapshot).not.toHaveBeenCalled();
      expect(hoisted.eventPublisherPublishWithMutation).not.toHaveBeenCalled();
      expect(hoisted.pathGraphSnapshotRepoCreate).not.toHaveBeenCalled();
      expect(hoisted.gardenSchedulers[0].reportCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: "task-path-graph-snapshot",
          task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
          success: true
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds unbound active memories and persists an orphan radar row with the real SQLite repo", async () => {
    const storage = await vi.importActual<typeof import("@do-what/storage")>("@do-what/storage");
    const orphanQuery = await vi.importActual<typeof import("../orphan-query.js")>("../orphan-query.js");
    const database = storage.initDatabase();

    try {
      const workspaceRepo = new storage.SqliteWorkspaceRepo(database);
      const orphanRadarRepo = new storage.SqliteOrphanRadarRepo(database);

      await workspaceRepo.create({
        workspace_id: "workspace-1",
        name: "Workspace 1",
        root_path: "/tmp/workspace-1",
        workspace_kind: "local_repo",
        default_engine_binding: null,
        workspace_state: "active"
      });

      database.connection
        .prepare(
          `INSERT INTO surface_identities (
            object_id,
            created_at,
            updated_at,
            created_by,
            surface_id,
            surface_kind,
            workspace_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "surface-object-1",
          "2026-03-28T10:00:00.000Z",
          "2026-03-28T10:00:00.000Z",
          "user_action",
          "surface-1",
          "task_surface",
          "workspace-1"
        );

      const insertMemory = database.connection.prepare(
        `INSERT INTO memory_entries (
          object_id,
          created_at,
          updated_at,
          created_by,
          dimension,
          source_kind,
          formation_kind,
          scope_class,
          content,
          workspace_id,
          run_id,
          surface_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertMemory.run(
        "memory-orphan",
        "2026-03-28T10:00:00.000Z",
        "2026-03-28T10:00:00.000Z",
        "user_action",
        "fact",
        "user",
        "explicit",
        "project",
        "Unbound memory",
        "workspace-1",
        "run-1",
        "surface-missing"
      );
      insertMemory.run(
        "memory-bound",
        "2026-03-28T10:01:00.000Z",
        "2026-03-28T10:01:00.000Z",
        "user_action",
        "fact",
        "user",
        "explicit",
        "project",
        "Bound memory",
        "workspace-1",
        "run-1",
        "surface-1"
      );
      insertMemory.run(
        "memory-stale",
        "2026-03-28T10:02:00.000Z",
        "2026-03-28T10:02:00.000Z",
        "user_action",
        "fact",
        "user",
        "explicit",
        "project",
        "Memory with only stale bindings",
        "workspace-1",
        "run-1",
        "surface-stale"
      );
      insertMemory.run(
        "memory-detached",
        "2026-03-28T10:03:00.000Z",
        "2026-03-28T10:03:00.000Z",
        "user_action",
        "fact",
        "user",
        "explicit",
        "project",
        "Memory with only detached bindings",
        "workspace-1",
        "run-1",
        "surface-detached"
      );
      insertMemory.run(
        "memory-null-surface",
        "2026-03-28T10:04:00.000Z",
        "2026-03-28T10:04:00.000Z",
        "user_action",
        "fact",
        "user",
        "explicit",
        "project",
        "Memory with null surface",
        "workspace-1",
        "run-1",
        null
      );
      insertMemory.run(
        "memory-dormant",
        "2026-03-28T10:05:00.000Z",
        "2026-03-28T10:05:00.000Z",
        "user_action",
        "fact",
        "user",
        "explicit",
        "project",
        "Dormant memory without active bindings",
        "workspace-1",
        "run-1",
        "surface-dormant"
      );
      database.connection
        .prepare("UPDATE memory_entries SET lifecycle_state = 'dormant' WHERE object_id = ?")
        .run("memory-dormant");

      const insertBinding = database.connection.prepare(
        `INSERT INTO surface_bindings (
            binding_id,
            created_at,
            updated_at,
            created_by,
            object_id,
            surface_id,
            binding_state,
            workspace_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertBinding.run(
        "binding-1",
        "2026-03-28T10:01:00.000Z",
        "2026-03-28T10:01:00.000Z",
        "user_action",
        "memory-bound",
        "surface-1",
        "active",
        "workspace-1"
      );
      insertBinding.run(
        "binding-stale",
        "2026-03-28T10:02:00.000Z",
        "2026-03-28T10:02:00.000Z",
        "user_action",
        "memory-stale",
        "surface-1",
        "stale",
        "workspace-1"
      );
      insertBinding.run(
        "binding-detached",
        "2026-03-28T10:03:00.000Z",
        "2026-03-28T10:03:00.000Z",
        "user_action",
        "memory-detached",
        "surface-1",
        "detached",
        "workspace-1"
      );

      const candidates = await orphanQuery.findOrphanedMemoriesForWorkspace(
        database.connection,
        "workspace-1"
      );

      expect(candidates).toEqual([
        {
          memory_id: "memory-orphan",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface-missing"],
          orphan_confidence: 0.8
        },
        {
          memory_id: "memory-stale",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface-stale"],
          orphan_confidence: 0.8
        },
        {
          memory_id: "memory-detached",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface-detached"],
          orphan_confidence: 0.8
        },
        {
          memory_id: "memory-null-surface",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["memory.surface_id:null"],
          orphan_confidence: 0.8
        }
      ]);

      await orphanRadarRepo.create({
        radar_id: "radar-1",
        target_memory_id: candidates[0].memory_id,
        workspace_id: candidates[0].workspace_id,
        suspected_surface_gaps: candidates[0].suspected_surface_gaps,
        suggested_action: "re_anchor_candidate",
        confidence: candidates[0].orphan_confidence,
        detected_at: "2026-03-28T10:00:00.000Z",
        expires_at: "2026-03-30T10:00:00.000Z",
        requires_review: true
      });

      await expect(
        orphanRadarRepo.findActiveByWorkspaceId("workspace-1", "2026-03-28T12:00:00.000Z")
      ).resolves.toEqual([
        expect.objectContaining({
          radar_id: "radar-1",
          target_memory_id: "memory-orphan",
          workspace_id: "workspace-1",
          suspected_surface_gaps: ["surface-missing"],
          confidence: 0.8,
          requires_review: true
        })
      ]);
    } finally {
      database.close();
    }
  });

  it("persists the builtin conversation provider into extension_descriptors through the daemon bootstrap helper with real :memory: SQLite", async () => {
    const storage = await vi.importActual<typeof import("@do-what/storage")>("@do-what/storage");
    const core = await vi.importActual<typeof import("@do-what/core")>("@do-what/core");
    const builtinConversationToolSpecsModule = await vi.importActual<
      typeof import("../builtin-conversation-tool-specs.js")
    >("../builtin-conversation-tool-specs.js");
    const mcpCatalog = await vi.importActual<typeof import("../mcp-catalog.js")>("../mcp-catalog.js");
    const database = storage.initDatabase({ filename: ":memory:" });
    const runtimeRegistry = {
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => undefined),
      getServerTools: vi.fn(() => []),
      listServerInfos: vi.fn(() => []),
      listServerTools: vi.fn(async () => []),
      refresh: vi.fn(async () => undefined)
    } satisfies DaemonMcpRuntimeRegistry;

    try {
      const toolSpecService = new core.ToolSpecService({
        toolSpecRepo: new storage.SqliteToolSpecRepo(database)
      });
      const eventLogRepo = new storage.SqliteEventLogRepo(database);
      const extensionDescriptorRepo = new storage.SqliteExtensionDescriptorRepo(database);
      const extensionRegistry = new core.ExtensionRegistryService({
        extensionStore: extensionDescriptorRepo,
        toolSpecService,
        eventLogWriter: eventLogRepo,
        defaultWorkspaceId: "system"
      });
      await Promise.all(
        builtinConversationToolSpecsModule.getBuiltinConversationToolSpecs().map(async (spec) => {
          await toolSpecService.register(spec);
        })
      );

      await mcpCatalog.bootstrapDaemonConversationTooling({
        now: () => "2026-04-21T00:00:00.000Z",
        extensionRegistry,
        mcpToolDiscoveryService: {
          discoverAndRegister: vi.fn(async () => [])
        },
        runtimeRegistry,
        toolSpecService
      });

      const descriptorRows = database.connection
        .prepare(
          `SELECT descriptor_id, descriptor_type, name
           FROM extension_descriptors
           ORDER BY descriptor_id ASC`
        )
        .all() as Array<{
        readonly descriptor_id: string;
        readonly descriptor_type: string;
        readonly name: string;
      }>;

      expect(descriptorRows).toEqual([
        {
          descriptor_id: "provider.builtin.conversation_engine",
          descriptor_type: "tool_provider",
          name: "Conversation Engine Built-in Tools"
        }
      ]);
      await expect(extensionRegistry.findProviderForTool("tools.exec_shell")).resolves.toEqual(
        expect.objectContaining({
          provider_id: "provider.builtin.conversation_engine"
        })
      );
    } finally {
      database.close();
    }
  });
});
