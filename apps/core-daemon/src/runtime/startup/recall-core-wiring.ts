import { isTemporalProjectionSelected } from "@do-soul/alaya-storage";
import { createDaemonRepositories } from "../daemon/wiring/daemon-repositories.js";
import { createDaemonServiceFoundation } from "../daemon/wiring/daemon-service-foundation.js";
import {
  createDaemonCoreServices,
  createGardenComputeRuntime
} from "../daemon/wiring/daemon-service-wiring.js";
import type { DaemonStartupStepRecord } from "../daemon/lifecycle/daemon-runtime-types.js";
import { recordStartupStep } from "../daemon/lifecycle/daemon-runtime-support.js";
import { createRecallMaterializationWiring } from "../recall-materialization/recall-materialization-wiring.js";
import type { CreateRecallMaterializationWiringInput } from "../recall-materialization/recall-materialization-wiring-types.js";
import type { RecallReadWorkerClient } from "../recall/recall-read-worker-client.js";

type Repositories = ReturnType<typeof createDaemonRepositories>;
type Foundation = Awaited<ReturnType<typeof createDaemonServiceFoundation>>;
type Bootstrap = Readonly<{
  readonly database: CreateRecallMaterializationWiringInput["database"];
  readonly configEnv: CreateRecallMaterializationWiringInput["configEnv"];
  readonly runtimeNotifier: CreateRecallMaterializationWiringInput["runtimeNotifier"];
  readonly warnLogger: Readonly<{ warn: CreateRecallMaterializationWiringInput["warn"] }>;
  readonly startupSteps: DaemonStartupStepRecord[];
}>;

type RecallCoreStartupInput = Readonly<{
  readonly bootstrap: Bootstrap;
  readonly repositories: Repositories;
  readonly foundation: Foundation;
  readonly registerRecallReadWorker: (client: RecallReadWorkerClient | null) => void;
}>;

export async function createRecallAndCoreWiring(input: RecallCoreStartupInput) {
  const gardenComputeRuntime = await createGardenComputeRuntime({
    rawConfigService: input.foundation.rawConfigService
  });
  const recallWiring = await createRecallMaterializationWiring({
    ...buildRecallRuntimeInput(input),
    ...buildRecallPersistenceInput(input),
    ...buildRecallServiceInput(input, gardenComputeRuntime)
  });
  input.registerRecallReadWorker(recallWiring.recallReadWorkerClient);
  input.foundation.pathRelationProposalServiceRef.current =
    recallWiring.pathRelationProposalService;
  const coreWiring = await createDaemonCoreServices(
    buildCoreServiceInput(input, recallWiring),
    gardenComputeRuntime
  );
  recordStartupStep(input.bootstrap.startupSteps, "core-services");
  return { recallWiring, coreWiring };
}

function buildRecallRuntimeInput(input: RecallCoreStartupInput) {
  const { bootstrap, foundation, repositories } = input;
  return {
    database: bootstrap.database,
    temporalProjectionSelected: isTemporalProjectionSelected(bootstrap.database),
    configEnv: bootstrap.configEnv,
    rawConfigService: foundation.rawConfigService,
    eventLogRepo: repositories.eventLogRepo,
    eventPublisher: foundation.eventPublisher,
    runtimeNotifier: bootstrap.runtimeNotifier,
    warn: bootstrap.warnLogger.warn,
    healthJournalService: foundation.healthJournalService
  };
}

function buildRecallPersistenceInput(input: RecallCoreStartupInput) {
  const { repositories } = input;
  return {
    memoryEntryRepo: repositories.memoryEntryRepo,
    pathRelationRepo: repositories.pathRelationRepo,
    relationAssertionRepo: repositories.relationAssertionRepo,
    claimFormRepo: repositories.claimFormRepo,
    coUsageCounterRepo: repositories.coUsageCounterRepo,
    evidenceCapsuleRepo: repositories.evidenceCapsuleRepo,
    synthesisCapsuleRepo: repositories.synthesisCapsuleRepo,
    globalMemoryRepo: repositories.globalMemoryRepo,
    globalMemoryRecallCacheRepo: repositories.globalMemoryRecallCacheRepo,
    slotRepo: repositories.slotRepo,
    proposalRepo: repositories.proposalRepo,
    runLookup: repositories.runRepo,
    reconciliationLeaseRepo: repositories.reconciliationLeaseRepo,
    deferredObligationRepo: repositories.deferredObligationRepo,
    sqliteHandoffGapRepo: repositories.sqliteHandoffGapRepo,
    signalRepo: repositories.signalRepo,
    sourceGroundingDeferQueueRepo: repositories.sourceGroundingDeferQueueRepo
  };
}

function buildRecallServiceInput(
  input: RecallCoreStartupInput,
  gardenComputeRuntime: Awaited<ReturnType<typeof createGardenComputeRuntime>>
) {
  const { foundation, repositories } = input;
  return {
    manifestationBudgetConfigProvider: foundation.manifestationBudgetConfigProvider,
    projectMappingService: foundation.projectMappingService,
    budgetBankruptcyService: foundation.budgetBankruptcyService,
    budgetNow: foundation.budgetNow,
    graphExploreService: foundation.graphExploreService,
    sessionOverrideService: foundation.sessionOverrideService,
    taskSurfaceBuilder: foundation.taskSurfaceBuilder,
    trustStateRecorder: foundation.trustStateRecorder,
    edgeProposalService: foundation.edgeProposalService,
    dynamicsService: foundation.dynamicsService,
    memoryService: foundation.memoryService,
    claimService: foundation.claimService,
    synthesisService: foundation.synthesisService,
    enqueueEnrichPending: repositories.enqueueEnrichPending,
    pathFailureHealthInboxPort: foundation.pathFailureHealthInboxPort,
    recallFailureHealthInboxPort: foundation.recallFailureHealthInboxPort,
    evidenceService: foundation.evidenceService,
    openSemanticFactorExtractionPort: {
      operator_id: gardenComputeRuntime.officialGardenProvider.operator_id,
      extract: async (
        sourceKind: "evidence" | "query",
        sourceText: string
      ) =>
        await gardenComputeRuntime.officialGardenProvider.extractOpenSemanticFactors(
          sourceKind,
          sourceText
        )
    }
  };
}

function buildCoreServiceInput(
  input: RecallCoreStartupInput,
  recallWiring: Awaited<ReturnType<typeof createRecallMaterializationWiring>>
) {
  const { bootstrap, foundation, repositories } = input;
  return {
    rawConfigService: foundation.rawConfigService,
    eventLogRepo: repositories.eventLogRepo,
    runtimeNotifier: bootstrap.runtimeNotifier,
    workspaceRepo: repositories.workspaceRepo,
    runRepo: repositories.runRepo,
    bindingRepo: repositories.bindingRepo,
    eventPublisher: foundation.eventPublisher,
    trustStateRepo: repositories.trustStateRepo,
    pathRelationRepo: repositories.pathRelationRepo,
    signalService: recallWiring.signalService,
    contextLensAssembler: recallWiring.conversationContextLensAssembler,
    governanceLeaseService: foundation.governanceLeaseService,
    budgetBankruptcyService: foundation.budgetBankruptcyService,
    healthJournalService: foundation.healthJournalService,
    warn: bootstrap.warnLogger.warn,
    isPrincipalCodingEngineAvailable: () => foundation.principalCodingAvailability.available
  };
}
