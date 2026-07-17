import {
  SqliteBootstrappingRecordRepo,
  SqliteClaimFormRepo,
  SqliteConfigRepo,
  SqliteConflictMatrixRepo,
  SqliteCrossCuttingPermissionRepo,
  SqliteDeferredObligationRepo,
  SqliteEngineBindingRepo,
  SqliteEdgeProposalRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteExtensionDescriptorRepo,
  SqliteFileRepo,
  SqliteGardenTaskRepo,
  SqliteGreenStatusRepo,
  SqliteHealthJournalRepo,
  SqliteHandoffGapRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteOrphanRadarRepo,
  SqliteCoUsageCounterRepo,
  SqliteEnrichPendingRepo,
  SqliteSourceGroundingDeferQueueRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathPlasticityWatermarkRepo,
  SqlitePathRelationRepo,
  SqliteRelationAssertionRepo,
  SqliteProjectMappingAnchorRepo,
  SqliteProposalRepo,
  SqliteReconciliationLeaseRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteSlotRepo,
  SqliteStrongRefRepo,
  SqliteSurfaceAnchorRepo,
  SqliteSurfaceBindingRepo,
  SqliteSurfaceIdentityRepo,
  SqliteSynthesisCapsuleRepo,
  SqliteToolExecutionRecordRepo,
  SqliteToolSpecRepo,
  SqliteTrustStateRepo,
  SqliteWorkerRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  createOptionalGlobalMemoryRecallCacheRepo,
  createOptionalGlobalMemoryRepo
} from "./daemon-runtime-support.js";
import type { WarnLogger } from "./daemon-runtime-helpers.js";
import { SqliteWorkspaceEngineConfigRepo } from "../services/workspace-engine-config-repo.js";

export function createDaemonRepositories(input: {
  readonly database: StorageDatabase;
  readonly warn: WarnLogger["warn"];
}) {
  const coreRepos = createCoreDaemonRepos(input.database);
  const memoryRepos = createDaemonMemoryRepos(input);
  const surfaceRepos = createDaemonSurfaceRepos(input.database);
  const runtimeRepos = createDaemonRuntimeRepos(input.database);

  return Object.freeze({
    ...coreRepos,
    ...memoryRepos,
    ...surfaceRepos,
    ...runtimeRepos
  });
}

function createCoreDaemonRepos(database: StorageDatabase) {
  return {
    workspaceRepo: new SqliteWorkspaceRepo(database),
    runRepo: new SqliteRunRepo(database),
    bindingRepo: new SqliteEngineBindingRepo(database),
    bootstrappingRecordRepo: new SqliteBootstrappingRecordRepo(database),
    configRepo: new SqliteConfigRepo(database),
    eventLogRepo: new SqliteEventLogRepo(database),
    reconciliationLeaseRepo: new SqliteReconciliationLeaseRepo(database),
    signalRepo: new SqliteSignalRepo(database),
    edgeProposalRepo: new SqliteEdgeProposalRepo(database),
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    projectMappingAnchorRepo: new SqliteProjectMappingAnchorRepo(database),
    synthesisCapsuleRepo: new SqliteSynthesisCapsuleRepo(database),
    claimFormRepo: new SqliteClaimFormRepo(database),
    conflictMatrixRepo: new SqliteConflictMatrixRepo(database),
    slotRepo: new SqliteSlotRepo(database),
    proposalRepo: new SqliteProposalRepo(database),
    greenStatusRepo: new SqliteGreenStatusRepo(database),
    healthJournalRepo: new SqliteHealthJournalRepo(database),
    fileRepo: new SqliteFileRepo(database),
    karmaEventRepo: new SqliteKarmaEventRepo(database),
    toolSpecRepo: new SqliteToolSpecRepo(database),
    toolExecutionRecordRepo: new SqliteToolExecutionRecordRepo(database),
    extensionDescriptorRepo: new SqliteExtensionDescriptorRepo(database),
    trustStateRepo: new SqliteTrustStateRepo(database),
    strongRefRepo: new SqliteStrongRefRepo(database)
  };
}

function createDaemonMemoryRepos(input: {
  readonly database: StorageDatabase;
  readonly warn: WarnLogger["warn"];
}) {
  const memoryEntryRepo = new SqliteMemoryEntryRepo(input.database, (message, meta) =>
    input.warn(message, meta)
  );
  const enrichPendingRepo = new SqliteEnrichPendingRepo(input.database);
  const sourceGroundingDeferQueueRepo = new SqliteSourceGroundingDeferQueueRepo(input.database);

  return {
    memoryEntryRepo,
    globalMemoryRepo: createOptionalGlobalMemoryRepo(input.database),
    globalMemoryRecallCacheRepo: createOptionalGlobalMemoryRecallCacheRepo(input.database),
    orphanDetectionEnabled: process.env.ORPHAN_DETECTION_ENABLED !== "false",
    orphanRadarRepo:
      process.env.ORPHAN_DETECTION_ENABLED !== "false"
        ? new SqliteOrphanRadarRepo(input.database)
        : null,
    pathRelationRepo: new SqlitePathRelationRepo(input.database),
    relationAssertionRepo: new SqliteRelationAssertionRepo(input.database),
    coUsageCounterRepo: new SqliteCoUsageCounterRepo(input.database),
    enrichPendingRepo,
    enqueueEnrichPending: createEnrichPendingEnqueue(enrichPendingRepo),
    sourceGroundingDeferQueueRepo,
    pathPlasticityWatermarkRepo: new SqlitePathPlasticityWatermarkRepo(input.database),
    pathGraphSnapshotRepo: new SqlitePathGraphSnapshotRepo(input.database)
  };
}

function createEnrichPendingEnqueue(enrichPendingRepo: SqliteEnrichPendingRepo) {
  return (params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void => {
    enrichPendingRepo.enqueue({
      workspaceId: params.workspaceId,
      memoryId: params.memoryId,
      runId: params.runId,
      sourceSignalId: params.sourceSignalId,
      enqueuedAt: new Date().toISOString()
    });
  };
}

function createDaemonSurfaceRepos(database: StorageDatabase) {
  return {
    surfaceIdentityRepo: new SqliteSurfaceIdentityRepo(database),
    surfaceAnchorRepo: new SqliteSurfaceAnchorRepo(database),
    surfaceBindingRepo: new SqliteSurfaceBindingRepo(database),
    crossCuttingPermissionRepo: new SqliteCrossCuttingPermissionRepo(database)
  };
}

function createDaemonRuntimeRepos(database: StorageDatabase) {
  return {
    deferredObligationRepo: new SqliteDeferredObligationRepo(database),
    workerRunRepo: new SqliteWorkerRunRepo(database),
    workspaceEngineConfigRepo: new SqliteWorkspaceEngineConfigRepo(database),
    sqliteHandoffGapRepo: new SqliteHandoffGapRepo(database)
  };
}
