import { vi } from "vitest";

type ToolRuntimeWiringHoisted = Record<string, any>;

export async function buildToolRuntimeWiringStorageMocks(params: {
  readonly actual: Record<string, unknown>;
  readonly hoisted: ToolRuntimeWiringHoisted;
}) {
  const { actual, hoisted } = params;
  const makeRepo = (extra: Record<string, unknown> = {}) =>
    vi.fn().mockImplementation(function MockRepo() {
      return extra;
    });

  const gardenBackgroundDataPorts = {
    tieringPort: {},
    evidenceCheckPort: {},
    pointerHealthPort: {},
    greenMaintenancePort: {},
    bootstrappingPort: {},
    mergePort: {},
    neighborPort: {},
    compressionPort: {},
    synthesisPort: {}
  };

  return {
    ...actual,
    initDatabase: vi.fn(() => hoisted.database),
    createGardenBackgroundDataPorts: vi.fn(() => gardenBackgroundDataPorts),
    // anchor: storage owns an independent jieba module-state instance;
    // the daemon AWAITS this warm at startup so the runtime-wiring
    // surface must expose a fast no-op fallback (mirrors the core mock
    // below). see also: packages/storage/src/repos/shared/cjk-segmentation.ts.
    warmCjkSegmentation: hoisted.storageWarmCjkSegmentation,
    SqliteMemoryEmbeddingRepo: undefined,
    SqliteWorkspaceRepo: vi.fn().mockImplementation(function SqliteWorkspaceRepo() {
      return {
        getById: vi.fn(async () => hoisted.workspace),
        list: vi.fn(async () => [])
      };
    }),
    SqliteRunRepo: makeRepo({
      getById: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: hoisted.workspace.workspace_id
      }))
    }),
    SqliteEngineBindingRepo: makeRepo(),
    SqliteEventLogRepo: vi.fn().mockImplementation(function SqliteEventLogRepo() {
      return hoisted.eventLogRepo;
    }),
    SqliteSignalRepo: makeRepo({
      getStorageConnectionIdentity: () => hoisted.database
    }),
    SqliteEdgeProposalRepo: makeRepo(),
    SqliteEvidenceCapsuleRepo: makeRepo(),
    SqliteMemoryEntryRepo: vi.fn().mockImplementation(function SqliteMemoryEntryRepo() {
      return {
        getStorageConnectionIdentity: () => hoisted.database
      };
    }),
    SqliteOrphanRadarRepo: makeRepo(),
    SqliteProjectMappingAnchorRepo: makeRepo(),
    SqliteSynthesisCapsuleRepo: makeRepo(),
    SqliteReconciliationLeaseRepo: makeRepo(),
    SqliteClaimFormRepo: makeRepo({
      findByWorkspaceId: vi.fn(async () => [])
    }),
    SqliteConflictMatrixRepo: makeRepo(),
    SqliteSlotRepo: makeRepo({
      findByWorkspace: vi.fn(async () => [])
    }),
    SqliteSurfaceIdentityRepo: makeRepo(),
    SqliteSurfaceAnchorRepo: makeRepo(),
    SqliteSurfaceBindingRepo: makeRepo(),
    SqliteCrossCuttingPermissionRepo: makeRepo(),
    SqliteProposalRepo: makeRepo(),
    SqliteGreenStatusRepo: makeRepo(),
    SqliteHealthJournalRepo: makeRepo({
      append: vi.fn(async () => undefined),
      findByWorkspace: vi.fn(async () => [])
    }),
    SqliteFileRepo: makeRepo(),
    SqliteKarmaEventRepo: vi.fn().mockImplementation(function SqliteKarmaEventRepo() {
      return {
        getStorageConnectionIdentity: () => hoisted.database
      };
    }),
    SqliteConfigRepo: makeRepo(),
    SqliteHandoffGapRepo: makeRepo({
      findExpiredObjectsByWorkspace: vi.fn(async () => []),
      deleteById: vi.fn(() => undefined)
    }),
    SqliteToolSpecRepo: makeRepo(),
    SqliteToolExecutionRecordRepo: makeRepo(),
    SqliteExtensionDescriptorRepo: makeRepo({
      registerToolProvider: vi.fn(async (provider: unknown) => provider),
      registerSkillPackage: vi.fn(async (pkg: unknown) => pkg),
      findToolProviders: vi.fn(async () => []),
      findToolProviderByToolId: vi.fn(async () => null)
    }),
    SqliteTrustStateRepo: makeRepo({
      createDelivery: vi.fn(async (record: unknown) => record),
      createUsage: vi.fn(async (record: unknown) => record),
      findDeliveryById: vi.fn(async () => null),
      listDeliveriesByAgentTarget: vi.fn(async () => []),
      listUsageByDeliveryIds: vi.fn(async () => [])
    }),
    SqliteStrongRefRepo: makeRepo(),
    SqlitePathRelationRepo: makeRepo({
      findActive: vi.fn(async () => []),
      findByAnchors: vi.fn(async () => []),
      findByWorkspace: vi.fn(async () => [])
    }),
    SqliteBootstrappingRecordRepo: makeRepo({
      create: vi.fn(async (record: unknown) => record),
      findByWorkspace: vi.fn(async () => null)
    }),
    SqlitePathGraphSnapshotRepo: makeRepo({
      findLatest: vi.fn(async () => null),
      create: vi.fn(async (snapshot: unknown) => snapshot),
      findHistory: vi.fn(async () => []),
      deleteOlderThan: vi.fn(async () => 0)
    }),
    SqlitePathPlasticityWatermarkRepo: makeRepo({
      findByWorkspaceId: vi.fn(() => null),
      upsert: vi.fn((record: unknown) => record)
    }),
    SqliteDriftLeaseRepo: makeRepo({
      create: vi.fn(async (lease: unknown) => lease),
      findActive: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      deleteExpired: vi.fn(async () => 0)
    }),
    SqliteDeferredObligationRepo: makeRepo(),
    SqliteDirtyStateDossierRepo: makeRepo(),
    SqliteWorkerRunRepo: makeRepo()
  };
}
