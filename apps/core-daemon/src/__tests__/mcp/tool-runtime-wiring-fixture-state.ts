import { vi } from "vitest";
import type {
  ConversationRuntimeContext,
  ToolProvider,
  ToolSpec,
  ToolUseBlock
} from "@do-soul/alaya-protocol";
import type { ConversationServiceDependencies } from "@do-soul/alaya-core";

export type MockToolResultBlock = Readonly<{
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}>;

export type MockToolsHandler = (
  toolUse: ToolUseBlock,
  runtimeContext?: Readonly<ConversationRuntimeContext>
) => Promise<MockToolResultBlock>;

export type MockMcpBridgeDeps = Readonly<{
  readonly toolsHandler?: MockToolsHandler;
  readonly soulHandler?: MockToolsHandler;
  readonly hasConversationToolName?: (toolName: string) => boolean;
}>;

export type MockConversationServiceDeps = Pick<
  ConversationServiceDependencies,
  "contextLensAssembler" | "gardenComputeProvider" | "resolveGardenComputeProvider"
>;

const hoisted = vi.hoisted(() => {
  const conversationToolSpecs = [
    { tool_id: "tools.read_file", category: "read", description: "Read a file", scope_guard: "workspace", read_only: true, destructive: false, concurrency_safe: true, interrupt_behavior: "continue", requires_confirmation: false, requires_evidence_reopen: false, rollback_support: "none", fast_path_eligible: true },
    { tool_id: "tools.list_directory", category: "read", description: "List a directory", scope_guard: "workspace", read_only: true, destructive: false, concurrency_safe: true, interrupt_behavior: "continue", requires_confirmation: false, requires_evidence_reopen: false, rollback_support: "none", fast_path_eligible: true },
    { tool_id: "tools.search_files", category: "read", description: "Search files", scope_guard: "workspace", read_only: true, destructive: false, concurrency_safe: true, interrupt_behavior: "continue", requires_confirmation: false, requires_evidence_reopen: false, rollback_support: "none", fast_path_eligible: true },
    { tool_id: "tools.write_file", category: "write", description: "Write a file", scope_guard: "workspace", read_only: false, destructive: false, concurrency_safe: false, interrupt_behavior: "wait", requires_confirmation: false, requires_evidence_reopen: false, rollback_support: "best_effort", fast_path_eligible: false },
    { tool_id: "tools.exec_shell", category: "exec", description: "Execute a command", scope_guard: "project", read_only: false, destructive: true, concurrency_safe: false, interrupt_behavior: "abort", requires_confirmation: true, requires_evidence_reopen: false, rollback_support: "none", fast_path_eligible: false }
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
    queryByRun: vi.fn(async () => []),
    queryByRunAll: vi.fn(async () => [])
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
    createDaemonEmbeddingRuntimeOverride: null as
      | null
      | ((input: unknown) => Record<string, unknown>),
    lastDaemonEmbeddingRuntimeInput: null as null | Record<string, unknown>,
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

export function getToolRuntimeWiringHoisted() {
  return hoisted;
}
