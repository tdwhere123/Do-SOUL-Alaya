import type { ToolProvider } from "@do-soul/alaya-protocol";
import { vi } from "vitest";

type ToolRuntimeWiringHoisted = Record<string, any>;

export function buildToolRuntimeWiringCoreMocks(params: {
  readonly hoisted: ToolRuntimeWiringHoisted;
}) {
  const { hoisted } = params;
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
      onCoRecall: vi.fn(async () => undefined),
      evictExpired: vi.fn(async () => 0),
      counterSize: vi.fn(async () => 0)
    }),
    AnswersWithEdgeProducerService: makeClass({
      crystallize: vi.fn(async () => ({ coRelevantPairs: 0, keptPairs: 0, minted: 0 }))
    }),
    HqAnswerOverlapPairSource: makeClass({
      answerCoRelevantPairKeys: vi.fn(async () => new Set())
    }),
    DEFAULT_ANSWER_OVERLAP_BAR: 3,
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
    ConversationService: vi.fn().mockImplementation(function ConversationService(deps: Record<string, unknown>) {
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
    scheduleAuditedAsyncSideEffect: vi.fn((work: Promise<unknown> | null | undefined) => {
      void work?.catch(() => undefined);
    }),
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
              (candidate: Readonly<ToolProvider>) => candidate.provider_id === providerId
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
          const provider = hoisted.extensionProviders.find((candidate: Readonly<ToolProvider>) =>
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
      readonly extensionRegistry: { registerProvider(provider: Readonly<ToolProvider>): Promise<unknown> };
      readonly mcpToolCatalog: {
        listServerTools(server: { readonly server_name: string }): Promise<
          readonly Readonly<ToolProvider["tool_specs"][number]>[]
        >;
      };
    }) {
      return {
        discoverAndRegister: vi.fn(async (servers: readonly { readonly server_name: string }[]) => {
          await (
            hoisted.mcpDiscoverAndRegister as (
              servers: readonly { readonly server_name: string }[]
            ) => Promise<unknown>
          )(servers);
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
}
