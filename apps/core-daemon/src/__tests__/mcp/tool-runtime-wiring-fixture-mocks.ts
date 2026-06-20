import { vi } from "vitest";
import { buildToolRuntimeWiringCoreMocks } from "./tool-runtime-wiring-core-mocks.js";
import { buildToolRuntimeWiringStorageMocks } from "./tool-runtime-wiring-storage-mocks.js";
import { readMockConfigEnv } from "./tool-runtime-wiring-fixture-env.js";
import { getToolRuntimeWiringHoisted } from "./tool-runtime-wiring-fixture-state.js";

const hoisted = getToolRuntimeWiringHoisted();

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

vi.mock("../../ai/daemon-embedding-runtime.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../ai/daemon-embedding-runtime.js"
  );
  const createDaemonEmbeddingRuntime = actual["createDaemonEmbeddingRuntime"] as (
    input: Record<string, unknown>
  ) => Record<string, unknown>;
  return {
    ...actual,
    createDaemonEmbeddingRuntime: vi.fn((input: Record<string, unknown>) => {
      hoisted.lastDaemonEmbeddingRuntimeInput = input;
      const override = hoisted.createDaemonEmbeddingRuntimeOverride;
      return override === null ? createDaemonEmbeddingRuntime(input) : override(input);
    })
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
  return buildToolRuntimeWiringStorageMocks({ actual, hoisted });
});

vi.mock("@do-soul/alaya-core", () => buildToolRuntimeWiringCoreMocks({ hoisted }));

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
