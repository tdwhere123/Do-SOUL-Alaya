import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenRoleValue,
  type GardenTierValue
} from "@do-soul/alaya-protocol";
import type { BackgroundServiceConfig } from "../background/bootstrap.js";
import type { GardenSchedulerRuntimeSupport } from "./scheduler-runtime-support.js";
import type { RuntimeGardenScheduler } from "./runtime-types.js";

export const BULK_ENRICH_DRAIN_CAP_PER_PASS = 32;

const JANITOR_RUNTIME_TASK_KINDS = [
  GardenTaskKind.TTL_CLEANUP,
  GardenTaskKind.HOT_INDEX_DEMOTION,
  GardenTaskKind.DORMANT_DEMOTION,
  GardenTaskKind.TOMBSTONE_GC
] as const satisfies readonly GardenTaskKindValue[];
const AUDITOR_RUNTIME_TASK_KINDS = [
  GardenTaskKind.EVIDENCE_STALENESS_CHECK,
  GardenTaskKind.POINTER_HEALTH_CHECK,
  GardenTaskKind.GREEN_MAINTENANCE,
  GardenTaskKind.BOOTSTRAPPING_SCAN,
  GardenTaskKind.CRYSTALLIZATION_SCAN,
  GardenTaskKind.POINTER_HEALING,
  GardenTaskKind.ORPHAN_DETECTION,
  GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION
] as const satisfies readonly GardenTaskKindValue[];
const LIBRARIAN_RUNTIME_TASK_KINDS = [
  GardenTaskKind.MERGE_PROPOSAL,
  GardenTaskKind.PATH_GRAPH_SNAPSHOT,
  GardenTaskKind.SUBJECT_NEIGHBOR_DETECT,
  GardenTaskKind.PATH_COMPRESSION,
  GardenTaskKind.TEMPLATE_CANDIDATE,
  GardenTaskKind.SYNTHESIS_REVIEW,
  GardenTaskKind.EMBEDDING_BACKFILL,
  GardenTaskKind.PATH_PLASTICITY_UPDATE,
  GardenTaskKind.CONSOLIDATION_CYCLE,
  GardenTaskKind.BULK_ENRICH
] as const satisfies readonly GardenTaskKindValue[];

type GardenRoleHandler = {
  run(task: Readonly<GardenTaskDescriptor>): Promise<unknown>;
};

export function createGardenRuntimeBackgroundServices(input: Readonly<{
  readonly enqueueForAllWorkspaces: (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs?: (workspaceId: string, nowIso: string) => readonly string[]
  ) => Promise<void>;
  readonly orphanDetectionEnabled: boolean;
  readonly embeddingBackfillEnabled: boolean;
  readonly consolidationEnabled: boolean;
  readonly gardenTaskRepoAvailable: boolean;
  readonly hostWorkerTaskRuntime: {
    reclaimAbandonedGardenClaims(): Promise<void>;
    expireUnclaimedHostWorkerTasks(): Promise<void>;
    processPostTurnExtractTask(): Promise<void>;
  };
  readonly bulkEnrichRuntime: {
    reclaimStaleClaims(): void;
    enqueueForAllWorkspaces(enqueuedWorkspaceIds: Set<string>): Promise<void>;
    enqueueForCountThreshold(enqueuedWorkspaceIds: Set<string>): Promise<void>;
    runTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
  };
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  readonly runtimeGardenScheduler: RuntimeGardenScheduler;
  readonly janitor: GardenRoleHandler;
  readonly auditor: GardenRoleHandler;
  readonly librarian: GardenRoleHandler;
  readonly requestBacklogTelemetryCapture: (reason: string) => void;
  readonly markBackgroundPassCompleted: () => void;
}>): BackgroundServiceConfig[] {
  return [
    createJanitorBackgroundService(input),
    createAuditorBackgroundService(input),
    createLibrarianBackgroundService(input),
    createGardenSchedulerBackgroundService(input)
  ];
}

function createJanitorBackgroundService(input: Readonly<{
  readonly enqueueForAllWorkspaces: (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs?: (workspaceId: string, nowIso: string) => readonly string[]
  ) => Promise<void>;
  readonly markBackgroundPassCompleted: () => void;
}>): BackgroundServiceConfig {
  return {
    name: "Janitor",
    intervalMs: 300_000,
    task: async () => {
      await input.enqueueForAllWorkspaces(GardenTaskKind.TTL_CLEANUP, GardenTier.TIER_0);
      await input.enqueueForAllWorkspaces(GardenTaskKind.DORMANT_DEMOTION, GardenTier.TIER_0);
      await input.enqueueForAllWorkspaces(GardenTaskKind.TOMBSTONE_GC, GardenTier.TIER_0);
      input.markBackgroundPassCompleted();
    }
  };
}

function createAuditorBackgroundService(input: Readonly<{
  readonly enqueueForAllWorkspaces: (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs?: (workspaceId: string, nowIso: string) => readonly string[]
  ) => Promise<void>;
  readonly orphanDetectionEnabled: boolean;
  readonly markBackgroundPassCompleted: () => void;
}>): BackgroundServiceConfig {
  return {
    name: "Auditor",
    intervalMs: 1_800_000,
    task: async () => {
      await input.enqueueForAllWorkspaces(GardenTaskKind.EVIDENCE_STALENESS_CHECK, GardenTier.TIER_1);
      if (input.orphanDetectionEnabled) {
        await input.enqueueForAllWorkspaces(GardenTaskKind.ORPHAN_DETECTION, GardenTier.TIER_1);
        await input.enqueueForAllWorkspaces(GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION, GardenTier.TIER_1);
      }
      input.markBackgroundPassCompleted();
    }
  };
}

function createLibrarianBackgroundService(input: Readonly<{
  readonly enqueueForAllWorkspaces: (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs?: (workspaceId: string, nowIso: string) => readonly string[]
  ) => Promise<void>;
  readonly embeddingBackfillEnabled: boolean;
  readonly consolidationEnabled: boolean;
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  readonly markBackgroundPassCompleted: () => void;
}>): BackgroundServiceConfig {
  return {
    name: "Librarian",
    intervalMs: 900_000,
    task: async () => {
      await input.enqueueForAllWorkspaces(GardenTaskKind.MERGE_PROPOSAL, GardenTier.TIER_2);
      if (input.embeddingBackfillEnabled) {
        await input.gardenSchedulerRuntime.enqueueEmbeddingBackfillForAllWorkspaces();
      }
      await input.gardenSchedulerRuntime.enqueuePathPlasticityForAllWorkspaces();
      await enqueueWorkspaceScopedLibrarianTasks(input);
      input.markBackgroundPassCompleted();
    }
  };
}

async function enqueueWorkspaceScopedLibrarianTasks(input: Readonly<{
  readonly enqueueForAllWorkspaces: (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs?: (workspaceId: string, nowIso: string) => readonly string[]
  ) => Promise<void>;
  readonly consolidationEnabled: boolean;
}>): Promise<void> {
  await input.enqueueForAllWorkspaces(
    GardenTaskKind.PATH_GRAPH_SNAPSHOT,
    GardenTier.TIER_2,
    (workspaceId) => [workspaceId]
  );
  if (input.consolidationEnabled) {
    await input.enqueueForAllWorkspaces(
      GardenTaskKind.CONSOLIDATION_CYCLE,
      GardenTier.TIER_2,
      (workspaceId) => [workspaceId]
    );
  }
}

function createGardenSchedulerBackgroundService(input: Readonly<{
  readonly gardenTaskRepoAvailable: boolean;
  readonly hostWorkerTaskRuntime: {
    reclaimAbandonedGardenClaims(): Promise<void>;
    expireUnclaimedHostWorkerTasks(): Promise<void>;
    processPostTurnExtractTask(): Promise<void>;
  };
  readonly bulkEnrichRuntime: {
    reclaimStaleClaims(): void;
    enqueueForAllWorkspaces(enqueuedWorkspaceIds: Set<string>): Promise<void>;
    enqueueForCountThreshold(enqueuedWorkspaceIds: Set<string>): Promise<void>;
    runTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
  };
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  readonly runtimeGardenScheduler: RuntimeGardenScheduler;
  readonly janitor: GardenRoleHandler;
  readonly auditor: GardenRoleHandler;
  readonly librarian: GardenRoleHandler;
  readonly requestBacklogTelemetryCapture: (reason: string) => void;
  readonly markBackgroundPassCompleted: () => void;
}>): BackgroundServiceConfig {
  return {
    name: "GardenScheduler",
    intervalMs: 60_000,
    task: async () => {
      await runGardenSchedulerMaintenance(input);
      await drainBulkEnrichTasks(input);
      await dispatchRuntimeRoleTasks(input);
      input.markBackgroundPassCompleted();
    }
  };
}

async function runGardenSchedulerMaintenance(input: Readonly<{
  readonly gardenTaskRepoAvailable: boolean;
  readonly hostWorkerTaskRuntime: {
    reclaimAbandonedGardenClaims(): Promise<void>;
    expireUnclaimedHostWorkerTasks(): Promise<void>;
    processPostTurnExtractTask(): Promise<void>;
  };
  readonly bulkEnrichRuntime: {
    reclaimStaleClaims(): void;
    enqueueForAllWorkspaces(enqueuedWorkspaceIds: Set<string>): Promise<void>;
    enqueueForCountThreshold(enqueuedWorkspaceIds: Set<string>): Promise<void>;
  };
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
}>): Promise<void> {
  if (input.gardenTaskRepoAvailable) {
    await input.hostWorkerTaskRuntime.reclaimAbandonedGardenClaims();
    await input.hostWorkerTaskRuntime.expireUnclaimedHostWorkerTasks();
  }
  input.bulkEnrichRuntime.reclaimStaleClaims();
  await input.gardenSchedulerRuntime.reconcileStuckEdgeProposalAccepts();
  await input.gardenSchedulerRuntime.sweepExpiredEdgeProposals();
  await input.hostWorkerTaskRuntime.processPostTurnExtractTask();
  const bulkEnrichEnqueuedThisPass = new Set<string>();
  await input.bulkEnrichRuntime.enqueueForAllWorkspaces(bulkEnrichEnqueuedThisPass);
  await input.bulkEnrichRuntime.enqueueForCountThreshold(bulkEnrichEnqueuedThisPass);
}

async function drainBulkEnrichTasks(input: Readonly<{
  readonly bulkEnrichRuntime: {
    runTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
  };
  readonly runtimeGardenScheduler: RuntimeGardenScheduler;
}>): Promise<void> {
  for (let drained = 0; drained < BULK_ENRICH_DRAIN_CAP_PER_PASS; drained += 1) {
    const bulkEnrichTask = await input.runtimeGardenScheduler.dispatchNextMatchingTaskKind(
      GardenRole.LIBRARIAN,
      [GardenTaskKind.BULK_ENRICH]
    );
    if (bulkEnrichTask === null) {
      break;
    }
    await input.bulkEnrichRuntime.runTask(bulkEnrichTask);
  }
}

async function dispatchRuntimeRoleTasks(input: Readonly<{
  readonly runtimeGardenScheduler: RuntimeGardenScheduler;
  readonly janitor: GardenRoleHandler;
  readonly auditor: GardenRoleHandler;
  readonly librarian: GardenRoleHandler;
  readonly bulkEnrichRuntime: {
    runTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
  };
  readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  readonly requestBacklogTelemetryCapture: (reason: string) => void;
}>): Promise<void> {
  for (const [role, handler, runtimeTaskKinds] of runtimeRoleDispatchEntries(input)) {
    const task = await input.runtimeGardenScheduler.dispatchNextMatchingTaskKind(
      role,
      runtimeTaskKinds
    );
    input.requestBacklogTelemetryCapture(`dispatch:${role}`);
    if (task !== null) {
      await dispatchRuntimeRoleTask(input, handler, task);
    }
  }
}

function runtimeRoleDispatchEntries(input: Readonly<{
  readonly janitor: GardenRoleHandler;
  readonly auditor: GardenRoleHandler;
  readonly librarian: GardenRoleHandler;
}>): ReadonlyArray<readonly [GardenRoleValue, GardenRoleHandler, readonly GardenTaskKindValue[]]> {
  return [
    [GardenRole.JANITOR, input.janitor, JANITOR_RUNTIME_TASK_KINDS],
    [GardenRole.AUDITOR, input.auditor, AUDITOR_RUNTIME_TASK_KINDS],
    [GardenRole.LIBRARIAN, input.librarian, LIBRARIAN_RUNTIME_TASK_KINDS]
  ] as const;
}

async function dispatchRuntimeRoleTask(
  input: Readonly<{
    readonly bulkEnrichRuntime: {
      runTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
    };
    readonly gardenSchedulerRuntime: GardenSchedulerRuntimeSupport;
  }>,
  handler: GardenRoleHandler,
  task: Readonly<GardenTaskDescriptor>
): Promise<void> {
  if (task.task_kind === GardenTaskKind.PATH_GRAPH_SNAPSHOT) {
    await input.gardenSchedulerRuntime.runPathGraphSnapshotTask(task);
    return;
  }
  if (task.task_kind === GardenTaskKind.EMBEDDING_BACKFILL) {
    await input.gardenSchedulerRuntime.runEmbeddingBackfillTask(task);
    return;
  }
  if (task.task_kind === GardenTaskKind.CONSOLIDATION_CYCLE) {
    await input.gardenSchedulerRuntime.runConsolidationCycleTask(task);
    return;
  }
  if (task.task_kind === GardenTaskKind.BULK_ENRICH) {
    await input.bulkEnrichRuntime.runTask(task);
    return;
  }
  await handler.run(task);
}
