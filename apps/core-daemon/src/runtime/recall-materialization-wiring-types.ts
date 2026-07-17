import type {
  BudgetBankruptcyService,
  ClaimService,
  DynamicsService,
  EdgeProposalService,
  EventPublisher,
  EvidenceService,
  GraphExploreService,
  HealthJournalService,
  ManifestationBudgetConfigProviderPort,
  MemoryService,
  ProjectMappingService,
  SessionOverrideService,
  SynthesisService,
  TaskSurfaceBuilder,
  PathFailureHealthInboxPort,
  RecallFailureHealthInboxPort
} from "@do-soul/alaya-core";
import type {
  GlobalMemoryRecallCacheRepo,
  GlobalMemoryRepo,
  SqliteClaimFormRepo,
  SqliteCoUsageCounterRepo,
  SqliteDeferredObligationRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteHandoffGapRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRelationAssertionRepo,
  SqliteProposalRepo,
  SqliteReconciliationLeaseRepo,
  SqliteSignalRepo,
  SqliteSlotRepo,
  SqliteSourceGroundingDeferQueueRepo,
  SqliteSynthesisCapsuleRepo,
  StorageDatabase
} from "@do-soul/alaya-storage";
import type { AppConfigService } from "../services/config-service.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";

export type CreateRecallMaterializationWiringInput = {
  readonly database: StorageDatabase;
  readonly temporalProjectionSelected?: boolean;
  readonly configEnv: ReadonlyMap<string, string>;
  readonly rawConfigService: Pick<AppConfigService, "getRuntimeGardenComputeConfig">;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly healthJournalService: HealthJournalService;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
  readonly relationAssertionRepo: SqliteRelationAssertionRepo;
  readonly manifestationBudgetConfigProvider: ManifestationBudgetConfigProviderPort;
  readonly projectMappingService: ProjectMappingService;
  readonly claimFormRepo: SqliteClaimFormRepo;
  readonly coUsageCounterRepo: SqliteCoUsageCounterRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
  readonly synthesisCapsuleRepo: SqliteSynthesisCapsuleRepo;
  readonly globalMemoryRepo: GlobalMemoryRepo | null;
  readonly globalMemoryRecallCacheRepo: GlobalMemoryRecallCacheRepo | null;
  readonly budgetBankruptcyService: BudgetBankruptcyService;
  readonly budgetNow: () => string;
  readonly slotRepo: SqliteSlotRepo;
  readonly graphExploreService: GraphExploreService;
  readonly sessionOverrideService: SessionOverrideService;
  readonly taskSurfaceBuilder: TaskSurfaceBuilder;
  readonly trustStateRecorder: {
    findDeliveryById(deliveryId: string): Promise<
      | Readonly<{
          readonly delivered_object_ids: readonly string[];
        }>
      | null
    >;
  };
  readonly edgeProposalService: EdgeProposalService;
  readonly dynamicsService: DynamicsService;
	  readonly memoryService: MemoryService;
	  readonly proposalRepo: SqliteProposalRepo;
	  readonly runLookup: {
	    getById(runId: string): Promise<{ readonly workspace_id: string } | null>;
	  };
	  readonly reconciliationLeaseRepo: SqliteReconciliationLeaseRepo;
  readonly deferredObligationRepo: SqliteDeferredObligationRepo;
  readonly claimService: ClaimService;
  readonly synthesisService: SynthesisService;
  readonly enqueueEnrichPending: (params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }) => void;
  readonly sqliteHandoffGapRepo: SqliteHandoffGapRepo;
  readonly signalRepo: SqliteSignalRepo;
  readonly sourceGroundingDeferQueueRepo: SqliteSourceGroundingDeferQueueRepo;
  readonly pathFailureHealthInboxPort: PathFailureHealthInboxPort;
  readonly recallFailureHealthInboxPort: RecallFailureHealthInboxPort;
  readonly evidenceService: EvidenceService;
};
