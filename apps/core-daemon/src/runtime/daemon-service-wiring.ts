import { randomUUID } from "node:crypto";
import {
  HealthIssueCauseKind,
  HealthIssueResolutionState,
  HealthIssueSeverity,
  HealthIssueSuggestedAction,
  type HealthIssueGroup
} from "@do-soul/alaya-protocol";
import {
  ConversationService,
  ConversationServiceDependencies,
  type ConversationContextLensAssemblerPort,
  EngineBindingService,
  GardenBacklogTelemetryService,
  RunService,
  type EventPublisher,
  type GovernanceLeaseService,
  type PathFailureHealthInboxPort,
  type PathRelationProposalService,
  type SignalService,
  type BudgetBankruptcyService,
  type HealthJournalService
} from "@do-soul/alaya-core";
import {
  SqliteHealthIssueGroupRepo,
  type SqliteEngineBindingRepo,
  type SqliteEventLogRepo,
  type SqlitePathRelationRepo,
  type SqliteRunRepo,
  type SqliteTrustStateRepo,
  type SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  ComputeRoutingService,
  LocalHeuristics,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { createPathPlasticityService } from "../garden/path-plasticity-runtime.js";
import { GardenComputeProviderResolver } from "../services/garden-compute-provider-resolver.js";
import type { AppConfigService } from "../services/config-service.js";
import { createSoulApprovalService } from "../services/soul-approval-service.js";
import { SoulTopologyAuditService } from "../services/soul-topology-audit-service.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";
import {
  createEngineBindingTester,
  createGardenBacklogThresholds
} from "./daemon-runtime-support.js";
import {
  buildGardenComputeRoutingProviders,
  resolveGardenSecretRefValue
} from "./garden-compute-support.js";

export function createPathFailureHealthInbox(input: {
  readonly healthIssueGroupRepo: SqliteHealthIssueGroupRepo;
}): PathFailureHealthInboxPort {
  return {
    recordPathRelationFailure: (entry) => {
      const existing = input.healthIssueGroupRepo.findByCompositeKey(
        entry.workspaceId,
        entry.targetObjectId,
        HealthIssueCauseKind.PATH_RELATION_FAILURE
      );
      const next: HealthIssueGroup = {
        group_id: existing?.group_id ?? randomUUID(),
        workspace_id: entry.workspaceId,
        target_object_id: entry.targetObjectId,
        target_object_kind: "memory_entry",
        cause_kind: HealthIssueCauseKind.PATH_RELATION_FAILURE,
        severity: HealthIssueSeverity.WARN,
        confidence: 1,
        first_seen_at: existing?.first_seen_at ?? entry.observedAt,
        last_seen_at: entry.observedAt,
        count: (existing?.count ?? 0) + 1,
        suggested_actions: [HealthIssueSuggestedAction.INSPECT_PATH_FAILURE],
        resolution_state: HealthIssueResolutionState.PENDING,
        resolved_at: null,
        resolved_by: null
      };
      input.healthIssueGroupRepo.upsert(next);
    }
  };
}

export async function createDaemonCoreServices(input: {
  readonly rawConfigService: AppConfigService;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly workspaceRepo: SqliteWorkspaceRepo;
  readonly runRepo: SqliteRunRepo;
  readonly bindingRepo: SqliteEngineBindingRepo;
  readonly eventPublisher: EventPublisher;
  readonly trustStateRepo: SqliteTrustStateRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
  readonly signalService: SignalService;
  readonly contextLensAssembler: ConversationContextLensAssemblerPort;
  readonly governanceLeaseService: GovernanceLeaseService;
  readonly budgetBankruptcyService: BudgetBankruptcyService;
  readonly healthJournalService: HealthJournalService;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly isPrincipalCodingEngineAvailable: () => boolean;
}) {
  const localHeuristicsProvider = new LocalHeuristics();
  const gardenComputeRuntime = await createGardenComputeRuntime(input, localHeuristicsProvider);
  const conversationService = new ConversationService(
    createConversationServiceDependencies(input, gardenComputeRuntime.computeRoutingService)
  );
  const runService = createRunService(input);
  const engineBindingService = createEngineBindingService(input);
  const gardenBacklogThresholds = createGardenBacklogThresholds();
  const supportServices = createDaemonCoreSupportServices(input, runService);

  return {
    localHeuristicsProvider,
    configService: gardenComputeRuntime.configService,
    officialGardenProvider: gardenComputeRuntime.officialGardenProvider,
    computeRoutingService: gardenComputeRuntime.computeRoutingService,
    conversationService,
    runService,
    engineBindingService,
    soulApprovalService: supportServices.soulApprovalService,
    topologyAuditService: supportServices.topologyAuditService,
    gardenBacklogThresholds,
    pathPlasticityService: supportServices.pathPlasticityService
  };
}

async function createGardenComputeRuntime(
  input: {
    readonly rawConfigService: AppConfigService;
  },
  localHeuristicsProvider: LocalHeuristics
) {
  const gardenComputeProviderResolver = new GardenComputeProviderResolver({
    configReader: input.rawConfigService,
    fallbackProvider: localHeuristicsProvider,
    secretReader: resolveGardenSecretRefValue,
    makeProvider: ({ apiKey, model, endpoint }) =>
      new OfficialApiGardenProvider({
        apiKey,
        model,
        ...(endpoint === null ? {} : { endpoint })
      })
  });
  const officialGardenProvider = gardenComputeProviderResolver;
  const initialGardenComputeConfig = await input.rawConfigService.getRuntimeGardenComputeConfig();
  const computeRoutingService = new ComputeRoutingService({
    providers: buildGardenComputeRoutingProviders({
      config: initialGardenComputeConfig,
      officialGardenProvider,
      localHeuristicsProvider
    })
  });
  const configService = createHotReloadingConfigService(
    input.rawConfigService,
    gardenComputeProviderResolver,
    computeRoutingService,
    officialGardenProvider,
    localHeuristicsProvider
  );
  return {
    officialGardenProvider,
    computeRoutingService,
    configService
  };
}

function createHotReloadingConfigService(
  rawConfigService: AppConfigService,
  gardenComputeProviderResolver: GardenComputeProviderResolver,
  computeRoutingService: ComputeRoutingService,
  officialGardenProvider: GardenComputeProviderResolver,
  localHeuristicsProvider: LocalHeuristics
): AppConfigService {
  return {
    ...rawConfigService,
    patchRuntimeGardenComputeConfig: async (patch: unknown) => {
      const config = await rawConfigService.patchRuntimeGardenComputeConfig(patch);
      gardenComputeProviderResolver.invalidate();
      computeRoutingService.setProviders(
        buildGardenComputeRoutingProviders({
          config,
          officialGardenProvider,
          localHeuristicsProvider
        })
      );
      return config;
    }
  } satisfies AppConfigService;
}

function createConversationServiceDependencies(
  input: {
    readonly runRepo: SqliteRunRepo;
    readonly workspaceRepo: SqliteWorkspaceRepo;
    readonly eventLogRepo: SqliteEventLogRepo;
    readonly signalService: SignalService;
    readonly contextLensAssembler: ConversationContextLensAssemblerPort;
    readonly governanceLeaseService: GovernanceLeaseService;
    readonly budgetBankruptcyService: BudgetBankruptcyService;
    readonly healthJournalService: HealthJournalService;
    readonly warn: (message: string, meta: Record<string, unknown>) => void;
  },
  computeRoutingService: ComputeRoutingService
) {
  return {
    runRepo: input.runRepo,
    workspaceRepo: input.workspaceRepo,
    eventLogRepo: input.eventLogRepo,
    gardenComputeProvider: computeRoutingService.getDefaultProvider(),
    resolveGardenComputeProvider: {
      resolve: (modelRef) => computeRoutingService.resolveProvider(modelRef)
    },
    signalReceiver: input.signalService,
    contextLensAssembler: input.contextLensAssembler,
    governanceLeaseService: input.governanceLeaseService,
    budgetBankruptcyService: input.budgetBankruptcyService,
    healthJournalRecorder: input.healthJournalService,
    warn: input.warn
  } satisfies ConversationServiceDependencies;
}

function createRunService(input: {
  readonly workspaceRepo: SqliteWorkspaceRepo;
  readonly runRepo: SqliteRunRepo;
  readonly bindingRepo: SqliteEngineBindingRepo;
  readonly eventPublisher: EventPublisher;
  readonly isPrincipalCodingEngineAvailable: () => boolean;
}) {
  return new RunService({
    workspaceRepo: input.workspaceRepo,
    runRepo: input.runRepo,
    bindingRepo: input.bindingRepo,
    eventPublisher: input.eventPublisher,
    isPrincipalCodingEngineAvailable: input.isPrincipalCodingEngineAvailable
  });
}

function createEngineBindingService(input: {
  readonly workspaceRepo: SqliteWorkspaceRepo;
  readonly bindingRepo: SqliteEngineBindingRepo;
  readonly eventPublisher: EventPublisher;
}) {
  return new EngineBindingService({
    workspaceRepo: input.workspaceRepo,
    bindingRepo: input.bindingRepo,
    eventPublisher: input.eventPublisher,
    engineTester: createEngineBindingTester()
  });
}

function createDaemonCoreSupportServices(
  input: {
    readonly eventLogRepo: SqliteEventLogRepo;
    readonly runtimeNotifier: AlayaRuntimeNotifier;
    readonly trustStateRepo: SqliteTrustStateRepo;
    readonly pathRelationRepo: SqlitePathRelationRepo;
    readonly eventPublisher: EventPublisher;
  },
  runService: RunService
) {
  return {
    soulApprovalService: createSoulApprovalService({
      eventLogRepo: input.eventLogRepo,
      runLookup: async (runId) => await runService.getById(runId),
      runtimeNotifier: input.runtimeNotifier
    }),
    topologyAuditService: new SoulTopologyAuditService({
      eventLogRepo: input.eventLogRepo
    }),
    pathPlasticityService: createPathPlasticityService({
      eventLogRepo: input.eventLogRepo,
      trustStateRepo: input.trustStateRepo,
      pathRelationRepo: input.pathRelationRepo,
      eventPublisher: input.eventPublisher
    })
  };
}
