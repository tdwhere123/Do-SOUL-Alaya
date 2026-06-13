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
  SqlitePathGraphSnapshotRepo,
  SqlitePathPlasticityWatermarkRepo,
  SqlitePathRelationRepo,
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
  const workspaceRepo = new SqliteWorkspaceRepo(input.database);
  const runRepo = new SqliteRunRepo(input.database);
  const bindingRepo = new SqliteEngineBindingRepo(input.database);
  const bootstrappingRecordRepo = new SqliteBootstrappingRecordRepo(input.database);
  const configRepo = new SqliteConfigRepo(input.database);
  const eventLogRepo = new SqliteEventLogRepo(input.database);
  const reconciliationLeaseRepo = new SqliteReconciliationLeaseRepo(input.database);
  const signalRepo = new SqliteSignalRepo(input.database);
  const edgeProposalRepo = new SqliteEdgeProposalRepo(input.database);
  const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(input.database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(input.database, (message, meta) =>
    input.warn(message, meta)
  );
  const globalMemoryRepo = createOptionalGlobalMemoryRepo(input.database);
  const globalMemoryRecallCacheRepo = createOptionalGlobalMemoryRecallCacheRepo(input.database);
  const orphanDetectionEnabled = process.env.ORPHAN_DETECTION_ENABLED !== "false";
  const orphanRadarRepo = orphanDetectionEnabled ? new SqliteOrphanRadarRepo(input.database) : null;
  const projectMappingAnchorRepo = new SqliteProjectMappingAnchorRepo(input.database);
  const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(input.database);
  const claimFormRepo = new SqliteClaimFormRepo(input.database);
  const conflictMatrixRepo = new SqliteConflictMatrixRepo(input.database);
  const slotRepo = new SqliteSlotRepo(input.database);
  const surfaceIdentityRepo = new SqliteSurfaceIdentityRepo(input.database);
  const surfaceAnchorRepo = new SqliteSurfaceAnchorRepo(input.database);
  const surfaceBindingRepo = new SqliteSurfaceBindingRepo(input.database);
  const crossCuttingPermissionRepo = new SqliteCrossCuttingPermissionRepo(input.database);
  const proposalRepo = new SqliteProposalRepo(input.database);
  const greenStatusRepo = new SqliteGreenStatusRepo(input.database);
  const healthJournalRepo = new SqliteHealthJournalRepo(input.database);
  const fileRepo = new SqliteFileRepo(input.database);
  const karmaEventRepo = new SqliteKarmaEventRepo(input.database);
  const toolSpecRepo = new SqliteToolSpecRepo(input.database);
  const toolExecutionRecordRepo = new SqliteToolExecutionRecordRepo(input.database);
  const extensionDescriptorRepo = new SqliteExtensionDescriptorRepo(input.database);
  const trustStateRepo = new SqliteTrustStateRepo(input.database);
  const strongRefRepo = new SqliteStrongRefRepo(input.database);
  const pathRelationRepo = new SqlitePathRelationRepo(input.database);
  const coUsageCounterRepo = new SqliteCoUsageCounterRepo(input.database);
  const enrichPendingRepo = new SqliteEnrichPendingRepo(input.database);
  const enqueueEnrichPending = (params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void =>
    enrichPendingRepo.enqueue({
      workspaceId: params.workspaceId,
      memoryId: params.memoryId,
      runId: params.runId,
      sourceSignalId: params.sourceSignalId,
      enqueuedAt: new Date().toISOString()
    });
  const pathPlasticityWatermarkRepo = new SqlitePathPlasticityWatermarkRepo(input.database);
  const pathGraphSnapshotRepo = new SqlitePathGraphSnapshotRepo(input.database);
  const deferredObligationRepo = new SqliteDeferredObligationRepo(input.database);
  const workerRunRepo = new SqliteWorkerRunRepo(input.database);
  const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(input.database);
  const sqliteHandoffGapRepo = new SqliteHandoffGapRepo(input.database);

  return Object.freeze({
    workspaceRepo,
    runRepo,
    bindingRepo,
    bootstrappingRecordRepo,
    configRepo,
    eventLogRepo,
    reconciliationLeaseRepo,
    signalRepo,
    edgeProposalRepo,
    evidenceCapsuleRepo,
    memoryEntryRepo,
    globalMemoryRepo,
    globalMemoryRecallCacheRepo,
    orphanDetectionEnabled,
    orphanRadarRepo,
    projectMappingAnchorRepo,
    synthesisCapsuleRepo,
    claimFormRepo,
    conflictMatrixRepo,
    slotRepo,
    surfaceIdentityRepo,
    surfaceAnchorRepo,
    surfaceBindingRepo,
    crossCuttingPermissionRepo,
    proposalRepo,
    greenStatusRepo,
    healthJournalRepo,
    fileRepo,
    karmaEventRepo,
    toolSpecRepo,
    toolExecutionRecordRepo,
    extensionDescriptorRepo,
    trustStateRepo,
    strongRefRepo,
    pathRelationRepo,
    coUsageCounterRepo,
    enrichPendingRepo,
    enqueueEnrichPending,
    pathPlasticityWatermarkRepo,
    pathGraphSnapshotRepo,
    deferredObligationRepo,
    workerRunRepo,
    workspaceEngineConfigRepo,
    sqliteHandoffGapRepo
  });
}
