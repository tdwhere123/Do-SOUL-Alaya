import { vi } from "vitest";
import type {
  ConversationRuntimeContext,
  ToolProvider,
  ToolSpec,
  ToolUseBlock
} from "@do-soul/alaya-protocol";
import type { ConversationServiceDependencies } from "@do-soul/alaya-core";

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
  "contextLensAssembler" | "gardenComputeProvider" | "resolveGardenComputeProvider"
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
    // anchor: SqliteCoUsageCounterRepo (and the path-relation findByAnchors
    // ad-hoc lookup) prepare statements at construction time, so the wiring
    // fixture must expose a prepare() that returns inert statement handles.
    // SqliteEnrichPendingRepo also wraps its claim batch in a
    // connection.transaction() at construction, so transaction() must return a
    // callable that runs the supplied function with its args (matching
    // better-sqlite3's transaction wrapper contract).
    connection: {
      prepare: vi.fn(() => ({
        run: vi.fn(() => ({ changes: 0 })),
        get: vi.fn(() => undefined),
        all: vi.fn(() => [])
      })),
      transaction: vi.fn(<Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) => {
        return (...args: Args): Result => fn(...args);
      })
    },
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

  const runtimeNotifier = {
    notifyEntry: vi.fn(async () => undefined)
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
    paths_created_since_last: 0,
    snapshot_at: "2026-04-12T10:00:00.000Z"
  };

  const toolHotPathExecute = vi.fn(async (request: {
    readonly toolId: string;
    readonly rawInput: unknown;
    readonly handler: (context: { readonly writableRoots: readonly string[] }, input: unknown) => Promise< unknown>;
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
  const rebuildCountersFromEventLog = vi.fn(async () => undefined);
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
    let currentProviders = deps.providers;
    const setProviders = vi.fn((providers) => {
      currentProviders = providers;
      hoisted.computeRoutingServiceDeps = { ...deps, providers: currentProviders };
    });
    hoisted.computeRoutingServiceDeps = { ...deps, providers: currentProviders };
    hoisted.computeRoutingServiceSetProviders = setProviders;
    return {
      route: hoisted.computeRoutingRoute,
      toModelRef: hoisted.computeRoutingToModelRef,
      getDefaultProvider: vi.fn(() => currentProviders[0]?.provider ?? localHeuristicsInstance),
      resolveProvider: vi.fn((modelRef) => {
        if (modelRef == null) {
          return currentProviders[0]?.provider ?? null;
        }

        return (
          currentProviders.find(
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
      }),
      setProviders
    };
  });
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
  const coreWarmCjkSegmentation = vi.fn(async () => false);
  const storageWarmCjkSegmentation = vi.fn(async () => false);

  return {
    conversationToolSpecs,
    resetToolSpecMap,
    database,
    workspace,
    eventLogRepo,
    runtimeNotifier,
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
    computeRoutingServiceSetProviders: null as null | ReturnType<typeof vi.fn>,
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
        files_dir: "/tmp/alaya-files"
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
    rebuildCountersFromEventLog,
    localHeuristicsCtor,
    localHeuristicsInstance,
    officialGardenProviderCtor,
    officialGardenProviderDeps: null as null | Record<string, unknown>,
    officialGardenProviderInstance,
    coreWarmCjkSegmentation,
    storageWarmCjkSegmentation,
    loadConfigEnv: vi.fn(async () => new Map<string, string>()),
    loadConfigEnvDefault: null as
      | null
      | ((envPath: string) => Promise<ReadonlyMap<string, string>>),
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

const ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON = process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
const ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS = process.env.ALAYA_ALLOWED_MCP_SERVERS;
const ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON = process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
const ORIGINAL_ALAYA_CONFIG_DIR = process.env.ALAYA_CONFIG_DIR;
const ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
const ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF = process.env.ALAYA_GARDEN_OPENAI_SECRET_REF;
const ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY = process.env.ALAYA_GARDEN_TEST_OPENAI_KEY;
const ORIGINAL_ALAYA_OPENAI_SECRET_REF = process.env.ALAYA_OPENAI_SECRET_REF;
const ORIGINAL_ALAYA_TEST_OPENAI_KEY = process.env.ALAYA_TEST_OPENAI_KEY;
const ORIGINAL_OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL;
const ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL = process.env.OPENAI_EMBEDDING_PROVIDER_URL;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_OFFICIAL_GARDEN_MODEL = process.env.OFFICIAL_GARDEN_MODEL;

async function readMockConfigEnv(): Promise<ReadonlyMap<string, string>> {
  const configDir = process.env.ALAYA_CONFIG_DIR;
  if (configDir === undefined || configDir.trim().length === 0) {
    return new Map();
  }
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    const raw = await readFile(path.join(configDir, ".env"), "utf8");
    return parseMockEnv(raw);
  } catch {
    return new Map();
  }
}

function parseMockEnv(raw: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 1) {
      continue;
    }
    values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1).trim());
  }
  return values;
}

vi.mock("@do-soul/alaya-protocol", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-soul/alaya-protocol");

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

vi.mock("../../runtime/app.js", () => ({
  createApp: hoisted.createApp
}));

vi.mock("../../runtime/daemon-runtime-support.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../runtime/daemon-runtime-support.js"
  );
  const loadConfigEnvDefault = actual["loadConfigEnv"] as (
    envPath: string
  ) => Promise<ReadonlyMap<string, string>>;
  hoisted.loadConfigEnvDefault = loadConfigEnvDefault;
  hoisted.loadConfigEnv.mockImplementation(
    loadConfigEnvDefault as unknown as () => Promise<Map<string, string>>
  );
  return {
    ...actual,
    loadConfigEnv: hoisted.loadConfigEnv
  };
});

vi.mock("../../background/bootstrap.js", () => ({
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

vi.mock("../../budget/wiring.js", () => ({
  createBudgetProposalPort: vi.fn(() => ({}))
}));

vi.mock("../../runtime/files-data-dir.js", () => ({
  resolveCoreDaemonFilesDirectory: vi.fn(() => "/tmp/alaya-files")
}));

vi.mock("../../garden/orphan-query.js", () => ({
  findOrphanedMemoriesForWorkspace: vi.fn(async () => [])
}));

vi.mock("../../services/config-service.js", () => ({
  createConfigService: vi.fn(() => {
    const getRuntimeGardenComputeConfig = vi.fn(async () => {
      const envValues = await readMockConfigEnv();
      const readValue = (key: string): string | null => {
        const processValue = process.env[key]?.trim();
        if (processValue !== undefined && processValue.length > 0) {
          return processValue;
        }
        return envValues.get(key) ?? null;
      };
      const secretRefCandidates = [
        ["ALAYA_OFFICIAL_GARDEN_SECRET_REF", readValue("ALAYA_OFFICIAL_GARDEN_SECRET_REF")],
        ["ALAYA_GARDEN_OPENAI_SECRET_REF", readValue("ALAYA_GARDEN_OPENAI_SECRET_REF")],
        ["ALAYA_OPENAI_SECRET_REF", readValue("ALAYA_OPENAI_SECRET_REF")]
      ] as const;
      const secretRefCandidate = secretRefCandidates.find(([, value]) => value !== null);
      const secretRef = secretRefCandidate?.[1] ?? null;
      if (
        // secretRefCandidate !== undefined implies its matched value is
        // non-null (selected via value !== null), so secretRef is a string
        // in this branch.
        secretRefCandidate !== undefined &&
        !/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(secretRef!) &&
        !/^file:\/.+/u.test(secretRef!)
      ) {
        throw new Error(`${secretRefCandidate[0]} secret_ref must use "env:NAME" or "file:/path".`);
      }
      return {
        provider_kind: secretRef === null ? "local_heuristics" : "official_api",
        provider_url: readValue("OFFICIAL_API_GARDEN_PROVIDER_URL"),
        secret_ref: secretRef,
        model_id: readValue("OFFICIAL_API_GARDEN_MODEL") ?? "gpt-4.1-mini",
        enabled: secretRef !== null
      };
    });
    return {
      getRuntimeGardenComputeConfig,
      patchRuntimeGardenComputeConfig: vi.fn(async (patch: Record<string, unknown>) => ({
        ...(await getRuntimeGardenComputeConfig()),
        ...patch
      }))
    };
  })
}));

vi.mock("../../services/environment-status-service.js", () => ({
  createEnvironmentStatusService: hoisted.createEnvironmentStatusService
}));

vi.mock("../../services/soul-approval-service.js", () => ({
  createSoulApprovalService: vi.fn(() => ({}))
}));

vi.mock("../../handoff/gap-adapter.js", () => ({
  SqliteHandoffGapAdapter: vi.fn().mockImplementation(function SqliteHandoffGapAdapter() {
    return {};
  })
}));

vi.mock("../../mcp/mcp-runtime-registry.js", () => ({
  createDaemonMcpRuntimeRegistry: vi.fn(() => ({
    listServerInfos: vi.fn(() => hoisted.mcpRuntimeServerInfos),
    refresh: hoisted.mcpRuntimeRefresh,
    close: hoisted.mcpRuntimeClose,
    getServerTools: vi.fn((serverName: string) => hoisted.mcpRuntimeServerTools.get(serverName) ?? []),
    listServerTools: vi.fn(async (serverName: string) => hoisted.mcpRuntimeServerTools.get(serverName) ?? []),
    callTool: hoisted.mcpRuntimeCallTool
  }))
}));

vi.mock("@do-soul/alaya-storage", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-soul/alaya-storage");
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
    // anchor: storage owns an independent jieba module-state instance;
    // the daemon AWAITS this warm at startup so the runtime-wiring
    // surface must expose a fast no-op fallback (mirrors the core mock
    // below). see also: packages/storage/src/repos/shared/cjk-segmentation.ts.
    warmCjkSegmentation: hoisted.storageWarmCjkSegmentation,
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
    SqliteEdgeProposalRepo: makeRepo(),
    SqliteEvidenceCapsuleRepo: makeRepo(),
    SqliteMemoryEntryRepo: makeRepo(),
    SqliteOrphanRadarRepo: makeRepo(),
    SqliteProjectMappingAnchorRepo: makeRepo(),
    SqliteSynthesisCapsuleRepo: makeRepo(),
    SqliteReconciliationLeaseRepo: makeRepo(),
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
    SqliteHealthJournalRepo: makeRepo({
      append: vi.fn(async () => undefined),
      findByWorkspace: vi.fn(async () => [])
    }),
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
    SqliteTrustStateRepo: makeRepo({
      createDelivery: vi.fn(async (record: unknown) => record),
      createUsage: vi.fn(async (record: unknown) => record),
      findDeliveryById: vi.fn(async () => null),
      listDeliveriesByAgentTarget: vi.fn(async () => []),
      listUsageByDeliveryIds: vi.fn(async () => [])
    }),
    SqliteStrongRefRepo: makeRepo(),
    SqlitePathRelationRepo: makeRepo({
      findActive: vi.fn(async () => []),
      findByAnchors: vi.fn(async () => []),
      findByWorkspace: vi.fn(async () => [])
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
    SqlitePathPlasticityWatermarkRepo: makeRepo({
      findByWorkspaceId: vi.fn(() => null),
      upsert: vi.fn((record: unknown) => record)
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

vi.mock("@do-soul/alaya-core", () => {
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
    ConflictDetectionService: makeClass({
      detectAndLinkConflicts: vi.fn(async () => undefined)
    }),
    ConsolidationExecutor: makeClass({
      runCycle: vi.fn(async () => ({
        workspace_id: "workspace-1",
        committed_at: "2026-04-12T10:00:00.000Z",
        promotions_committed: 0,
        retirements_committed: 0,
        governance_changes_committed: 0,
        direction_changes_committed: 0,
        fuse_outcome: "ok"
      }))
    }),
    PathRelationProposalService: makeClass({
      onCoUsage: vi.fn(async () => undefined),
      evictExpired: vi.fn(async () => 0),
      counterSize: vi.fn(async () => 0)
    }),
    PathActivationCandidateProducer: vi.fn().mockImplementation(function PathActivationCandidateProducer() {
      return {
        produce: vi.fn(async () => [])
      };
    }),
    PATH_RELATION_PROPOSE_THRESHOLD: 3,
    PATH_RELATION_COUNTER_DEFAULT_TTL_MS: 24 * 60 * 60 * 1000,
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
      recall: vi.fn(async () => []),
      // anchor: index.ts createAlayaDaemonRuntime subscribes the recall port
      // to invalidations and keeps the returned disposable; the wiring
      // fixture exposes an inert subscription so bootstrap does not throw.
      subscribeToInvalidations: vi.fn(() => ({ dispose: vi.fn() }))
    })),
    rebuildCountersFromEventLog: hoisted.rebuildCountersFromEventLog,
    // anchor: jieba warm-up call site lives in apps/core-daemon/src/index.ts
    // createAlayaDaemonRuntime. The mock must expose a no-op so the
    // fire-and-forget call does not blow up the runtime-wiring test surface.
    warmCjkSegmentation: hoisted.coreWarmCjkSegmentation,
    CrossCuttingPermissionService: makeClass(),
    ClaudeRuntimeAdapter: makeClass(),
    DynamicsService: makeClass(),
    DeferredObligationService: makeClass(),
    // anchor: ingest reconciliation is default-ON, so createAlayaDaemonRuntime
    // always constructs ReconciliationService with the rule-only zero-cloud
    // decision port. see also: apps/core-daemon/src/index.ts.
    ReconciliationService: makeClass({
      runWithDecision: vi.fn(async () => ({
        kind: "add",
        runConflictScan: false,
        reason: "mock",
        bestSimilarity: 0
      }))
    }),
    createRuleOnlyReconciliationDecisionPort: vi.fn(() => ({
      decide: vi.fn(async () => ({ kind: "add", reason: "mock rule-only" }))
    })),
    ResolutionService: makeClass(),
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
    EdgeAutoProducerService: makeClass({
      produceForNewMemory: vi.fn(async () => undefined)
    }),
    EdgeProposalService: makeClass({
      proposeEdge: vi.fn(async () => ({
        proposal_id: "edge-proposal-1",
        status: "pending"
      })),
      listPending: vi.fn(async () => []),
      batchReview: vi.fn(async () => ({ reviewed: [] }))
    }),
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
    GraphContractService: makeClass({ derive: vi.fn(async () => ({})) }),
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
    AuditorSchedulingAdvisor: vi.fn().mockImplementation(function AuditorSchedulingAdvisor() {
      return {
        prioritizeRechecksByBias: vi.fn(
          async (
            _workspaceId: string,
            candidates: readonly {
              readonly memoryObjectId: string;
              readonly enqueuedAt: string;
            }[]
          ) =>
            candidates.map((candidate) => ({
              ...candidate,
              verificationBias: 0
            }))
        )
      };
    }),
    GreenService: makeClass(),
    HealthJournalService: makeClass(),
    IntegrationGate: makeClass(),
    MemoryService: makeClass({
      findById: vi.fn(async () => null)
    }),
    McpToolDiscoveryService: vi.fn().mockImplementation(function McpToolDiscoveryService(deps: {
      readonly extensionRegistry: { registerProvider(provider: Readonly<ToolProvider>): Promise< unknown> };
      readonly mcpToolCatalog: {
        listServerTools(server: { readonly server_name: string }): Promise<readonly Readonly<ToolProvider["tool_specs"][number]>[]>;
      };
    }) {
      return {
        discoverAndRegister: vi.fn(async (servers: readonly { readonly server_name: string }[]) => {
          await (hoisted.mcpDiscoverAndRegister as (servers: readonly { readonly server_name: string }[]) => Promise<unknown>)(
            servers
          );
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
    RuleBasedEntityExtractor: makeClass({
      extract: vi.fn(async () => [])
    }),
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
    PathPlasticityService: makeClass({
      computeAndApplyPlasticity: vi.fn(async () => ({
        reinforced: 0,
        weakened: 0,
        retired: 0,
        affectedPathIds: []
      }))
    }),
    createVerificationBiasReaderFromPathLookup: vi.fn(() => ({
      getMaxVerificationBias: vi.fn(async () => 0)
    })),
    WorkspaceService: makeClass()
  };
});

vi.mock("@do-soul/alaya-engine-gateway", () => ({
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

vi.mock("@do-soul/alaya-soul", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@do-soul/alaya-soul");
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
      dispatchNextMatchingTaskKind: vi.fn(async () => null),
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
  hoisted.computeRoutingServiceSetProviders = null;
  hoisted.conversationToolExecutorDeps = null;
  hoisted.conversationServiceDeps = null;
  hoisted.officialGardenProviderDeps = null;
  hoisted.coreWarmCjkSegmentation.mockReset();
  hoisted.coreWarmCjkSegmentation.mockImplementation(async () => false);
  hoisted.storageWarmCjkSegmentation.mockReset();
  hoisted.storageWarmCjkSegmentation.mockImplementation(async () => false);
  hoisted.loadConfigEnv.mockReset();
  if (hoisted.loadConfigEnvDefault !== null) {
    hoisted.loadConfigEnv.mockImplementation(
      hoisted.loadConfigEnvDefault as unknown as () => Promise<Map<string, string>>
    );
  }
  hoisted.rebuildCountersFromEventLog.mockReset();
  hoisted.rebuildCountersFromEventLog.mockImplementation(async () => undefined);

  if (ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON === undefined) {
    delete process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
  } else {
    process.env.ALAYA_MCP_TOOL_CATALOG_JSON = ORIGINAL_ALAYA_MCP_TOOL_CATALOG_JSON;
  }

  if (ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS === undefined) {
    delete process.env.ALAYA_ALLOWED_MCP_SERVERS;
  } else {
    process.env.ALAYA_ALLOWED_MCP_SERVERS = ORIGINAL_ALAYA_ALLOWED_MCP_SERVERS;
  }

  if (ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON === undefined) {
    delete process.env.ALAYA_MCP_SERVER_CONFIG_JSON;
  } else {
    process.env.ALAYA_MCP_SERVER_CONFIG_JSON = ORIGINAL_ALAYA_MCP_SERVER_CONFIG_JSON;
  }

  if (ORIGINAL_ALAYA_CONFIG_DIR === undefined) {
    delete process.env.ALAYA_CONFIG_DIR;
  } else {
    process.env.ALAYA_CONFIG_DIR = ORIGINAL_ALAYA_CONFIG_DIR;
  }

  if (ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT === undefined) {
    delete process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
  } else {
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = ORIGINAL_ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
  }

  if (ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF === undefined) {
    delete process.env.ALAYA_GARDEN_OPENAI_SECRET_REF;
  } else {
    process.env.ALAYA_GARDEN_OPENAI_SECRET_REF = ORIGINAL_ALAYA_GARDEN_OPENAI_SECRET_REF;
  }

  if (ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY === undefined) {
    delete process.env.ALAYA_GARDEN_TEST_OPENAI_KEY;
  } else {
    process.env.ALAYA_GARDEN_TEST_OPENAI_KEY = ORIGINAL_ALAYA_GARDEN_TEST_OPENAI_KEY;
  }

  if (ORIGINAL_ALAYA_OPENAI_SECRET_REF === undefined) {
    delete process.env.ALAYA_OPENAI_SECRET_REF;
  } else {
    process.env.ALAYA_OPENAI_SECRET_REF = ORIGINAL_ALAYA_OPENAI_SECRET_REF;
  }

  if (ORIGINAL_ALAYA_TEST_OPENAI_KEY === undefined) {
    delete process.env.ALAYA_TEST_OPENAI_KEY;
  } else {
    process.env.ALAYA_TEST_OPENAI_KEY = ORIGINAL_ALAYA_TEST_OPENAI_KEY;
  }

  if (ORIGINAL_OPENAI_EMBEDDING_MODEL === undefined) {
    delete process.env.OPENAI_EMBEDDING_MODEL;
  } else {
    process.env.OPENAI_EMBEDDING_MODEL = ORIGINAL_OPENAI_EMBEDDING_MODEL;
  }

  if (ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL === undefined) {
    delete process.env.OPENAI_EMBEDDING_PROVIDER_URL;
  } else {
    process.env.OPENAI_EMBEDDING_PROVIDER_URL = ORIGINAL_OPENAI_EMBEDDING_PROVIDER_URL;
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
