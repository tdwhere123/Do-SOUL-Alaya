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
    dossierRepo: input.dirtyStateDossierRepo,
    workerRunLifecycle: workerRunLifecycleService
  });
  const workerSafetyGate = new WorkerSafetyGate({
    safetyPort: input.workerSafetyPort
  });
  const integrationGate = new IntegrationGate({
    expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
    eventPublisher: input.eventPublisher
  });
  const serialDelegationService = new SerialDelegationService({
    workerRunLifecycle: workerRunLifecycleService,
    workerRunRepo: input.workerRunRepo,
    runtimeAdapterFactory: input.runtimeAdapterFactory,
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
    runtimeEventNormalizer,
    serialDelegationService,
    workerRunLifecycleService
  });
}
