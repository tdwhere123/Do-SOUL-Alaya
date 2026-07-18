import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCoreConfigFromProcessEnv } from "@do-soul/alaya-core";
import { initDatabase, isTemporalProjectionSelected } from "@do-soul/alaya-storage";
import {
  type AlayaDaemonListenOptions,
  type AlayaDaemonRuntime,
  type AlayaDaemonServer,
  type DaemonStartupStepRecord
} from "./runtime/daemon-runtime-types.js";
import { resolveAlayaConfigDir, resolveAlayaConfigPaths } from "./cli/config-files.js";
import { startCjkSegmentationWarmup } from "./runtime/cjk-warmup.js";
import { validateDaemonEnv } from "./runtime/daemon-env.js";
import { createDaemonRepositories } from "./runtime/daemon-repositories.js";
import {
  createWarnLogger,
  installUnhandledRejectionHandler
} from "./runtime/daemon-runtime-helpers.js";
import {
  createRequestProtection,
  listServerHardConstraints,
  loadConfigEnv,
  recordStartupStep,
  resolveDatabasePath
} from "./runtime/daemon-runtime-support.js";
import { createDaemonCoreServices } from "./runtime/daemon-service-wiring.js";
import { createDaemonServiceFoundation } from "./runtime/daemon-service-foundation.js";
import { resolveCoreDaemonFilesDirectory } from "./runtime/files-data-dir.js";
import { finalizeDaemonRuntimeFromWiring } from "./runtime/finalize-daemon-runtime-wiring.js";
import { createGardenRuntimeWiring } from "./runtime/garden-runtime-wiring.js";
import { createRecallMaterializationWiring } from "./runtime/recall-materialization-wiring.js";
import { createRuntimeNotifier } from "./runtime/runtime-notifier.js";
import { isRemoteDaemonOptInEnabled } from "./runtime/server-options.js";
import { acquireTemporalRuntimeLease } from "./runtime/temporal-cutover/lease.js";

const DAEMON_MAIN_THREAD_BUSY_TIMEOUT_MS = 250;

export type {
  AlayaDaemonListenOptions,
  AlayaDaemonRuntime,
  AlayaDaemonRuntimeServices,
  AlayaDaemonServer,
  DaemonStartupStepRecord
} from "./runtime/daemon-runtime-types.js";
export { startCjkSegmentationWarmup } from "./runtime/cjk-warmup.js";
export { resolveSecretRef } from "./secrets/index.js";
export type { ResolveSecretError, ResolvedSecret, SecretRefReader } from "./secrets/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

export async function createAlayaDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const bootstrap = await createRuntimeBootstrapContext();
  try {
    const repositories = createDaemonRepositoryWiring(bootstrap);
    const foundation = await createDaemonFoundationWiring(bootstrap, repositories);
    const recallAndCore = await createRecallAndCoreWiring(bootstrap, repositories, foundation);
    const runtime = await createGardenAndFinalRuntime(
      bootstrap,
      repositories,
      foundation,
      recallAndCore
    );
    installUnhandledRejectionHandler(bootstrap.warnLogger, process, {
      shutdown: runtime.shutdown
    });
    return runtime;
  } catch (error) {
    try {
      bootstrap.database.close();
    } finally {
      await bootstrap.temporalRuntimeLease.release();
    }
    throw error;
  }
}

async function createRuntimeBootstrapContext() {
  const startupSteps: DaemonStartupStepRecord[] = [];
  const validatedEnv = validateDaemonEnv(process.env);
  const warnLogger = createWarnLogger();
  startCjkSegmentationWarmup(warnLogger);
  installUnhandledRejectionHandler(warnLogger);
  const runtimeNotifier = createRuntimeNotifier();
  const requestProtection = createRequestProtection(validatedEnv, (message, meta) => {
    warnLogger.warn(message, meta ?? {});
  });
  const remoteDaemonOptInEnabled = isRemoteDaemonOptInEnabled(process.env);
  const configPaths = resolveAlayaConfigPaths(resolveAlayaConfigDir({ env: process.env }));
  const configEnvResult = await loadConfigEnv(configPaths.envPath, (message, meta) => {
    warnLogger.warn(message, meta ?? {});
  });
  // Core/recall config must read the full env; validatedEnv is only the daemon server key subset and would drop every ALAYA_RECALL_* flag.
  installCoreConfigFromProcessEnv(process.env, configEnvResult);
  const dbPath = await resolveDatabasePath(configPaths, join(configPaths.configDir, "alaya.db"));
  const filesDirectory = resolveCoreDaemonFilesDirectory();
  const temporalRuntimeLease = await acquireTemporalRuntimeLease(dbPath);
  let database: ReturnType<typeof initDatabase>;
  try {
    database = initDatabase({
      filename: dbPath,
      busyTimeoutMs: DAEMON_MAIN_THREAD_BUSY_TIMEOUT_MS
    });
  } catch (error) {
    await temporalRuntimeLease.release();
    throw error;
  }
  recordStartupStep(startupSteps, "database");
  return {
    startupSteps,
    validatedEnv,
    warnLogger,
    runtimeNotifier,
    requestProtection,
    remoteDaemonOptInEnabled,
    configPaths,
    configEnv: configEnvResult,
    filesDirectory,
    temporalRuntimeLease,
    database
  };
}

function createDaemonRepositoryWiring(bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>) {
  const repositories = createDaemonRepositories({
    database: bootstrap.database,
    warn: bootstrap.warnLogger.warn
  });
  recordStartupStep(bootstrap.startupSteps, "repositories");
  return repositories;
}

async function createDaemonFoundationWiring(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>
) {
  return await createDaemonServiceFoundation({
    database: bootstrap.database,
    filesDirectory: bootstrap.filesDirectory,
    runtimeNotifier: bootstrap.runtimeNotifier,
    configPaths: bootstrap.configPaths,
    warnLogger: bootstrap.warnLogger,
    workspaceRepo: repositories.workspaceRepo,
    runRepo: repositories.runRepo,
    eventLogRepo: repositories.eventLogRepo,
    workspaceEngineConfigRepo: repositories.workspaceEngineConfigRepo,
    pathRelationRepo: repositories.pathRelationRepo,
    bootstrappingRecordRepo: repositories.bootstrappingRecordRepo,
    configRepo: repositories.configRepo,
    trustStateRepo: repositories.trustStateRepo,
    toolSpecRepo: repositories.toolSpecRepo,
    strongRefRepo: repositories.strongRefRepo,
    evidenceCapsuleRepo: repositories.evidenceCapsuleRepo,
    memoryEntryRepo: repositories.memoryEntryRepo,
    healthJournalRepo: repositories.healthJournalRepo,
    greenStatusRepo: repositories.greenStatusRepo,
    karmaEventRepo: repositories.karmaEventRepo,
    synthesisCapsuleRepo: repositories.synthesisCapsuleRepo,
    enqueueEnrichPending: repositories.enqueueEnrichPending,
    edgeProposalRepo: repositories.edgeProposalRepo,
    pathGraphSnapshotRepo: repositories.pathGraphSnapshotRepo,
    proposalRepo: repositories.proposalRepo,
    slotRepo: repositories.slotRepo,
    claimFormRepo: repositories.claimFormRepo,
    conflictMatrixRepo: repositories.conflictMatrixRepo,
    surfaceBindingRepo: repositories.surfaceBindingRepo,
    crossCuttingPermissionRepo: repositories.crossCuttingPermissionRepo,
    surfaceIdentityRepo: repositories.surfaceIdentityRepo,
    surfaceAnchorRepo: repositories.surfaceAnchorRepo,
    projectMappingAnchorRepo: repositories.projectMappingAnchorRepo
  });
}

async function createRecallAndCoreWiring(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>
) {
  const recallWiring = await createRecallMaterializationWiring({
    database: bootstrap.database,
    temporalProjectionSelected: isTemporalProjectionSelected(bootstrap.database),
    configEnv: bootstrap.configEnv,
    rawConfigService: foundation.rawConfigService,
    eventLogRepo: repositories.eventLogRepo,
    eventPublisher: foundation.eventPublisher,
    runtimeNotifier: bootstrap.runtimeNotifier,
    warn: bootstrap.warnLogger.warn,
    healthJournalService: foundation.healthJournalService,
    memoryEntryRepo: repositories.memoryEntryRepo,
    pathRelationRepo: repositories.pathRelationRepo,
    relationAssertionRepo: repositories.relationAssertionRepo,
    manifestationBudgetConfigProvider: foundation.manifestationBudgetConfigProvider,
    projectMappingService: foundation.projectMappingService,
    claimFormRepo: repositories.claimFormRepo,
    coUsageCounterRepo: repositories.coUsageCounterRepo,
    evidenceCapsuleRepo: repositories.evidenceCapsuleRepo,
    synthesisCapsuleRepo: repositories.synthesisCapsuleRepo,
    globalMemoryRepo: repositories.globalMemoryRepo,
    globalMemoryRecallCacheRepo: repositories.globalMemoryRecallCacheRepo,
    budgetBankruptcyService: foundation.budgetBankruptcyService,
    budgetNow: foundation.budgetNow,
    slotRepo: repositories.slotRepo,
    graphExploreService: foundation.graphExploreService,
    sessionOverrideService: foundation.sessionOverrideService,
    taskSurfaceBuilder: foundation.taskSurfaceBuilder,
    trustStateRecorder: foundation.trustStateRecorder,
    edgeProposalService: foundation.edgeProposalService,
    dynamicsService: foundation.dynamicsService,
    memoryService: foundation.memoryService,
    proposalRepo: repositories.proposalRepo,
    runLookup: repositories.runRepo,
    reconciliationLeaseRepo: repositories.reconciliationLeaseRepo,
    deferredObligationRepo: repositories.deferredObligationRepo,
    claimService: foundation.claimService,
    synthesisService: foundation.synthesisService,
    enqueueEnrichPending: repositories.enqueueEnrichPending,
    sqliteHandoffGapRepo: repositories.sqliteHandoffGapRepo,
    signalRepo: repositories.signalRepo,
    sourceGroundingDeferQueueRepo: repositories.sourceGroundingDeferQueueRepo,
    pathFailureHealthInboxPort: foundation.pathFailureHealthInboxPort,
    recallFailureHealthInboxPort: foundation.recallFailureHealthInboxPort,
    evidenceService: foundation.evidenceService
  });
  foundation.pathRelationProposalServiceRef.current = recallWiring.pathRelationProposalService;
  const coreWiring = await createDaemonCoreServices({
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
  });
  recordStartupStep(bootstrap.startupSteps, "core-services");
  return { recallWiring, coreWiring };
}

async function buildGardenWiring(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>,
  runtimeWiring: Awaited<ReturnType<typeof createRecallAndCoreWiring>>
) {
  return await createGardenRuntimeWiring({
    database: bootstrap.database,
    startupSteps: bootstrap.startupSteps,
    eventLogRepo: repositories.eventLogRepo,
    evidenceCapsuleRepo: repositories.evidenceCapsuleRepo,
    eventPublisher: foundation.eventPublisher,
    runtimeNotifier: bootstrap.runtimeNotifier,
    warnLogger: bootstrap.warnLogger,
    memoryService: foundation.memoryService,
    memoryEntryRepo: repositories.memoryEntryRepo,
    synthesisCapsuleRepo: repositories.synthesisCapsuleRepo,
    gardenBacklogThresholds: runtimeWiring.coreWiring.gardenBacklogThresholds,
    healthJournalRepo: repositories.healthJournalRepo,
    healthJournalService: foundation.healthJournalService,
    sqliteHandoffGapRepo: repositories.sqliteHandoffGapRepo,
    orphanDetectionEnabled: repositories.orphanDetectionEnabled,
    orphanRadarRepo: repositories.orphanRadarRepo,
    healthIssueGroupRepo: foundation.healthIssueGroupRepo,
    pathGraphSnapshotRepo: repositories.pathGraphSnapshotRepo,
    pathRelationRepo: repositories.pathRelationRepo,
    pathPlasticityWatermarkRepo: repositories.pathPlasticityWatermarkRepo,
    embeddingBackfillHandler: runtimeWiring.recallWiring.embeddingBackfillHandler,
    configService: runtimeWiring.coreWiring.configService,
    officialGardenProvider: runtimeWiring.coreWiring.officialGardenProvider,
    localHeuristicsProvider: runtimeWiring.coreWiring.localHeuristicsProvider,
    signalService: runtimeWiring.recallWiring.signalService,
    strongRefService: foundation.strongRefService,
    workspaceRepo: repositories.workspaceRepo,
    enrichPendingRepo: repositories.enrichPendingRepo,
    signalRepo: repositories.signalRepo,
    materializationRouter: runtimeWiring.recallWiring.materializationRouter,
    edgeAutoProducerService: runtimeWiring.recallWiring.edgeAutoProducerService,
    embeddingRecallService: runtimeWiring.recallWiring.embeddingRecallService,
    conflictDetectionService: runtimeWiring.recallWiring.conflictDetectionService,
    edgeProposalService: foundation.edgeProposalService,
    edgeClassifyQueueRepoHolder: runtimeWiring.recallWiring.edgeClassifyQueueRepoHolder,
    trustStateRecorder: foundation.trustStateRecorder
  });
}

async function finalizeRuntime(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>,
  runtimeWiring: Awaited<ReturnType<typeof createRecallAndCoreWiring>>,
  gardenWiring: Awaited<ReturnType<typeof buildGardenWiring>>
) {
  return await finalizeDaemonRuntimeFromWiring(
    buildFinalizeDaemonRuntimeWiringInput(
      bootstrap,
      repositories,
      foundation,
      runtimeWiring,
      gardenWiring
    )
  );
}

// The wiring input type is inferred from this builder so a missing or
// mistyped field is a tsc error at the call site rather than silent `any`.
export type FinalizeDaemonRuntimeWiringInput = ReturnType<
  typeof buildFinalizeDaemonRuntimeWiringInput
>;

function buildFinalizeDaemonRuntimeWiringInput(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>,
  runtimeWiring: Awaited<ReturnType<typeof createRecallAndCoreWiring>>,
  gardenWiring: Awaited<ReturnType<typeof buildGardenWiring>>
) {
  return {
    ...buildFinalizeSurfaceRuntimeInput(bootstrap, repositories, foundation, runtimeWiring),
    ...buildFinalizeGovernanceRuntimeInput(
      bootstrap,
      repositories,
      foundation,
      runtimeWiring,
      gardenWiring
    ),
    ...buildFinalizeOperationsRuntimeInput(
      bootstrap,
      repositories,
      foundation,
      runtimeWiring,
      gardenWiring
    )
  };
}

function buildFinalizeSurfaceRuntimeInput(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>,
  runtimeWiring: Awaited<ReturnType<typeof createRecallAndCoreWiring>>
) {
  return {
    requestProtection: bootstrap.requestProtection,
    runtimeNotifier: bootstrap.runtimeNotifier,
    startupSteps: bootstrap.startupSteps,
    eventLogRepo: repositories.eventLogRepo,
    extensionDescriptorRepo: repositories.extensionDescriptorRepo,
    toolSpecService: foundation.toolSpecService,
    zeroDaySecurityLayer: foundation.zeroDaySecurityLayer,
    warnLogger: bootstrap.warnLogger,
    surfaceService: foundation.surfaceService,
    recallService: runtimeWiring.recallWiring.recallService,
    memoryService: foundation.memoryService,
    dynamicsService: foundation.dynamicsService,
    memoryEntryRepo: repositories.memoryEntryRepo,
    evidenceService: foundation.evidenceService,
    pathRelationProposalService: runtimeWiring.recallWiring.pathRelationProposalService,
    signalService: runtimeWiring.recallWiring.signalService,
    graphExploreService: foundation.graphExploreService,
    edgeProposalService: foundation.edgeProposalService,
    graphEdgePort: runtimeWiring.recallWiring.graphEdgePort
  };
}

function buildFinalizeGovernanceRuntimeInput(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>,
  runtimeWiring: Awaited<ReturnType<typeof createRecallAndCoreWiring>>,
  gardenWiring: Awaited<ReturnType<typeof buildGardenWiring>>
) {
  return {
    sessionOverrideService: foundation.sessionOverrideService,
    trustStateRecorder: foundation.trustStateRecorder,
    eventPublisher: foundation.eventPublisher,
    gardenTaskRepo: gardenWiring.gardenTaskRepo,
    edgeAutoProducerService: runtimeWiring.recallWiring.edgeAutoProducerService,
    proposalRepo: repositories.proposalRepo,
    resolutionService: runtimeWiring.recallWiring.resolutionService,
    claimFormRepo: repositories.claimFormRepo,
    remoteDaemonOptInEnabled: bootstrap.remoteDaemonOptInEnabled,
    principalCodingAvailability: foundation.principalCodingAvailability,
    repoRoot,
    filesDirectory: bootstrap.filesDirectory,
    listServerHardConstraints,
    securedWorkspaceService: foundation.securedWorkspaceService,
    engineBindingService: runtimeWiring.coreWiring.engineBindingService,
    workspaceRepo: repositories.workspaceRepo,
    runService: runtimeWiring.coreWiring.runService,
    workerRunRepo: repositories.workerRunRepo,
    toolExecutionRecordRepo: repositories.toolExecutionRecordRepo,
    securityStatusService: foundation.securityStatusService,
    embeddingStatusService: runtimeWiring.recallWiring.embeddingStatusService,
    embeddingProviderWarmup: runtimeWiring.recallWiring.embeddingProviderWarmup,
    getEmbeddingProviderDimensions: runtimeWiring.recallWiring.getEmbeddingProviderDimensions,
    conversationService: runtimeWiring.coreWiring.conversationService,
    runHotStateService: foundation.runHotStateService,
    governanceLeaseService: foundation.governanceLeaseService,
    budgetBankruptcyService: foundation.budgetBankruptcyService,
    contextLensAssembler: runtimeWiring.recallWiring.contextLensAssembler
  };
}

function buildFinalizeOperationsRuntimeInput(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>,
  runtimeWiring: Awaited<ReturnType<typeof createRecallAndCoreWiring>>,
  gardenWiring: Awaited<ReturnType<typeof buildGardenWiring>>
) {
  return {
    gardenBacklogTelemetryService: gardenWiring.gardenBacklogTelemetryService,
    greenService: foundation.greenService,
    healthJournalService: foundation.healthJournalService,
    configService: runtimeWiring.coreWiring.configService,
    environmentStatusService: foundation.environmentStatusService,
    slotService: foundation.slotService,
    arbitrationService: foundation.arbitrationService,
    recallUtilizationService: runtimeWiring.recallWiring.recallUtilizationService,
    singleUsedAnchorEmitter: runtimeWiring.recallWiring.singleUsedAnchorEmitter,
    deliveryAnchorReader: runtimeWiring.recallWiring.deliveryAnchorReader,
    taskSurfaceBuilder: foundation.taskSurfaceBuilder,
    synthesisService: foundation.synthesisService,
    claimService: foundation.claimService,
    proposalService: foundation.proposalService,
    healthIssueGroupRepo: foundation.healthIssueGroupRepo,
    fileRepo: repositories.fileRepo,
    topologyAuditService: runtimeWiring.coreWiring.topologyAuditService,
    topologyService: foundation.topologyService,
    soulApprovalService: runtimeWiring.coreWiring.soulApprovalService,
    soulGraphService: foundation.soulGraphService,
    graphContractService: foundation.graphContractService,
    projectMappingService: foundation.projectMappingService,
    globalMemoryService: runtimeWiring.recallWiring.globalMemoryService,
    gardenRuntime: gardenWiring.gardenRuntime,
    globalMemoryRecallInvalidationSubscription:
      runtimeWiring.recallWiring.globalMemoryRecallInvalidationSubscription,
    database: bootstrap.database,
    temporalRuntimeLease: bootstrap.temporalRuntimeLease,
    recallReadWorkerClient: runtimeWiring.recallWiring.recallReadWorkerClient,
    pathRelationEvictionTimer: runtimeWiring.recallWiring.pathRelationEvictionTimer,
    embeddingRecallService: runtimeWiring.recallWiring.embeddingRecallService,
    graphHealthService: foundation.graphHealthService,
    initialGardenLastPassAt: gardenWiring.initialGardenLastPassAt
  };
}

async function createGardenAndFinalRuntime(
  bootstrap: Awaited<ReturnType<typeof createRuntimeBootstrapContext>>,
  repositories: ReturnType<typeof createDaemonRepositoryWiring>,
  foundation: Awaited<ReturnType<typeof createDaemonFoundationWiring>>,
  runtimeWiring: Awaited<ReturnType<typeof createRecallAndCoreWiring>>
) {
  const gardenWiring = await buildGardenWiring(bootstrap, repositories, foundation, runtimeWiring);
  return await finalizeRuntime(bootstrap, repositories, foundation, runtimeWiring, gardenWiring);
}

export async function startDaemon(options: AlayaDaemonListenOptions = {}): Promise<AlayaDaemonServer> {
  const runtime = await createAlayaDaemonRuntime();
  return await runtime.startHttpServer(options);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file://").href) {
  await startDaemon();
}
