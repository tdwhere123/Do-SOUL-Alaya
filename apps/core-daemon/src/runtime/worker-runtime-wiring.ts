import {
  ConstraintProxy,
  DeferredObligationService,
  DirtyStatePanicService,
  IntegrationGate,
  RuntimeEventNormalizer,
  SerialDelegationService,
  VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
  WorkerRunLifecycleService,
  WorkerSafetyGate,
  type EventPublisher,
  type RuntimeNotifier,
  type StrongRefService,
  type ZeroDaySecurityLayer
} from "@do-soul/alaya-core";
import type { AgentRuntimePort, WorkerSafetyPort } from "@do-soul/alaya-protocol";
import type {
  SqliteDeferredObligationRepo,
  SqliteDirtyStateDossierRepo,
  SqliteEventLogRepo,
  SqliteWorkerRunRepo
} from "@do-soul/alaya-storage";

export function createWorkerRuntimeWiring(input: {
  readonly deferredObligationRepo: SqliteDeferredObligationRepo;
  readonly dirtyStateDossierRepo: SqliteDirtyStateDossierRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly runtimeAdapterFactory: () => AgentRuntimePort;
  readonly runtimeNotifier: RuntimeNotifier;
  readonly strongRefService: StrongRefService;
  readonly workerSafetyPort: WorkerSafetyPort;
  readonly workerRunRepo: SqliteWorkerRunRepo;
  readonly zeroDaySecurityLayer: ZeroDaySecurityLayer;
}): Readonly<{
  readonly constraintProxy: ConstraintProxy;
  readonly deferredObligationService: DeferredObligationService;
  readonly dirtyStatePanicService: DirtyStatePanicService;
  readonly runtimeEventNormalizer: RuntimeEventNormalizer;
  readonly serialDelegationService: SerialDelegationService;
  readonly workerRunLifecycleService: WorkerRunLifecycleService;
}> {
  const supportServices = createWorkerSupportServices(input);
  const workerSafetyGate = new WorkerSafetyGate({ safetyPort: input.workerSafetyPort });
  const integrationGate = new IntegrationGate({
    expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
    eventPublisher: input.eventPublisher
  });
  const serialDelegationService = new SerialDelegationService({
    workerRunLifecycle: supportServices.workerRunLifecycleService,
    workerRunRepo: input.workerRunRepo,
    runtimeAdapterFactory: input.runtimeAdapterFactory,
    workerSafetyGate,
    zeroDaySecurityLayer: input.zeroDaySecurityLayer,
    integrationGate,
    constraintProxy: supportServices.constraintProxy,
    dirtyStatePanicService: supportServices.dirtyStatePanicService,
    strongRefService: input.strongRefService,
    eventNormalizer: supportServices.runtimeEventNormalizer
  });

  return Object.freeze({
    ...supportServices,
    serialDelegationService,
  });
}

function createWorkerSupportServices(input: {
  readonly deferredObligationRepo: SqliteDeferredObligationRepo;
  readonly dirtyStateDossierRepo: SqliteDirtyStateDossierRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly runtimeNotifier: RuntimeNotifier;
  readonly workerRunRepo: SqliteWorkerRunRepo;
}) {
  const runtimeEventNormalizer = new RuntimeEventNormalizer({
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
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
    dossierRepo: input.dirtyStateDossierRepo
  });

  return {
    constraintProxy,
    deferredObligationService,
    dirtyStatePanicService,
    runtimeEventNormalizer,
    workerRunLifecycleService
  };
}
