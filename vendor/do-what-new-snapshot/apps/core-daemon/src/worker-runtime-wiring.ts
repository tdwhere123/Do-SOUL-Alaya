import { PromptAssetSchema } from "@do-what/protocol";
import {
  ClaudeRuntimeAdapter,
  ConstitutionalFragmentService,
  ConstraintProxy,
  DeferredObligationService,
  DirtyStatePanicService,
  IntegrationGate,
  NodeClaudeSDKClientFactory,
  PromptAssetRegistry,
  RuntimeEventNormalizer,
  SerialDelegationService,
  systemNow,
  VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
  WORKER_IDENTITY_FRAGMENT,
  WorkerDispatchPromptAssembler,
  WorkerRunLifecycleService,
  WorkerSafetyGate,
  type EventPublisher,
  type StrongRefService,
  type ZeroDaySecurityLayer
} from "@do-what/core";
import type {
  SqliteClaimFormRepo,
  SqliteDeferredObligationRepo,
  SqliteDirtyStateDossierRepo,
  SqliteEventLogRepo,
  SqliteWorkerRunRepo
} from "@do-what/storage";
import { derivePrincipalCodingAvailability } from "./services/principal-coding-availability.js";
import {
  createInMemoryConstitutionalFragmentStore,
  createServerHardConstraintLister,
  createWorkspaceConstitutionalFragmentReader,
  getStaticWorkerDispatchConstitutionalFragments,
  resolveConstitutionalFragmentId
} from "./worker-dispatch-constitutional-fragments.js";
import {
  SoulWorkerSafetyAdapter,
  SoulWorkerSafetyReader
} from "@do-what/soul";
import type { WarnLogger } from "./daemon-runtime-helpers.js";
import type { EnvironmentStatusService } from "./services/environment-status-service.js";
import type { SseManager } from "./sse/sse-manager.js";

export async function createWorkerRuntimeWiring(input: {
  readonly claimFormRepo: SqliteClaimFormRepo;
  readonly deferredObligationRepo: SqliteDeferredObligationRepo;
  readonly dirtyStateDossierRepo: SqliteDirtyStateDossierRepo;
  readonly environmentStatusService: EnvironmentStatusService;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly sseBroadcaster: SseManager;
  readonly strongRefService: StrongRefService;
  readonly warnLogger: WarnLogger;
  readonly workerRunRepo: SqliteWorkerRunRepo;
  readonly zeroDaySecurityLayer: ZeroDaySecurityLayer;
}): Promise<Readonly<{
  readonly constraintProxy: ConstraintProxy;
  readonly deferredObligationService: DeferredObligationService;
  readonly dirtyStatePanicService: DirtyStatePanicService;
  readonly listServerHardConstraints: ReturnType<typeof createServerHardConstraintLister>;
  readonly principalCodingEngineAvailable: boolean;
  readonly principalRuntimeAdapterFactory: () => ClaudeRuntimeAdapter;
  readonly runtimeEventNormalizer: RuntimeEventNormalizer;
  readonly serialDelegationService: SerialDelegationService;
  readonly workerDispatchPromptAssembler: WorkerDispatchPromptAssembler;
  readonly workerRunLifecycleService: WorkerRunLifecycleService;
}>> {
  const constitutionalFragmentStore = createInMemoryConstitutionalFragmentStore();
  const constitutionalFragmentService = new ConstitutionalFragmentService({
    fragmentStore: constitutionalFragmentStore,
    eventPublisher: input.eventPublisher,
    eventLogReader: input.eventLogRepo,
    generateFragmentId: (request) => resolveConstitutionalFragmentId(request),
    now: systemNow
  });
  const workerDispatchConstitutionalFragmentReader = createWorkspaceConstitutionalFragmentReader({
    service: constitutionalFragmentService,
    staticFragments: getStaticWorkerDispatchConstitutionalFragments()
  });
  const promptAssetRegistry = new PromptAssetRegistry();
  promptAssetRegistry.register(WORKER_IDENTITY_FRAGMENT);
  promptAssetRegistry.register(
    PromptAssetSchema.parse({
      asset_id: "operational:worker-output-contract",
      kind: "operational",
      label: "Worker Output Contract",
      content: "Return concise findings and include explicit verification evidence.",
      priority: 20,
      immutable: false
    })
  );
  const workerDispatchPromptAssembler = new WorkerDispatchPromptAssembler({
    constitutionalFragmentReader: workerDispatchConstitutionalFragmentReader,
    promptAssetRegistry,
    warn: input.warnLogger.warn
  });
  const listServerHardConstraints = createServerHardConstraintLister({
    claimFormRepo: input.claimFormRepo
  });
  const runtimeEventNormalizer = new RuntimeEventNormalizer({
    eventLogRepo: input.eventLogRepo,
    sseBroadcaster: input.sseBroadcaster
  });
  const workerRunLifecycleService = new WorkerRunLifecycleService({
    repo: input.workerRunRepo,
    eventPublisher: input.eventPublisher
  });
  const deferredObligationService = new DeferredObligationService({
    repo: input.deferredObligationRepo,
    eventPublisher: input.eventPublisher
  });
  const constraintProxy = new ConstraintProxy({
    obligationLookup: deferredObligationService,
    eventPublisher: input.eventPublisher
  });
  const dirtyStatePanicService = new DirtyStatePanicService({
    workerRunRepo: input.workerRunRepo,
    eventPublisher: input.eventPublisher,
    dossierRepo: input.dirtyStateDossierRepo,
    workerRunLifecycle: workerRunLifecycleService
  });
  const workerSafetyReader = new SoulWorkerSafetyReader({
    claimRegistryReader: {
      listClaimsForWorkspace: async (workspaceId) =>
        await input.claimFormRepo.findByWorkspaceId(workspaceId)
    },
    hazardProjectionReader: {
      listActiveHazardObjectRefs: async () => []
    },
    policyProjectionReader: {
      listGlobalDeniedToolCategories: async () => [],
      listWorkspaceHardStopRefs: async () => []
    }
  });
  const workerSafetyGate = new WorkerSafetyGate({
    safetyPort: new SoulWorkerSafetyAdapter({
      reader: workerSafetyReader
    })
  });
  const integrationGate = new IntegrationGate({
    expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
    eventPublisher: input.eventPublisher
  });
  const claudeSdkClientFactory = new NodeClaudeSDKClientFactory();
  const principalRuntimeAdapterFactory = () =>
    new ClaudeRuntimeAdapter({
      clientFactory: claudeSdkClientFactory
    });
  const principalCodingAvailability = derivePrincipalCodingAvailability({
    runtimeConfigured: true,
    tools: (await input.environmentStatusService.getStatus()).tools
  });
  if (principalCodingAvailability.reason !== null) {
    input.warnLogger.warn("Principal coding_engine unavailable", {
      reason: principalCodingAvailability.reason,
      missingTools: principalCodingAvailability.missingTools
    });
  }
  const serialDelegationService = new SerialDelegationService({
    workerRunLifecycle: workerRunLifecycleService,
    workerRunRepo: input.workerRunRepo,
    runtimeAdapterFactory: principalRuntimeAdapterFactory,
    workerSafetyGate,
    zeroDaySecurityLayer: input.zeroDaySecurityLayer,
    integrationGate,
    constraintProxy,
    dirtyStatePanicService,
    strongRefService: input.strongRefService,
    eventNormalizer: runtimeEventNormalizer
  });

  return Object.freeze({
    constraintProxy,
    deferredObligationService,
    dirtyStatePanicService,
    listServerHardConstraints,
    principalCodingEngineAvailable: principalCodingAvailability.available,
    principalRuntimeAdapterFactory,
    runtimeEventNormalizer,
    serialDelegationService,
    workerDispatchPromptAssembler,
    workerRunLifecycleService
  });
}
