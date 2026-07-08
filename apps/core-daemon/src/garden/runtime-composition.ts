import {
  HealthEventKind,
  type AuditorEventLogPort,
  type AuditorOrphanDetectionPort,
  type EventLogEntry,
  type EventType,
  type HealthJournalRecordPort,
  type OrphanRadar
} from "@do-soul/alaya-protocol";
import {
  ConsolidationExecutor,
  type DynamicsService
} from "@do-soul/alaya-core";
import { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import {
  Auditor,
  type AuditorHealthIssueGroupPort,
  GardenScheduler,
  Janitor,
  Librarian,
  type JanitorControlPlaneCleanupPort,
  type JanitorSchedulerPort,
  type LibrarianSchedulerPort
} from "@do-soul/alaya-soul";
import { BackgroundServiceManager, type BackgroundServiceConfig } from "../background/bootstrap.js";
import { SqliteConsolidationBudgetStore, type SqlitePreparedStatement } from "./consolidation-budget-store.js";
import {
  createGardenScheduler,
  createGardenSchedulerEventLogPort,
  createGardenTaskRepo,
  createHealthJournalPort
} from "./runtime-core-support.js";
import { findEventLogOrphansForWorkspace, findOrphanedMemoriesForWorkspace } from "./orphan-query.js";
import type { BulkEnrichRuntimeSupport } from "./bulk-enrich-runtime.js";
import type { HostWorkerTaskRuntimeSupport } from "./host-worker-runtime.js";
import type { GardenSchedulerRuntimeSupport } from "./scheduler-runtime-types.js";
import type {
  CreateGardenRuntimeInput,
  GardenBacklogTelemetryObserver,
  GardenBacklogTelemetrySource,
  GardenRuntime,
  RuntimeGardenScheduler
} from "./runtime-types.js";

const DEFAULT_GARDEN_STATUS_WORKSPACE_ID = "default";

export type GardenRuntimeCore = Readonly<{
  readonly gardenScheduler: GardenScheduler;
  readonly gardenTaskRepo: SqliteGardenTaskRepo | undefined;
  readonly healthJournalPort: HealthJournalRecordPort;
  readonly hostWorkerTaskRuntime: HostWorkerTaskRuntimeSupport;
  readonly runtimeGardenScheduler: RuntimeGardenScheduler;
  readonly consolidationExecutor: ConsolidationExecutor | null;
}>;

export function createGardenRuntimeCore(
  input: CreateGardenRuntimeInput,
  warn: (message: string, meta: Record<string, unknown>) => void,
  createHostWorkerTaskRuntimeSupport: (input: Readonly<{
    readonly gardenTaskRepo?: SqliteGardenTaskRepo;
    readonly configService?: CreateGardenRuntimeInput["configService"];
    readonly eventPublisher: CreateGardenRuntimeInput["eventPublisher"];
    readonly localHeuristicsProvider?: CreateGardenRuntimeInput["localHeuristicsProvider"];
    readonly officialApiGardenProvider?: CreateGardenRuntimeInput["officialApiGardenProvider"];
    readonly signalReceiver?: CreateGardenRuntimeInput["signalReceiver"];
    readonly warn: (message: string, meta: Record<string, unknown>) => void;
  }>) => HostWorkerTaskRuntimeSupport
): GardenRuntimeCore {
  const schedulerEventLogPort = createGardenSchedulerEventLogPort(input.eventPublisher);
  const healthJournalPort = createHealthJournalPort(input.healthJournalRepo);
  const gardenTaskRepo = createGardenTaskRepo(input);
  const hostWorkerTaskRuntime = createHostWorkerTaskRuntimeSupport({
    gardenTaskRepo,
    configService: input.configService,
    eventPublisher: input.eventPublisher,
    localHeuristicsProvider: input.localHeuristicsProvider,
    officialApiGardenProvider: input.officialApiGardenProvider,
    signalReceiver: input.signalReceiver,
    warn
  });
  const gardenScheduler = createGardenScheduler(
    input,
    schedulerEventLogPort,
    healthJournalPort,
    gardenTaskRepo,
    warn
  );
  const runtimeGardenScheduler = gardenScheduler as RuntimeGardenScheduler;
  const consolidationExecutor = createConsolidationExecutor(input);

  return {
    gardenScheduler,
    gardenTaskRepo,
    healthJournalPort,
    hostWorkerTaskRuntime,
    runtimeGardenScheduler,
    consolidationExecutor
  };
}

export function createGardenBackgroundPassTracker(): Readonly<{
  getLastBackgroundPassAt(): string | null;
  markBackgroundPassCompleted(): void;
}> {
  let lastBackgroundPassAt: string | null = null;
  return {
    getLastBackgroundPassAt: () => lastBackgroundPassAt,
    markBackgroundPassCompleted: () => {
      lastBackgroundPassAt = new Date().toISOString();
    }
  };
}

export function createBacklogTelemetryController(input: Readonly<{
  readonly gardenScheduler: GardenScheduler;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>): Readonly<{
  readonly backlogTelemetrySource: GardenBacklogTelemetrySource;
  requestBacklogTelemetryCapture(reason: string): void;
  setBacklogTelemetryObserver(observer: GardenBacklogTelemetryObserver | null): void;
}> {
  let backlogTelemetryObserver: GardenBacklogTelemetryObserver | null = null;
  const backlogTelemetrySource: GardenBacklogTelemetrySource = {
    getBacklogSnapshot: () => input.gardenScheduler.getBacklogSnapshot(),
    peekBacklogWarningTransition: () => input.gardenScheduler.peekBacklogWarningTransition(),
    peekLastBacklogWarningTransitionId: () =>
      input.gardenScheduler.peekLastBacklogWarningTransitionId(),
    acknowledgeBacklogWarningTransition: (transitionId: number) =>
      input.gardenScheduler.acknowledgeBacklogWarningTransition(transitionId)
  };

  return {
    backlogTelemetrySource,
    requestBacklogTelemetryCapture: (reason: string): void => {
      if (backlogTelemetryObserver === null) {
        return;
      }

      void backlogTelemetryObserver.capture().catch((error) => {
        input.warn("garden backlog telemetry observer capture failed", {
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    },
    setBacklogTelemetryObserver: (observer) => {
      backlogTelemetryObserver = observer;
    }
  };
}

export function createGardenRuntimeJanitor(
  input: CreateGardenRuntimeInput,
  gardenScheduler: GardenScheduler,
  healthJournalPort: HealthJournalRecordPort,
  createAuditorEventLogPort: (eventPublisher: CreateGardenRuntimeInput["eventPublisher"]) => AuditorEventLogPort
): Janitor {
  const cleanupPort: JanitorControlPlaneCleanupPort = {
    findExpiredObjects: async (workspaceId: string, nowIso: string) =>
      input.handoffGapRepo.findExpiredObjectsByWorkspace(workspaceId, nowIso),
    removeExpiredObjects: async (_workspaceId: string, objectIds: readonly string[]) => {
      for (const id of objectIds) {
        input.handoffGapRepo.deleteById(id);
      }
    }
  };
  const janitorSchedulerPort: JanitorSchedulerPort = {
    reportCompletion: (result) => gardenScheduler.reportCompletion(result)
  };
  const janitorEventLogPort = createAuditorEventLogPort(input.eventPublisher);

  return new Janitor({
    cleanupPort,
    tieringPort: input.gardenDataPorts.tieringPort,
    dormantDemotionPort: input.gardenDataPorts.dormantDemotionPort,
    ...(input.tombstoneDispositionSweepPort === undefined
      ? {}
      : { dispositionSweepPort: input.tombstoneDispositionSweepPort }),
    ...(input.tombstoneGcPort === undefined ? {} : { tombstoneGcPort: input.tombstoneGcPort }),
    scheduler: janitorSchedulerPort,
    strongRefProtectionPort: {
      isProtected: async (workspaceId: string, targetEntityType: string, targetEntityId: string) =>
        await input.strongRefService.isProtected(workspaceId, targetEntityType, targetEntityId)
    },
    ...(input.dynamicsService === undefined
      ? {}
      : {
          retentionDecayPort: {
            scanRetentionDecay: (workspaceId: string) =>
              input.dynamicsService!.scanRetentionDecay(workspaceId)
          }
        }),
    eventLogRepo: janitorEventLogPort
  });
}

export function createGardenRuntimeAuditor(input: Readonly<{
  readonly gardenScheduler: GardenScheduler;
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  readonly healthJournalPort: HealthJournalRecordPort;
  readonly eventPublisher: CreateGardenRuntimeInput["eventPublisher"];
  readonly gardenDataPorts: CreateGardenRuntimeInput["gardenDataPorts"];
  readonly databaseConnection: CreateGardenRuntimeInput["databaseConnection"];
  readonly healthIssueGroupRepo: CreateGardenRuntimeInput["healthIssueGroupRepo"];
  readonly orphanDetectionEnabled: boolean;
  readonly orphanRadarRepo: CreateGardenRuntimeInput["orphanRadarRepo"];
  readonly createAuditorEventLogPort: (
    eventPublisher: CreateGardenRuntimeInput["eventPublisher"]
  ) => AuditorEventLogPort;
}>): Readonly<{
  readonly auditor: Auditor;
  readonly runAuditorTask: (task: Parameters<Auditor["run"]>[0]) => Promise<void>;
}> {
  const orphanDetectionPort = createOrphanDetectionPort(input);
  const auditorEventLogPort = input.createAuditorEventLogPort(input.eventPublisher);
  const healthIssueGroupPort = createAuditorHealthIssueGroupPort(input.healthIssueGroupRepo);
  const auditorSchedulerPort = createAuditorSchedulerPort(input.gardenScheduler);
  const evidenceCheckPort = createAuditorEvidenceCheckPort(input);

  const auditor = new Auditor({
    evidenceCheckPort,
    pointerHealthPort: input.gardenDataPorts.pointerHealthPort,
    greenMaintenancePort: input.gardenDataPorts.greenMaintenancePort,
    bootstrappingPort: input.gardenDataPorts.bootstrappingPort,
    orphanDetectionPort,
    scheduler: auditorSchedulerPort,
    healthJournal: input.healthJournalPort,
    eventLogRepo: auditorEventLogPort,
    ...(healthIssueGroupPort === undefined ? {} : { healthIssueGroupPort })
  });

  return {
    auditor,
    runAuditorTask: async (task) => {
      await auditor.run(task);
    }
  };
}

function createAuditorHealthIssueGroupPort(
  healthIssueGroupRepo: CreateGardenRuntimeInput["healthIssueGroupRepo"]
): AuditorHealthIssueGroupPort | undefined {
  if (healthIssueGroupRepo === undefined) {
    return undefined;
  }
  return {
    findExistingGroup: (lookup) =>
      healthIssueGroupRepo.findByCompositeKey(
        lookup.workspaceId,
        lookup.targetObjectId,
        lookup.causeKind
      ),
    upsertHealthIssueGroup: (group) => {
      healthIssueGroupRepo.upsert(group);
    }
  };
}

function createAuditorSchedulerPort(
  gardenScheduler: GardenScheduler
): {
  reportCompletion(
    result: Parameters<GardenScheduler["reportCompletion"]>[0]
  ): ReturnType<GardenScheduler["reportCompletion"]>;
} {
  return {
    reportCompletion: (
      result: Parameters<GardenScheduler["reportCompletion"]>[0]
    ) => gardenScheduler.reportCompletion(result)
  };
}

function createAuditorEvidenceCheckPort(input: Readonly<{
  readonly gardenDataPorts: CreateGardenRuntimeInput["gardenDataPorts"];
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
}>): {
  findMemoriesWithStaleEvidence(
    workspaceId: string
  ): ReturnType<CreateGardenRuntimeInput["gardenDataPorts"]["evidenceCheckPort"]["findMemoriesWithStaleEvidence"]>;
} {
  return {
    findMemoriesWithStaleEvidence: async (workspaceId: string) =>
      await findPrioritizedStaleEvidenceEntries(input, workspaceId)
  };
}

async function findPrioritizedStaleEvidenceEntries(
  input: Readonly<{
    readonly gardenDataPorts: CreateGardenRuntimeInput["gardenDataPorts"];
    readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  }>,
  workspaceId: string
) {
  const staleEntries =
    await input.gardenDataPorts.evidenceCheckPort.findMemoriesWithStaleEvidence(workspaceId);
  if (staleEntries.length <= 1) {
    return staleEntries;
  }
  const prioritized =
    await input.gardenSchedulerRuntime.auditorSchedulingAdvisor.prioritizeRechecksByBias(
      workspaceId,
      staleEntries.map((entry) => ({
        memoryObjectId: entry.memory_entry_id,
        enqueuedAt: "1970-01-01T00:00:00.000Z"
      }))
    );
  const priorityByMemoryId = new Map(
    prioritized.map((entry, index) => [entry.memoryObjectId, index])
  );
  return Object.freeze(
    [...staleEntries].sort((left, right) => {
      const leftRank = priorityByMemoryId.get(left.memory_entry_id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank =
        priorityByMemoryId.get(right.memory_entry_id) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    })
  );
}

export function createGardenRuntimeLibrarian(input: Readonly<{
  readonly gardenDataPorts: CreateGardenRuntimeInput["gardenDataPorts"];
  readonly gardenScheduler: GardenScheduler;
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  readonly healthJournalPort: HealthJournalRecordPort;
  readonly pathPlasticityService: CreateGardenRuntimeInput["pathPlasticityService"];
}>): Librarian {
  const librarianSchedulerPort: LibrarianSchedulerPort = {
    reportCompletion: (result) => input.gardenScheduler.reportCompletion(result)
  };
  const pathPlasticityPort =
    input.pathPlasticityService === undefined
      ? undefined
      : {
          computeAndApplyPlasticity: input.pathPlasticityService.computeAndApplyPlasticity.bind(
            input.pathPlasticityService
          ),
          markProcessed: input.gardenSchedulerRuntime.markPathPlasticityProcessed
        };

  return new Librarian({
    mergePort: input.gardenDataPorts.mergePort,
    neighborPort: input.gardenDataPorts.neighborPort,
    compressionPort: input.gardenDataPorts.compressionPort,
    synthesisPort: input.gardenDataPorts.synthesisPort,
    ...(pathPlasticityPort === undefined ? {} : { pathPlasticityPort }),
    pathPlasticityPendingPort: input.gardenSchedulerRuntime.pathPlasticityPendingPort,
    scheduler: librarianSchedulerPort,
    healthJournal: input.healthJournalPort
  });
}

export function createGardenRuntimeFacade(input: Readonly<{
  readonly backgroundServices: readonly BackgroundServiceConfig[];
  readonly backlogTelemetrySource: GardenBacklogTelemetrySource;
  readonly bulkEnrichDrainCap: number;
  readonly bulkEnrichRuntime: BulkEnrichRuntimeSupport;
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  readonly getLastBackgroundPassAt: () => string | null;
  readonly healthJournalPort: HealthJournalRecordPort;
  readonly markBackgroundPassCompleted: () => void;
  readonly setBacklogTelemetryObserver: (
    observer: GardenBacklogTelemetryObserver | null
  ) => void;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly workspaceRepo: CreateGardenRuntimeInput["workspaceRepo"];
}>): GardenRuntime {
  const backgroundManager = new BackgroundServiceManager([...input.backgroundServices], {
    logger: { warn: input.warn }
  });

  return Object.freeze({
    backgroundManager,
    backlogTelemetrySource: input.backlogTelemetrySource,
    getStatus: () => ({
      last_pass_at: input.getLastBackgroundPassAt()
    }),
    runEventLogOrphanDetection: () => input.gardenSchedulerRuntime.runEventLogOrphanDetection(),
    runBulkEnrichPass: async (workspaceId: string) => {
      await input.bulkEnrichRuntime.runClaimableWorkspacePass(
        workspaceId,
        input.bulkEnrichDrainCap
      );
    },
    runEmbeddingBackfillPass: (workspaceId: string) =>
      input.gardenSchedulerRuntime.runEmbeddingBackfillPass(workspaceId),
    runBackgroundPass: async () => {
      for (const service of input.backgroundServices) {
        await service.task();
      }
      input.markBackgroundPassCompleted();
      const workspaces = await input.workspaceRepo.list();
      const workspaceIds =
        workspaces.length === 0
          ? [DEFAULT_GARDEN_STATUS_WORKSPACE_ID]
          : workspaces.map((workspace) => workspace.workspace_id);
      for (const workspaceId of workspaceIds) {
        await input.healthJournalPort.record({
          event_kind: HealthEventKind.GARDEN_BACKLOG,
          workspace_id: workspaceId,
          run_id: null,
          summary: "Garden background pass completed",
          detail_json: {
            service_count: input.backgroundServices.length,
            services: input.backgroundServices.map((service) => service.name)
          }
        });
      }
    },
    setBacklogTelemetryObserver: input.setBacklogTelemetryObserver
  });
}

function createConsolidationExecutor(
  input: CreateGardenRuntimeInput
): ConsolidationExecutor | null {
  if (typeof (input.databaseConnection as { readonly prepare?: unknown }).prepare !== "function") {
    return null;
  }
  const consolidationBudgetStore = new SqliteConsolidationBudgetStore(
    input.databaseConnection as { prepare(sql: string): SqlitePreparedStatement }
  );
  return new ConsolidationExecutor({
    pathRelationRepo: input.pathRelationRepo,
    budgetStore: consolidationBudgetStore,
    eventPublisher: input.eventPublisher
  });
}

function createOrphanDetectionPort(input: Readonly<{
  readonly databaseConnection: CreateGardenRuntimeInput["databaseConnection"];
  readonly orphanDetectionEnabled: boolean;
  readonly orphanRadarRepo: CreateGardenRuntimeInput["orphanRadarRepo"];
}>): AuditorOrphanDetectionPort | undefined {
  const orphanRadarRepo = input.orphanRadarRepo;
  if (!input.orphanDetectionEnabled || orphanRadarRepo === null) {
    return undefined;
  }
  return {
    findOrphanedMemories: async (workspaceId: string) =>
      await findOrphanedMemoriesForWorkspace(input.databaseConnection, workspaceId),
    createOrphanRadarRecord: (record: Readonly<OrphanRadar>) => {
      orphanRadarRepo.create(record);
    },
    findEventLogOrphans: async (workspaceId: string) =>
      await findEventLogOrphansForWorkspace(input.databaseConnection, workspaceId),
    createEventLogOrphanRadarRecord: (record) => {
      orphanRadarRepo.createEventLogOrphan(record);
    }
  };
}

export function createGardenRuntimeEventLogPort(
  eventPublisher: CreateGardenRuntimeInput["eventPublisher"]
): AuditorEventLogPort {
  return {
    append: async (entry) =>
      (await eventPublisher.publish({
        ...entry,
        event_type: entry.event_type as EventType
      })) as EventLogEntry,
    appendManyWithMutation: async (entries, mutate) =>
      await eventPublisher.appendManyWithMutation(
        entries.map((entry) => ({
          ...entry,
          event_type: entry.event_type as EventType
        })),
        mutate
      )
  };
}
