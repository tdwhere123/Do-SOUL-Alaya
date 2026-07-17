import { type MemoryEntry, type TransitionCausedBy } from "@do-soul/alaya-protocol";
import {
  AnswersWithEdgeProducerService,
  CoherenceEdgeProducerService,
  DEFAULT_ANSWER_OVERLAP_BAR,
  GardenBacklogTelemetryService,
  HqAnswerOverlapPairSource,
  rebuildCountersFromEventLog,
  scheduleAuditedAsyncSideEffect
} from "@do-soul/alaya-core";
import {
  SqliteGardenTaskRepo,
  createGardenBackgroundDataPorts,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  createTombstoneDispositionSweepPort
} from "../garden/forget-disposition-ports.js";
import { createGardenRuntime } from "../garden/runtime.js";
import type { WarnLogger } from "./daemon-runtime-helpers.js";
import { createOptionalMemoryHqRepo, recordStartupStep } from "./daemon-runtime-support.js";
import {
  resolvePersistedGardenLastPassAt
} from "./garden-compute-support.js";
import {
  createGardenEdgeProposalReconcileDeferralPort,
  deferGardenBootstrapPathReconciliation,
  createGardenLegacyPathCandidateRejectionPort
} from "./garden-legacy-path-admission.js";
import { createGardenSignalRefReplayPort } from "./garden-signal-ref-replay.js";
import type { createDaemonRepositories } from "./daemon-repositories.js";
import type { createDaemonServiceFoundation } from "./daemon-service-foundation.js";
import type { createDaemonCoreServices } from "./daemon-service-wiring.js";
import type { DaemonStartupStepRecord } from "./daemon-runtime-types.js";
import type { createRecallMaterializationWiring } from "./recall-materialization-wiring.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";
import { loadBackfillFormationObjects } from "./path-formation-order.js";

type DaemonRepositories = ReturnType<typeof createDaemonRepositories>;
type DaemonServiceFoundation = Awaited<ReturnType<typeof createDaemonServiceFoundation>>;
type DaemonCoreServices = Awaited<ReturnType<typeof createDaemonCoreServices>>;
type RecallMaterializationWiring = Awaited<ReturnType<typeof createRecallMaterializationWiring>>;

type GardenRuntimeWiringInput = Readonly<{
  database: StorageDatabase;
  startupSteps: DaemonStartupStepRecord[];
  runtimeNotifier: AlayaRuntimeNotifier;
  warnLogger: WarnLogger;
  dynamicsService?: DaemonServiceFoundation["dynamicsService"];
}> &
  Pick<
    DaemonRepositories,
    | "eventLogRepo"
    | "evidenceCapsuleRepo"
    | "memoryEntryRepo"
    | "synthesisCapsuleRepo"
    | "healthJournalRepo"
    | "sqliteHandoffGapRepo"
    | "orphanDetectionEnabled"
    | "orphanRadarRepo"
    | "pathGraphSnapshotRepo"
    | "pathRelationRepo"
    | "pathPlasticityWatermarkRepo"
    | "workspaceRepo"
    | "enrichPendingRepo"
    | "signalRepo"
  > &
  Pick<
    DaemonServiceFoundation,
    | "eventPublisher"
    | "memoryService"
    | "healthJournalService"
    | "healthIssueGroupRepo"
    | "strongRefService"
    | "edgeProposalService"
    | "trustStateRecorder"
  > &
  Pick<
    DaemonCoreServices,
    | "gardenBacklogThresholds"
    | "configService"
    | "officialGardenProvider"
    | "localHeuristicsProvider"
  > &
  Pick<
    RecallMaterializationWiring,
    | "embeddingBackfillHandler"
    | "signalService"
    | "materializationRouter"
    | "edgeAutoProducerService"
    | "embeddingRecallService"
    | "conflictDetectionService"
    | "edgeClassifyQueueRepoHolder"
  >;

export async function createGardenRuntimeWiring(input: GardenRuntimeWiringInput) {
  const forgetTombstoneAuthority = createForgetTombstoneAuthority(input);
  const gardenDataPorts = createGardenDataPorts(input);
  input.warnLogger.warn("garden path plasticity deferred without temporal assertion provenance", {
    scope: "temporal_clean_break"
  });
  input.warnLogger.warn("garden consolidation deferred without temporal assertion provenance", {
    scope: "temporal_clean_break"
  });
  input.warnLogger.warn("garden tombstone physical gc deferred without temporal assertion provenance", {
    scope: "temporal_clean_break"
  });
  const legacyPathCandidateRejectionPort = createGardenLegacyPathCandidateRejectionPort(input.warnLogger.warn);
  const coherenceCrystallizer = createCoherenceCrystallizer(input, legacyPathCandidateRejectionPort);
  const answersWithCrystallizer = createAnswersWithCrystallizer(input, legacyPathCandidateRejectionPort);
  const gardenRuntime = createGardenSchedulerRuntime(
    input,
    gardenDataPorts,
    forgetTombstoneAuthority,
    coherenceCrystallizer,
    answersWithCrystallizer
  );
  const gardenTaskRepo = createGardenTaskRepo(input);
  bindGardenTaskQueueRepo(input, gardenTaskRepo);
  const gardenBacklogTelemetryService = createGardenBacklogTelemetryService(input, gardenRuntime);
  gardenRuntime.setBacklogTelemetryObserver(gardenBacklogTelemetryService);
  const initialGardenLastPassAt = await resolvePersistedGardenLastPassAt({
    healthJournalRepo: input.healthJournalRepo,
    workspaceRepo: input.workspaceRepo,
    warn: input.warnLogger.warn
  });
  recordStartupStep(input.startupSteps, "garden-runtime");
  startGardenBootstrapSideEffects(input, gardenRuntime);
  await rebuildCountersFromEventLog(input.eventLogRepo, input.trustStateRecorder);
  input.trustStateRecorder.markReady();

  return {
    gardenRuntime,
    gardenBacklogTelemetryService,
    initialGardenLastPassAt,
    gardenTaskRepo
  };
}

function createForgetTombstoneAuthority(input: GardenRuntimeWiringInput) {
  return {
    autonomousTombstone: (
      objectId: string,
      disposition: NonNullable<MemoryEntry["forget_disposition"]>,
      dispositionRef: string | null,
      reason: string,
      causedBy: TransitionCausedBy
    ) => input.memoryService.autonomousTombstone(objectId, disposition, dispositionRef, reason, causedBy),
    autonomousHardDeleteTombstoned: (objectId: string, reason: string, causedBy: TransitionCausedBy) =>
      input.memoryService.autonomousHardDeleteTombstoned(objectId, reason, causedBy),
    findTombstonedMemoriesWithDisposition: (workspaceId: string) =>
      input.memoryEntryRepo.findTombstonedMemoriesWithDisposition(workspaceId)
  };
}

function createGardenDataPorts(input: GardenRuntimeWiringInput) {
  const gardenBackgroundDataPorts = createGardenBackgroundDataPorts(input.database);
  return {
    ...gardenBackgroundDataPorts,
    dormantDemotionPort: {
      findLowActivityActiveMemories: (workspaceId: string) =>
        gardenBackgroundDataPorts.dormantDemotionPort.findLowActivityActiveMemories(workspaceId),
      setLifecycleDormant: async (memoryId: string, taskId: string): Promise<"demoted" | "skipped"> => {
        const outcome = await input.memoryService.demoteActiveToDormantIfActive(
          memoryId,
          `autonomous_dormant_demotion: ${taskId}`,
          "deterministic_rule"
        );
        return outcome.status;
      }
    }
  };
}

function createCoherenceCrystallizer(
  input: GardenRuntimeWiringInput,
  mintPort: ReturnType<typeof createGardenLegacyPathCandidateRejectionPort>
) {
  if (input.embeddingRecallService === undefined) {
    return undefined;
  }

  return new CoherenceEdgeProducerService({
    pairSource: input.embeddingRecallService,
    mintPort,
    warn: input.warnLogger.warn
  });
}

// invariant: answers_with crystallizer is always-on when the HQ repo is
// present; null hqRepo → undefined → no mint.
function createAnswersWithCrystallizer(
  input: GardenRuntimeWiringInput,
  mintPort: ReturnType<typeof createGardenLegacyPathCandidateRejectionPort>
) {
  const hqRepo = createOptionalMemoryHqRepo(input.database);
  if (hqRepo === null) {
    return undefined;
  }
  return new AnswersWithEdgeProducerService({
    pairSource: new HqAnswerOverlapPairSource(hqRepo),
    mintPort,
    warn: input.warnLogger.warn
  });
}

function createGardenSchedulerRuntime(
  input: GardenRuntimeWiringInput,
  gardenDataPorts: ReturnType<typeof createGardenDataPorts>,
  forgetTombstoneAuthority: ReturnType<typeof createForgetTombstoneAuthority>,
  coherenceCrystallizer: ReturnType<typeof createCoherenceCrystallizer>,
  answersWithCrystallizer: ReturnType<typeof createAnswersWithCrystallizer>
) {
  return createGardenRuntime({
    databaseConnection: input.database.connection,
    backlogThresholds: input.gardenBacklogThresholds,
    eventLogRepo: input.eventLogRepo,
    eventPublisher: input.eventPublisher,
    gardenDataPorts,
    healthJournalRepo: input.healthJournalRepo,
    handoffGapRepo: input.sqliteHandoffGapRepo,
    orphanDetectionEnabled: input.orphanDetectionEnabled,
    orphanRadarRepo: input.orphanRadarRepo,
    healthIssueGroupRepo: input.healthIssueGroupRepo,
    pathGraphSnapshotRepo: input.pathGraphSnapshotRepo,
    pathRelationRepo: input.pathRelationRepo,
    legacyTopologyMutationsEnabled: false,
    pathPlasticityWatermarkRepo: input.pathPlasticityWatermarkRepo,
    embeddingBackfillHandler: input.embeddingBackfillHandler,
    configService: input.configService,
    officialApiGardenProvider: input.officialGardenProvider,
    localHeuristicsProvider: input.localHeuristicsProvider,
    signalReceiver: input.signalService,
    strongRefService: input.strongRefService,
    workspaceRepo: input.workspaceRepo,
    tombstoneDispositionSweepPort: createTombstoneDispositionSweepPort(
      createTombstoneDispositionSweepInput(input, forgetTombstoneAuthority)
    ),
    ...createGardenEnrichmentPorts(input, coherenceCrystallizer, answersWithCrystallizer),
    ...(input.dynamicsService === undefined ? {} : { dynamicsService: input.dynamicsService }),
    warn: input.warnLogger.warn
  });
}

function createGardenEnrichmentPorts(
  input: GardenRuntimeWiringInput,
  coherenceCrystallizer: ReturnType<typeof createCoherenceCrystallizer>,
  answersWithCrystallizer: ReturnType<typeof createAnswersWithCrystallizer>
) {
  const coherenceEdgeProducerPort = createCoherenceEdgeProducerPort(
    coherenceCrystallizer,
    input.memoryEntryRepo
  );
  const answersWithEdgeProducerPort = createAnswersWithEdgeProducerPort(
    answersWithCrystallizer,
    input.memoryEntryRepo
  );
  return {
    enrichPendingRepo: input.enrichPendingRepo,
    enrichMemoryLookup: createEnrichMemoryLookup(input),
    enrichSourceSignalLookup: {
      getById: async (signalId: string) => await input.signalRepo.getById(signalId)
    },
    enrichSignalRefReplayPort: createGardenSignalRefReplayPort({
      eventLogRepo: input.eventLogRepo,
      evidenceCapsuleLookup: input.evidenceCapsuleRepo,
      materializationRouter: input.materializationRouter
    }),
    enrichEdgeProducerPort: input.edgeAutoProducerService,
    ...(coherenceEdgeProducerPort === undefined ? {} : { coherenceEdgeProducerPort }),
    ...(answersWithEdgeProducerPort === undefined ? {} : { answersWithEdgeProducerPort }),
    ...(input.conflictDetectionService === null
      ? {}
      : { enrichConflictDetectionPort: input.conflictDetectionService }),
    edgeProposalReconcile: createGardenEdgeProposalReconcileDeferralPort(
      input.edgeProposalService,
      input.warnLogger.warn
    )
  };
}

function createTombstoneDispositionSweepInput(
  input: GardenRuntimeWiringInput,
  forgetTombstoneAuthority: ReturnType<typeof createForgetTombstoneAuthority>
) {
  return {
    memoryLookup: {
      findDormantMemories: (workspaceId: string) =>
        input.memoryEntryRepo.findDormantMemories(workspaceId),
      findById: (objectId: string) => input.memoryEntryRepo.findById(objectId)
    },
    capsuleLookup: {
      findByWorkspaceId: (workspaceId: string) =>
        input.synthesisCapsuleRepo.findByWorkspaceId(workspaceId)
    },
    tombstoneAuthority: forgetTombstoneAuthority
  };
}

function createEnrichMemoryLookup(input: GardenRuntimeWiringInput) {
  return {
    findById: async (memoryId: string) => {
      const memory = await input.memoryEntryRepo.findById(memoryId);
      if (memory === null) {
        return null;
      }
      return {
        object_id: memory.object_id,
        dimension: memory.dimension,
        scope_class: memory.scope_class,
        content: memory.content,
        domain_tags: memory.domain_tags,
        evidence_refs: memory.evidence_refs,
        workspace_id: memory.workspace_id,
        run_id: memory.run_id
      };
    }
  };
}

function createCoherenceEdgeProducerPort(
  coherenceCrystallizer: ReturnType<typeof createCoherenceCrystallizer>,
  memoryEntryRepo: GardenRuntimeWiringInput["memoryEntryRepo"]
) {
  if (coherenceCrystallizer === undefined) {
    return undefined;
  }

  return {
    crystallizeForBackfill: async (params: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly objectIds: readonly string[];
    }) => {
      const objects = await loadBackfillFormationObjects(
        memoryEntryRepo,
        params.workspaceId,
        params.objectIds
      );
      return await coherenceCrystallizer.crystallize({
        workspaceId: params.workspaceId,
        runId: params.runId,
        objects,
        floor: 0.6,
        capPerNode: 3,
        crossSessionOnly: false
      });
    }
  };
}

function createAnswersWithEdgeProducerPort(
  answersWithCrystallizer: ReturnType<typeof createAnswersWithCrystallizer>,
  memoryEntryRepo: GardenRuntimeWiringInput["memoryEntryRepo"]
) {
  if (answersWithCrystallizer === undefined) {
    return undefined;
  }

  return {
    crystallizeForBackfill: async (params: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly objectIds: readonly string[];
    }) => {
      const objects = await loadBackfillFormationObjects(
        memoryEntryRepo,
        params.workspaceId,
        params.objectIds
      );
      return await answersWithCrystallizer.crystallize({
        workspaceId: params.workspaceId,
        runId: params.runId,
        objects,
        bar: DEFAULT_ANSWER_OVERLAP_BAR,
        capPerNode: 3,
        crossSessionOnly: false
      });
    }
  };
}

function createGardenTaskRepo(input: GardenRuntimeWiringInput) {
  return typeof (input.database.connection as { readonly prepare?: unknown }).prepare === "function"
    ? new SqliteGardenTaskRepo(input.database.connection, input.eventPublisher)
    : undefined;
}

function bindGardenTaskQueueRepo(
  input: GardenRuntimeWiringInput,
  gardenTaskRepo: ReturnType<typeof createGardenTaskRepo>
): void {
  if (gardenTaskRepo !== undefined) {
    input.edgeClassifyQueueRepoHolder.current = gardenTaskRepo;
  }
}

function createGardenBacklogTelemetryService(
  input: GardenRuntimeWiringInput,
  gardenRuntime: ReturnType<typeof createGardenSchedulerRuntime>
) {
  return new GardenBacklogTelemetryService({
    scheduler: gardenRuntime.backlogTelemetrySource,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    healthJournal: input.healthJournalService,
    thresholds: input.gardenBacklogThresholds,
    warn: input.warnLogger.warn
  });
}

function startGardenBootstrapSideEffects(
  input: GardenRuntimeWiringInput,
  gardenRuntime: ReturnType<typeof createGardenSchedulerRuntime>
): void {
  scheduleAuditedAsyncSideEffect(gardenRuntime.runEventLogOrphanDetection(), {
    source: "core-daemon.startup",
    operation: "event_log_orphan_detection",
    subjectType: "daemon_runtime",
    subjectId: "__system__",
    workspaceId: "__system__",
    runId: null,
    warningCode: "ALAYA_EVENT_LOG_ORPHAN_RECONCILER_FAILED",
    warningMessage: "[CoreDaemon] event log orphan reconciler failed",
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
  scheduleAuditedAsyncSideEffect(deferGardenBootstrapPathReconciliation(
    input.workspaceRepo,
    input.warnLogger.warn
  ), {
    source: "core-daemon.startup",
    operation: "bootstrap_path_reconciliation_deferred",
    subjectType: "daemon_runtime",
    subjectId: "__system__",
    workspaceId: "__system__",
    runId: null,
    warningCode: "ALAYA_BOOTSTRAP_PATH_RECONCILE_FAILED",
    warningMessage: "[CoreDaemon] bootstrap reconcile loop crashed",
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
}
