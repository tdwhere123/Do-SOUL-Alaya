import { randomUUID } from "node:crypto";
import {
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTierValue
} from "@do-soul/alaya-protocol";
import { createBulkEnrichRuntimeSupport } from "./bulk-enrich-runtime.js";
import {
  createGardenBackgroundPassTracker,
  createBacklogTelemetryController,
  createGardenRuntimeAuditor,
  createGardenRuntimeCore,
  createGardenRuntimeEventLogPort,
  createGardenRuntimeFacade,
  createGardenRuntimeJanitor,
  createGardenRuntimeLibrarian
} from "./runtime-composition.js";
import { createGardenRuntimeBackgroundServices, BULK_ENRICH_DRAIN_CAP_PER_PASS } from "./runtime-background-services.js";
import { createHostWorkerTaskRuntimeSupport } from "./host-worker-runtime.js";
import { createGardenSchedulerRuntimeSupport } from "./scheduler-runtime-support.js";
import type {
  CreateGardenRuntimeInput,
  GardenRuntime
} from "./runtime-types.js";

export type {
  BulkEmbeddingCoherencePort,
  BulkEnrichConflictDetectionPort,
  BulkEnrichEdgeProducerPort,
  BulkEnrichMemoryLookupPort,
  BulkEnrichPendingPort,
  BulkEnrichSignalRefReplayPort,
  BulkEnrichSourceSignalLookupPort,
  CreateGardenRuntimeInput,
  EdgeProposalReconcilePort,
  GardenBacklogTelemetryObserver,
  GardenBacklogTelemetrySource,
  GardenRuntime,
  GardenRuntimeStatus,
  RuntimeGardenScheduler
} from "./runtime-types.js";

export function createGardenRuntime(input: CreateGardenRuntimeInput): GardenRuntime {
  const warn = input.warn ?? defaultGardenRuntimeWarn;
  const core = createGardenRuntimeCore(
    input,
    warn,
    createHostWorkerTaskRuntimeSupport
  );
  const telemetry = createBacklogTelemetryController({
    gardenScheduler: core.gardenScheduler,
    warn
  });
  const runtimeSupportContext = createRuntimeSupportContext(
    input,
    core.gardenScheduler,
    telemetry.requestBacklogTelemetryCapture
  );
  const gardenSchedulerRuntime = createGardenSchedulerRuntime(
    input,
    core,
    telemetry,
    runtimeSupportContext,
    warn
  );
  const roleServices = createGardenRoleServices(input, core, gardenSchedulerRuntime);
  runtimeSupportContext.bindAuditorTask(roleServices.auditorRuntime.runAuditorTask);
  const bulkEnrichRuntime = createGardenBulkEnrichRuntime(input, core, telemetry, warn);
  const backgroundPassTracker = createGardenBackgroundPassTracker();
  const backgroundServices = createGardenBackgroundRuntimeServices(
    input,
    core,
    telemetry,
    runtimeSupportContext,
    gardenSchedulerRuntime,
    roleServices,
    bulkEnrichRuntime,
    backgroundPassTracker
  );
  return createGardenRuntimeFacade(
    createGardenRuntimeFacadeInput(
      input,
      core,
      telemetry,
      gardenSchedulerRuntime,
      bulkEnrichRuntime,
      backgroundPassTracker,
      backgroundServices,
      warn
    )
  );
}

function defaultGardenRuntimeWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(message, meta);
}

function createGardenSchedulerRuntime(
  input: CreateGardenRuntimeInput,
  core: ReturnType<typeof createGardenRuntimeCore>,
  telemetry: ReturnType<typeof createBacklogTelemetryController>,
  runtimeSupportContext: ReturnType<typeof createRuntimeSupportContext>,
  warn: (message: string, meta: Record<string, unknown>) => void
): ReturnType<typeof createGardenSchedulerRuntimeSupport> {
  return createGardenSchedulerRuntimeSupport({
    coherenceEdgeProducerPort: input.coherenceEdgeProducerPort,
    answersWithEdgeProducerPort: input.answersWithEdgeProducerPort,
    configService: input.configService,
    consolidationExecutor: core.consolidationExecutor,
    embeddingBackfillHandler: input.embeddingBackfillHandler,
    edgeProposalReconcile: input.edgeProposalReconcile,
    enqueueForAllWorkspaces: runtimeSupportContext.enqueueForAllWorkspaces,
    eventPublisher: input.eventPublisher,
    gardenScheduler: core.gardenScheduler,
    healthJournalPort: core.healthJournalPort,
    pathGraphSnapshotRepo: input.pathGraphSnapshotRepo,
    pathRelationRepo: input.pathRelationRepo,
    pathPlasticityWatermarkRepo: input.pathPlasticityWatermarkRepo,
    requestBacklogTelemetryCapture: telemetry.requestBacklogTelemetryCapture,
    runtimeGardenScheduler: core.runtimeGardenScheduler,
    runAuditorTask: runtimeSupportContext.runAuditorTask,
    warn,
    workspaceRepo: input.workspaceRepo
  });
}

function createGardenBackgroundRuntimeServices(
  input: CreateGardenRuntimeInput,
  core: ReturnType<typeof createGardenRuntimeCore>,
  telemetry: ReturnType<typeof createBacklogTelemetryController>,
  runtimeSupportContext: ReturnType<typeof createRuntimeSupportContext>,
  gardenSchedulerRuntime: ReturnType<typeof createGardenSchedulerRuntimeSupport>,
  roleServices: ReturnType<typeof createGardenRoleServices>,
  bulkEnrichRuntime: ReturnType<typeof createGardenBulkEnrichRuntime>,
  backgroundPassTracker: ReturnType<typeof createGardenBackgroundPassTracker>
): ReturnType<typeof createGardenRuntimeBackgroundServices> {
  return createGardenRuntimeBackgroundServices({
    enqueueForAllWorkspaces: runtimeSupportContext.enqueueForAllWorkspaces,
    orphanDetectionEnabled: input.orphanDetectionEnabled,
    embeddingBackfillEnabled: input.embeddingBackfillHandler !== undefined,
    consolidationEnabled: core.consolidationExecutor !== null,
    gardenTaskRepoAvailable: core.gardenTaskRepo !== undefined,
    hostWorkerTaskRuntime: core.hostWorkerTaskRuntime,
    bulkEnrichRuntime,
    gardenSchedulerRuntime,
    runtimeGardenScheduler: core.runtimeGardenScheduler,
    janitor: roleServices.janitor,
    auditor: roleServices.auditorRuntime.auditor,
    librarian: roleServices.librarian,
    requestBacklogTelemetryCapture: telemetry.requestBacklogTelemetryCapture,
    markBackgroundPassCompleted: backgroundPassTracker.markBackgroundPassCompleted
  });
}

function createGardenRuntimeFacadeInput(
  input: CreateGardenRuntimeInput,
  core: ReturnType<typeof createGardenRuntimeCore>,
  telemetry: ReturnType<typeof createBacklogTelemetryController>,
  gardenSchedulerRuntime: ReturnType<typeof createGardenSchedulerRuntimeSupport>,
  bulkEnrichRuntime: ReturnType<typeof createGardenBulkEnrichRuntime>,
  backgroundPassTracker: ReturnType<typeof createGardenBackgroundPassTracker>,
  backgroundServices: ReturnType<typeof createGardenBackgroundRuntimeServices>,
  warn: (message: string, meta: Record<string, unknown>) => void
): Parameters<typeof createGardenRuntimeFacade>[0] {
  return {
    backgroundServices,
    backlogTelemetrySource: telemetry.backlogTelemetrySource,
    bulkEnrichDrainCap: BULK_ENRICH_DRAIN_CAP_PER_PASS,
    bulkEnrichRuntime,
    gardenSchedulerRuntime,
    getLastBackgroundPassAt: backgroundPassTracker.getLastBackgroundPassAt,
    healthJournalPort: core.healthJournalPort,
    markBackgroundPassCompleted: backgroundPassTracker.markBackgroundPassCompleted,
    setBacklogTelemetryObserver: telemetry.setBacklogTelemetryObserver,
    warn,
    workspaceRepo: input.workspaceRepo
  };
}

function createRuntimeSupportContext(
  input: CreateGardenRuntimeInput,
  gardenScheduler: {
    enqueue(task: {
      readonly task_id: string;
      readonly task_kind: string;
      readonly required_tier: string;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly target_object_refs: readonly string[];
      readonly priority: number;
      readonly created_at: string;
    }): void;
  },
  requestBacklogTelemetryCapture: (reason: string) => void
): Readonly<{
  enqueueForAllWorkspaces: (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs?: (workspaceId: string, nowIso: string) => readonly string[]
  ) => Promise<void>;
  runAuditorTask: (task: Readonly<GardenTaskDescriptor>) => Promise<void>;
  bindAuditorTask(runAuditorTask: (task: Readonly<GardenTaskDescriptor>) => Promise<void>): void;
}> {
  let runAuditorTask: ((task: Readonly<GardenTaskDescriptor>) => Promise<void>) | null = null;
  return {
    enqueueForAllWorkspaces: async (taskKind, requiredTier, resolveTargetObjectRefs = () => []) =>
      await enqueueGardenTaskForAllWorkspaces(
        input,
        gardenScheduler,
        requestBacklogTelemetryCapture,
        taskKind,
        requiredTier,
        resolveTargetObjectRefs
      ),
    runAuditorTask: async (task) => {
      if (runAuditorTask === null) {
        throw new Error("garden auditor runtime is unavailable");
      }
      await runAuditorTask(task);
    },
    bindAuditorTask: (taskRunner) => {
      runAuditorTask = taskRunner;
    }
  };
}

async function enqueueGardenTaskForAllWorkspaces(
  input: CreateGardenRuntimeInput,
  gardenScheduler: {
    enqueue(task: {
      readonly task_id: string;
      readonly task_kind: string;
      readonly required_tier: string;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly target_object_refs: readonly string[];
      readonly priority: number;
      readonly created_at: string;
    }): void;
  },
  requestBacklogTelemetryCapture: (reason: string) => void,
  taskKind: GardenTaskKindValue,
  requiredTier: GardenTierValue,
  resolveTargetObjectRefs: (workspaceId: string, nowIso: string) => readonly string[]
): Promise<void> {
  const workspaces = await input.workspaceRepo.list();
  const nowIso = new Date().toISOString();
  for (const workspace of workspaces) {
    gardenScheduler.enqueue({
      task_id: randomUUID(),
      task_kind: taskKind,
      required_tier: requiredTier,
      workspace_id: workspace.workspace_id,
      run_id: null,
      target_object_refs: resolveTargetObjectRefs(workspace.workspace_id, nowIso),
      priority: 10,
      created_at: nowIso
    });
  }
  if (workspaces.length > 0) {
    requestBacklogTelemetryCapture(`enqueue:${taskKind}`);
  }
}

function createGardenRoleServices(
  input: CreateGardenRuntimeInput,
  core: ReturnType<typeof createGardenRuntimeCore>,
  gardenSchedulerRuntime: ReturnType<typeof createGardenSchedulerRuntimeSupport>
): Readonly<{
  readonly janitor: ReturnType<typeof createGardenRuntimeJanitor>;
  readonly auditorRuntime: ReturnType<typeof createGardenRuntimeAuditor>;
  readonly librarian: ReturnType<typeof createGardenRuntimeLibrarian>;
}> {
  const janitor = createGardenRuntimeJanitor(
    input,
    core.gardenScheduler,
    core.healthJournalPort,
    createGardenRuntimeEventLogPort
  );
  const auditorRuntime = createGardenRuntimeAuditor({
    gardenScheduler: core.gardenScheduler,
    gardenSchedulerRuntime,
    healthJournalPort: core.healthJournalPort,
    eventPublisher: input.eventPublisher,
    gardenDataPorts: input.gardenDataPorts,
    databaseConnection: input.databaseConnection,
    healthIssueGroupRepo: input.healthIssueGroupRepo,
    orphanDetectionEnabled: input.orphanDetectionEnabled,
    orphanRadarRepo: input.orphanRadarRepo,
    createAuditorEventLogPort: createGardenRuntimeEventLogPort
  });
  const librarian = createGardenRuntimeLibrarian({
    gardenDataPorts: input.gardenDataPorts,
    gardenScheduler: core.gardenScheduler,
    gardenSchedulerRuntime,
    healthJournalPort: core.healthJournalPort,
    pathPlasticityService: input.pathPlasticityService
  });
  return { janitor, auditorRuntime, librarian };
}

function createGardenBulkEnrichRuntime(
  input: CreateGardenRuntimeInput,
  core: ReturnType<typeof createGardenRuntimeCore>,
  telemetry: ReturnType<typeof createBacklogTelemetryController>,
  warn: (message: string, meta: Record<string, unknown>) => void
): ReturnType<typeof createBulkEnrichRuntimeSupport> {
  return createBulkEnrichRuntimeSupport({
    enrichPendingRepo: input.enrichPendingRepo,
    enrichMemoryLookup: input.enrichMemoryLookup,
    enrichConflictDetectionPort: input.enrichConflictDetectionPort,
    enrichEdgeProducerPort: input.enrichEdgeProducerPort,
    enrichSourceSignalLookup: input.enrichSourceSignalLookup,
    enrichSignalRefReplayPort: input.enrichSignalRefReplayPort,
    eventPublisher: input.eventPublisher,
    gardenScheduler: core.gardenScheduler,
    gardenTaskRepo: core.gardenTaskRepo,
    onTaskEnqueued: telemetry.requestBacklogTelemetryCapture,
    warn,
    workspaceRepo: input.workspaceRepo
  });
}
