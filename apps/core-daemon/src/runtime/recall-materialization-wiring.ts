import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  type EventLogEntry,
  MemoryGovernanceEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RecallContextEventType,
  RetentionPolicy,
  SoulActiveConstraintSchema,
  SoulProposalCreatedPayloadSchema,
  isPathActiveForRecall,
  type CandidateMemorySignal,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  BudgetBankruptcyService,
  ClaimService,
  ConflictDetectionService,
  ContextLensAssembler,
  DeferredObligationService,
  DynamicsService,
  EdgeAutoProducerService,
  EdgeProposalService,
  EvidenceService,
  EventPublisher,
  GraphExploreService,
  HealthJournalService,
  ManifestationResolver,
  type ManifestationBudgetConfigProviderPort,
  MemoryService,
  PathActivationCandidateProducer,
  type PathActivationCandidateProducerPathReaderPort,
  PathRelationProposalService,
  PATH_RELATION_COUNTER_DEFAULT_TTL_MS,
  ProjectMappingService,
  RecallService,
  ReconciliationService,
  ResolutionService,
  RuleBasedEntityExtractor,
  SessionOverrideService,
  SignalService,
  SynthesisService,
  TaskSurfaceBuilder,
  createRuleOnlyReconciliationDecisionPort,
  type GlobalMemoryRecallSubscription,
  type PathCandidateSink,
  type PathFailureHealthInboxPort
} from "@do-soul/alaya-core";
import {
  findActiveConstraints,
  type SqliteClaimFormRepo,
  type SqliteCoUsageCounterRepo,
  type SqliteDeferredObligationRepo,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRepo,
  type SqliteEventLogRepo,
  type SqliteEvidenceCapsuleRepo,
  type SqliteGardenTaskRepo,
  type SqliteHandoffGapRepo,
  type SqliteMemoryEntryRepo,
  type SqliteProposalRepo,
  type SqliteReconciliationLeaseRepo,
  type SqliteSignalRepo,
  type SqliteSlotRepo,
  type SqliteSynthesisCapsuleRepo,
  type SqlitePathRelationRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  DegradationPipeline,
  MaterializationRouter,
  OFFICIAL_API_GARDEN_MODEL,
  type GraphEdgeCreationPort,
  type PathRelationProposalPayload
} from "@do-soul/alaya-soul";
import { createDaemonEmbeddingRuntime } from "../ai/daemon-embedding-runtime.js";
import { createEdgeAutoProducerLlmPort } from "../ai/edge-auto-producer-llm-adapter.js";
import { createReconciliationLlmDecisionPort } from "../ai/reconciliation-llm-decision.js";
import { createEdgeClassifyQueueAdapter } from "../garden/edge-classify-queue-adapter.js";
import { createRecallPathPlasticityPort } from "../garden/path-plasticity-runtime.js";
import { SqliteHandoffGapAdapter } from "../handoff/gap-adapter.js";
import { createManifestationContextLensAssembler } from "../manifestation/context-lens-assembler.js";
import {
  buildSingleUsedAnchorPayload,
  type SingleUsedAnchorTelemetryEmitter
} from "../routes/recall-utilization.js";
import { createRecallUtilizationService } from "../services/recall-utilization-service.js";
import {
  canResolveOfficialGardenProvider,
  createConflictDetectionLlmPort,
  normalizeRecallTimeConcernWindowDigest,
  resolveGardenSecretRefValue
} from "./garden-compute-support.js";
import {
  createGlobalMemoryRecallCachePort,
  createGlobalMemoryRecallPort,
  createGlobalMemoryRouteService,
  resolveEdgeClassifyWiring
} from "./daemon-runtime-support.js";
import type { AppConfigService } from "../services/config-service.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";

export async function createRecallMaterializationWiring(input: {
  readonly database: StorageDatabase;
  readonly configEnv: ReadonlyMap<string, string>;
  readonly rawConfigService: Pick<AppConfigService, "getRuntimeGardenComputeConfig">;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly healthJournalService: HealthJournalService;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
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
  readonly pathFailureHealthInboxPort: PathFailureHealthInboxPort;
  readonly evidenceService: EvidenceService;
}) {
  const globalMemoryService =
    input.globalMemoryRepo === null
      ? undefined
      : createGlobalMemoryRouteService({
          globalMemoryRepo: input.globalMemoryRepo,
          projectMappingService: input.projectMappingService
        });
  const globalMemoryRecallService =
    input.globalMemoryRepo === null
      ? undefined
      : createGlobalMemoryRecallPort({
          globalMemoryRepo: input.globalMemoryRepo
        });
  const globalMemoryRecallInvalidationSubscription: GlobalMemoryRecallSubscription | null =
    globalMemoryRecallService?.subscribeToInvalidations(input.runtimeNotifier) ?? null;

  const {
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler,
    defaultPolicyDecorator: embeddingDefaultPolicyDecorator,
    providerWarmup: embeddingProviderWarmup
  } = createDaemonEmbeddingRuntime({
    database: input.database,
    configEnv: input.configEnv,
    eventLogRepo: input.eventLogRepo,
    healthJournalService: input.healthJournalService,
    memoryEntryRepo: input.memoryEntryRepo,
    warn: input.warn
  });
  embeddingProviderWarmup
    .then((status) => {
      if (status === "ready") {
        input.warn("embedding provider warmup ready", { status });
      }
    })
    .catch(() => undefined);

  const recallPathPlasticityPort = createRecallPathPlasticityPort({
    pathRelationRepo: input.pathRelationRepo
  });
  const pathActivationReaderPort: PathActivationCandidateProducerPathReaderPort = {
    async findActiveByAnchorObjectIds(workspaceId, memoryObjectIds) {
      if (memoryObjectIds.length === 0) {
        return [];
      }
      const anchors = memoryObjectIds.map((objectId) => ({
        kind: "object" as const,
        object_id: objectId
      }));
      const paths = await input.pathRelationRepo.findByAnchors(workspaceId, anchors);
      return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
    }
  };
  const pathActivationCandidateProducer = new PathActivationCandidateProducer({
    pathReader: pathActivationReaderPort
  });
  let manifestationResolverInstance: ManifestationResolver | null = null;
  const getManifestationResolver = (): ManifestationResolver => {
    if (manifestationResolverInstance === null) {
      manifestationResolverInstance = new ManifestationResolver({
        budgetConfigProvider: input.manifestationBudgetConfigProvider,
        eventLogWriter: {
          append: async (entry) => input.eventLogRepo.append(entry)
        }
      });
    }
    return manifestationResolverInstance;
  };
  const manifestationSidecarPort = {
    buildBiasSidecar: async (params: Readonly<{
      readonly workspaceId: string;
      readonly runId: string;
      readonly anchorMemoryObjectIds: readonly string[];
      readonly taskSurfaceRef: Parameters<ManifestationResolver["resolveWithBias"]>[0]["taskSurfaceRef"];
    }>) => {
      const candidates = await pathActivationCandidateProducer.produce({
        workspaceId: params.workspaceId,
        runId: params.runId,
        anchorMemoryObjectIds: params.anchorMemoryObjectIds
      });
      if (candidates.length === 0) {
        return [];
      }
      const result = await getManifestationResolver().resolveWithBias({
        workspaceId: params.workspaceId,
        runId: params.runId,
        candidates,
        taskSurfaceRef: params.taskSurfaceRef
      });
      return result.biasSidecar;
    }
  };
  const recallUtilizationService = createRecallUtilizationService({
    eventLogRepo: input.eventLogRepo
  });
  const singleUsedAnchorEmitter: SingleUsedAnchorTelemetryEmitter = {
    async emit(emitInput) {
      const event = {
        event_type: RecallContextEventType.SOUL_SINGLE_USED_ANCHOR,
        entity_type: "context_delivery",
        entity_id: emitInput.deliveryId,
        workspace_id: emitInput.workspaceId,
        run_id: emitInput.runId,
        caused_by: emitInput.agentTarget,
        payload_json: buildSingleUsedAnchorPayload({
          deliveryId: emitInput.deliveryId,
          sessionId: emitInput.sessionId,
          runId: emitInput.runId,
          agentTarget: emitInput.agentTarget,
          workspaceId: emitInput.workspaceId,
          occurredAt: emitInput.occurredAt,
          usedAnchorObjectId: emitInput.usedAnchorObjectId
        })
      } as const;
      try {
        await input.eventPublisher.appendManyWithMutation([event], () => undefined);
      } catch (error) {
        input.warn("single used-anchor telemetry emission failed", {
          deliveryId: emitInput.deliveryId,
          usedAnchorObjectId: emitInput.usedAnchorObjectId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
  const deliveryAnchorReader = {
    async findDeliveredObjectIds(deliveryId: string): Promise<readonly string[] | null> {
      const delivery = await input.trustStateRecorder.findDeliveryById(deliveryId);
      return delivery === null ? null : delivery.delivered_object_ids;
    }
  };
  const recallPathExpansionPort = {
    findByAnchors: input.pathRelationRepo.findByAnchors.bind(input.pathRelationRepo),
    findByTimeConcernWindowDigests: async (
      workspaceId: string,
      windowDigests: readonly string[]
    ) => {
      const normalized = new Set(windowDigests.map(normalizeRecallTimeConcernWindowDigest));
      const paths = await input.pathRelationRepo.findByWorkspace(workspaceId);
      return paths.filter((path) =>
        isPathActiveForRecall(path.lifecycle.status) &&
        [path.anchors.source_anchor, path.anchors.target_anchor].some((anchor) =>
          anchor.kind === "time_concern" &&
          normalized.has(normalizeRecallTimeConcernWindowDigest(anchor.window_digest))
        )
      );
    }
  };
  const recallActiveConstraintsPort = {
    findActiveConstraints: async (
      activeConstraintsInput: Readonly<{ readonly workspaceId: string; readonly cap?: number | null }>
    ) => {
      const result = await findActiveConstraints({
        workspaceId: activeConstraintsInput.workspaceId,
        memoryRepo: input.memoryEntryRepo,
        claimFormRepo: input.claimFormRepo,
        pathRelationRepo: input.pathRelationRepo,
        cap: activeConstraintsInput.cap
      });
      return Object.freeze({
        constraints: Object.freeze(
          result.constraints.map((record) =>
            SoulActiveConstraintSchema.parse({
              object_id: record.memory.object_id,
              object_kind: record.memory.object_kind,
              content: record.memory.content,
              dimension: record.memory.dimension,
              scope_class: record.memory.scope_class,
              governance_state: {
                claim_status: record.claim_status,
                governance_class: record.governance_class,
                source_channels: record.source_channels
              }
            })
          )
        ),
        total_count: result.total_count
      });
    }
  };
  const recallService = new RecallService({
    memoryRepo: input.memoryEntryRepo,
    slotRepo: input.slotRepo,
    eventLogRepo: input.eventLogRepo,
    graphSupportPort: input.graphExploreService,
    projectMappingPort: input.projectMappingService,
    pathPlasticityPort: recallPathPlasticityPort,
    pathExpansionPort: recallPathExpansionPort,
    activeConstraintsPort: recallActiveConstraintsPort,
    evidenceSearchPort: {
      searchByKeyword: async (workspaceId, queryText, limit) =>
        input.evidenceCapsuleRepo.searchByKeyword === undefined
          ? []
          : await input.evidenceCapsuleRepo.searchByKeyword(workspaceId, queryText, limit),
      findByIds: async (workspaceId, evidenceObjectIds) => {
        const results = await input.evidenceCapsuleRepo.findByIds(evidenceObjectIds);
        return results.filter((evidence) => evidence.workspace_id === workspaceId);
      }
    },
    synthesisSearchPort: {
      searchByKeyword: async (workspaceId, queryText, limit) =>
        input.synthesisCapsuleRepo.searchByKeyword === undefined
          ? []
          : await input.synthesisCapsuleRepo.searchByKeyword(workspaceId, queryText, limit),
      findByIds: async (objectIds) => {
        const scoped = [];
        for (const objectId of objectIds) {
          const synthesis = await input.synthesisCapsuleRepo.findById(objectId);
          if (synthesis !== null) {
            scoped.push(synthesis);
          }
        }
        return scoped;
      }
    },
    ...(input.globalMemoryRepo === null
      ? {}
      : {
          globalRecallPort: globalMemoryRecallService,
          ...(input.globalMemoryRecallCacheRepo === null
            ? {}
            : {
                globalRecallCachePort: createGlobalMemoryRecallCachePort({
                  globalMemoryRecallCacheRepo: input.globalMemoryRecallCacheRepo,
                  now: () => new Date().toISOString()
                })
              })
        }),
    budgetPenaltyPort: {
      getSnapshot: async (runId: string) =>
        await input.budgetBankruptcyService.getSnapshot(runId, input.budgetNow())
    },
    claimResolverPort: input.claimFormRepo,
    embeddingRecallService,
    manifestationSidecarPort,
    ...(embeddingDefaultPolicyDecorator === undefined
      ? {}
      : { defaultPolicyDecorator: embeddingDefaultPolicyDecorator }),
    entityExtractionPort: new RuleBasedEntityExtractor(),
    warn: input.warn
  });
  const contextLensAssembler = new ContextLensAssembler({
    recallService,
    taskSurfaceBuilder: input.taskSurfaceBuilder,
    slotRepo: input.slotRepo,
    claimRepo: input.claimFormRepo,
    memoryRepo: input.memoryEntryRepo,
    eventLogRepo: input.eventLogRepo,
    overrideService: input.sessionOverrideService,
    degradationPipeline: new DegradationPipeline(),
    bankruptcyService: input.budgetBankruptcyService,
    warn: input.warn
  });
  const conversationContextLensAssembler = createManifestationContextLensAssembler({
    delegate: contextLensAssembler
  });
  const sqliteHandoffGapAdapter = new SqliteHandoffGapAdapter(input.sqliteHandoffGapRepo);
  const graphEdgePort = {
    createEdge: async (params: Parameters<GraphEdgeCreationPort["createEdge"]>[0]) => {
      await input.edgeProposalService.proposeEdge(params);
    }
  } satisfies GraphEdgeCreationPort;
  const pathCandidatePort: PathCandidateSink = {
    submitCandidate: async (candidateInput) =>
      await pathRelationProposalService.submitCandidate(candidateInput)
  };
  const sharedGardenComputeConfig = await input.rawConfigService.getRuntimeGardenComputeConfig();
  const edgeClassifyWiring = resolveEdgeClassifyWiring(process.env, sharedGardenComputeConfig);
  const edgeAutoProducerLlmEnabled = edgeClassifyWiring.llmEnabled;
  const edgeAutoProducerGardenComputeConfig = edgeAutoProducerLlmEnabled
    ? sharedGardenComputeConfig
    : null;
  const edgeAutoProducerOfficialConfig =
    edgeAutoProducerGardenComputeConfig !== null &&
    canResolveOfficialGardenProvider(edgeAutoProducerGardenComputeConfig)
      ? edgeAutoProducerGardenComputeConfig
      : null;
  const edgeAutoProducerGardenApiKey = ((): string | null => {
    if (edgeAutoProducerOfficialConfig === null) {
      return null;
    }
    const secretRef = edgeAutoProducerOfficialConfig.secret_ref;
    if (secretRef === null) {
      return null;
    }
    try {
      return resolveGardenSecretRefValue(secretRef);
    } catch {
      return null;
    }
  })();
  const edgeAutoProducerProviderUrl =
    edgeAutoProducerGardenComputeConfig?.provider_url ?? null;
  const edgeAutoProducerLlmPort =
    edgeAutoProducerLlmEnabled &&
    edgeAutoProducerGardenApiKey !== null &&
    edgeAutoProducerProviderUrl !== null
      ? createEdgeAutoProducerLlmPort({
          config: {
            providerUrl: edgeAutoProducerProviderUrl,
            model:
              edgeAutoProducerGardenComputeConfig?.model_id ?? OFFICIAL_API_GARDEN_MODEL,
            apiKey: edgeAutoProducerGardenApiKey
          }
        })
      : null;
  const edgeClassifyQueueRepoHolder: {
    current:
      | {
          enqueue: SqliteGardenTaskRepo["enqueue"];
          findById(taskId: string): { readonly id: string } | null;
        }
      | undefined;
  } = { current: undefined };
  const edgeClassifyQueue = edgeClassifyWiring.hostWorkerEnabled
    ? createEdgeClassifyQueueAdapter({
        gardenTaskRepo: {
          enqueue: (enqueueInput) => {
            if (edgeClassifyQueueRepoHolder.current === undefined) {
              throw new Error("EDGE_CLASSIFY queue used before the garden task repo was wired.");
            }
            return edgeClassifyQueueRepoHolder.current.enqueue(enqueueInput);
          },
          findById: (taskId) => edgeClassifyQueueRepoHolder.current?.findById(taskId) ?? null
        },
        now: () => new Date().toISOString(),
        warn: input.warn
      })
    : null;
  const edgeAutoProducerService = new EdgeAutoProducerService({
    memoryRepo: input.memoryEntryRepo,
    pathCandidatePort,
    existingPathReader: {
      findByBackingObjectId: (workspaceId, objectId) =>
        input.pathRelationRepo.findByBackingObjectId(workspaceId, objectId)
    },
    ...(edgeClassifyQueue !== null
      ? { edgeClassifyQueue }
      : edgeAutoProducerLlmPort === null
        ? {}
        : { llmPort: edgeAutoProducerLlmPort }),
    warn: input.warn
  });
  const conflictDetectionEnabled = (() => {
    const raw = process.env.ALAYA_CONFLICT_DETECTION_ENABLED?.toLowerCase();
    if (raw === undefined || raw === "") {
      return true;
    }
    return raw !== "0" && raw !== "false";
  })();
  const conflictDetectionLlmPort = conflictDetectionEnabled
    ? createConflictDetectionLlmPort()
    : null;
  const conflictDetectionRuleEnabled = (() => {
    const raw = process.env.ALAYA_CONFLICT_RULE_ENABLED?.toLowerCase();
    if (raw === undefined || raw === "") {
      return true;
    }
    return raw !== "0" && raw !== "false";
  })();
  const conflictDetectionService = conflictDetectionEnabled
    ? new (await import("@do-soul/alaya-core")).ConflictDetectionService({
        memoryRepo: {
          findByDimension: async (workspaceId, dimension) =>
            await input.memoryEntryRepo.findByDimension(workspaceId, dimension),
          findBySharedDomainTags: async (workspaceId, tags) =>
            await input.memoryEntryRepo.findBySharedDomainTags(workspaceId, tags)
        },
        pathCandidatePort,
        ...(conflictDetectionLlmPort === null ? {} : { llmPort: conflictDetectionLlmPort }),
        karmaEmitter: {
          emitKarmaEvent: (emitInput) => input.dynamicsService.emitKarmaEvent(emitInput)
        },
        ruleEnabled: conflictDetectionRuleEnabled,
        warn: input.warn
      })
    : null;
  const ingestReconciliationEnabled = (() => {
    const raw = process.env.ALAYA_INGEST_RECONCILIATION_ENABLED?.trim().toLowerCase();
    return raw !== "0" && raw !== "false";
  })();
  const reconciliationGardenComputeConfig =
    ingestReconciliationEnabled
      ? await input.rawConfigService.getRuntimeGardenComputeConfig()
      : null;
  const reconciliationOfficialConfig =
    reconciliationGardenComputeConfig !== null &&
    canResolveOfficialGardenProvider(reconciliationGardenComputeConfig)
      ? reconciliationGardenComputeConfig
      : null;
  const reconciliationGardenApiKey = ((): string | null => {
    if (reconciliationOfficialConfig === null) {
      return null;
    }
    const secretRef = reconciliationOfficialConfig.secret_ref;
    if (secretRef === null) {
      return null;
    }
    try {
      return resolveGardenSecretRefValue(secretRef);
    } catch {
      return null;
    }
  })();
  const reconciliationProviderUrl = reconciliationGardenComputeConfig?.provider_url ?? null;
  const reconciliationLlmDecisionPort =
    ingestReconciliationEnabled &&
    reconciliationGardenApiKey !== null &&
    reconciliationProviderUrl !== null
      ? createReconciliationLlmDecisionPort({
          config: {
            providerUrl: reconciliationProviderUrl,
            model: reconciliationGardenComputeConfig?.model_id ?? OFFICIAL_API_GARDEN_MODEL,
            apiKey: reconciliationGardenApiKey
          }
        })
      : null;
  const reconciliationService = ingestReconciliationEnabled
    ? new ReconciliationService({
        keywordSearch: {
          searchByKeyword: async (workspaceId, queryText, limit) =>
            await input.memoryEntryRepo.searchByKeyword(workspaceId, queryText, limit)
        },
        memoryRepo: {
          findByIds: async (objectIds) => await input.memoryEntryRepo.findByIds(objectIds)
        },
        memoryUpdate: {
          update: async (objectId, fields, reason) =>
            await input.memoryService.update(objectId, fields, reason)
        },
        eventLog: {
          append: (event) => input.eventLogRepo.append(event)
        },
        llmDecision:
          reconciliationLlmDecisionPort ?? createRuleOnlyReconciliationDecisionPort(),
        lease: input.reconciliationLeaseRepo,
        warn: input.warn
      })
    : null;
  const pathRelationCounterTtlMs = (() => {
    const raw = process.env.ALAYA_PATHREL_COUNTER_TTL_MS;
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  })();
  const pathRelationCoUsageThreshold = (() => {
    const raw = process.env.ALAYA_PATHREL_CO_USAGE_THRESHOLD;
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
  })();
  const pathRelationProposalService = new PathRelationProposalService({
    repo: {
      create: (relation) => input.pathRelationRepo.create(relation),
      findByAnchorMemoryId: async (memoryId, workspaceId) =>
        await input.pathRelationRepo.findByBackingObjectId(workspaceId, memoryId)
    },
    counterStore: input.coUsageCounterRepo,
    memoryExistence: {
      workspaceOfObject: async (objectId) => {
        const entry = await input.memoryEntryRepo.findById(objectId);
        return entry === null ? null : entry.workspace_id;
      }
    },
    eventPublisher: input.eventPublisher,
    healthInboxPort: {
      recordPathRelationFailure: (entry) =>
        input.pathFailureHealthInboxPort.recordPathRelationFailure(entry)
    },
    ...(pathRelationCounterTtlMs === undefined ? {} : { counterTtlMs: pathRelationCounterTtlMs }),
    ...(pathRelationCoUsageThreshold === undefined ? {} : { threshold: pathRelationCoUsageThreshold }),
    warn: input.warn
  });
  const deferredObligationService = new DeferredObligationService({
    repo: input.deferredObligationRepo,
    eventPublisher: input.eventPublisher
  });
  const resolutionService = new ResolutionService({
    eventPublisher: input.eventPublisher,
    claimRepo: input.claimFormRepo,
    memoryRepo: input.memoryEntryRepo,
    claimService: input.claimService,
    memoryService: input.memoryService,
    deferredObligationService
  });
  const pathRelationEvictionIntervalMs = pathRelationCounterTtlMs ?? PATH_RELATION_COUNTER_DEFAULT_TTL_MS;
  const pathRelationEvictionTimer = setInterval(() => {
    void pathRelationProposalService.evictExpired().catch((error: unknown) => {
      input.warn("PathRelation counter eviction failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, pathRelationEvictionIntervalMs);
  pathRelationEvictionTimer.unref?.();
  const pathRelationProposalPort = {
    assertPathRelationProposalAvailable: async (proposalInput: { readonly workspaceId: string }) => {
      await input.proposalRepo.countPending(proposalInput.workspaceId);
    },
    createPathRelationProposal: async (proposalInput: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly targetObjectId: string;
      readonly reason: string;
      readonly sourceSignalId: string;
      readonly proposedPathRelation: PathRelationProposalPayload;
    }) => {
      const timestamp = new Date().toISOString();
      const proposalId = randomUUID();
      const proposal = ProposalSchema.parse({
        runtime_id: proposalId,
        object_kind: ControlPlaneObjectKind.PROPOSAL,
        task_surface_ref: null,
        expires_at: null,
        derived_from: proposalInput.targetObjectId,
        retention_policy: RetentionPolicy.SESSION_ONLY,
        proposal_id: proposalId,
        dossier_ref: null,
        recommended_option_id: null,
        proposal_options: [
          {
            option_id: `path_relation_${proposalId}`,
            option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
            preserves_protected_constraints: true,
            dropped_candidates: [],
            unresolved_after_apply: [],
            requires_confirmation: true
          }
        ],
        resolution_state: ProposalResolutionState.PENDING,
        last_updated_at: timestamp
      });
      const created = await input.proposalRepo.createProposalWithEvents(
        {
          proposal,
          workspace_id: proposalInput.workspaceId,
          run_id: proposalInput.runId,
          target_object_kind: "path_relation",
          proposed_change_summary: `${proposalInput.reason} Source signal: ${proposalInput.sourceSignalId}.`,
          proposed_path_relation: proposalInput.proposedPathRelation,
          created_at: timestamp
        },
        [
          {
            event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
            entity_type: "proposal",
            entity_id: proposal.proposal_id,
            workspace_id: proposalInput.workspaceId,
            run_id: proposalInput.runId,
            caused_by: "garden",
            payload_json: SoulProposalCreatedPayloadSchema.parse({
              object_id: proposal.runtime_id,
              object_kind: proposal.object_kind,
              workspace_id: proposalInput.workspaceId,
              run_id: proposalInput.runId
            })
          }
        ]
      );
      for (const event of created.events) {
        await input.runtimeNotifier.notifyEntry(event);
      }
      return {
        object_kind: "proposal",
        object_id: created.proposal.proposal_id
      };
    }
  } satisfies {
    assertPathRelationProposalAvailable(input: { readonly workspaceId: string }): Promise<void>;
    createPathRelationProposal(input: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly targetObjectId: string;
      readonly reason: string;
      readonly sourceSignalId: string;
      readonly proposedPathRelation: PathRelationProposalPayload;
    }): Promise<Readonly<{ readonly object_kind: string; readonly object_id: string }>>;
  };
  const enrichPendingPort = { enqueue: input.enqueueEnrichPending };
  const materializationMemoryService = {
    create: async (createInput: Parameters<typeof input.memoryService.create>[0]) => {
      const created = await input.memoryService.create(createInput);
      return {
        object_kind: created.object_kind,
        object_id: created.object_id,
        enrichmentEnqueued: (createInput as { enqueueEnrichment?: unknown }).enqueueEnrichment !== undefined
      };
    }
  };
  // Production ingest config: keep high-confidence facts whose open-vocabulary
  // object_kind falls outside routeByObjectKind as recallable memory_entries
  // (rather than dropping them to evidence_only). The bench daemon shares this
  // construction, so the benchmark exercises whatever production is configured
  // to do. Default-ON (operator decision 2026-06-12): real proposers emit open
  // vocabulary, and dropping those facts made the memory plane forget ~99.9%
  // of them. Set ALAYA_RETAIN_UNROUTED_FACTS=0 to restore curated-only routing.
  const retainUnroutedHighConfidenceFacts =
    process.env.ALAYA_RETAIN_UNROUTED_FACTS !== "0" &&
    process.env.ALAYA_RETAIN_UNROUTED_FACTS !== "false";
  // Optional override for the materialization confidence floor (default 0.5).
  const materializationConfidenceFloorRaw = Number(
    process.env.ALAYA_MATERIALIZATION_CONF_FLOOR
  );
  const materializationConfidenceFloor =
    Number.isFinite(materializationConfidenceFloorRaw) &&
    materializationConfidenceFloorRaw >= 0 &&
    materializationConfidenceFloorRaw <= 1
      ? materializationConfidenceFloorRaw
      : undefined;
  const materializationRouter = new MaterializationRouter({
    evidenceService: input.evidenceService,
    memoryService: materializationMemoryService,
    synthesisService: input.synthesisService,
    claimService: input.claimService,
    pathRelationProposalPort,
    pathCandidateSinkPort: {
      submitCandidate: async (candidateInput) =>
        await pathRelationProposalService.submitCandidate(candidateInput)
    },
    enrichPendingPort,
    ...(conflictDetectionService === null
      ? {}
      : { conflictDetectionPort: conflictDetectionService }),
    ...(reconciliationService === null
      ? {}
      : { reconciliationPort: reconciliationService }),
    handoffGapHandler: sqliteHandoffGapAdapter,
    retainUnroutedHighConfidenceFacts,
    ...(materializationConfidenceFloor === undefined
      ? {}
      : { materializationConfidenceFloor })
  });
  const signalService = new SignalService({
    eventLogRepo: input.eventLogRepo,
    signalRepo: input.signalRepo,
    runtimeNotifier: input.runtimeNotifier,
    postTriageMaterializer: {
      materialize: async (signal: CandidateMemorySignal) =>
        await materializationRouter.materializeSignal(signal)
    }
  });

  return {
    globalMemoryService,
    globalMemoryRecallService,
    globalMemoryRecallInvalidationSubscription,
    embeddingStatusService,
    embeddingRecallService,
    embeddingBackfillHandler,
    embeddingDefaultPolicyDecorator,
    recallUtilizationService,
    singleUsedAnchorEmitter,
    deliveryAnchorReader,
    recallService,
    contextLensAssembler,
    conversationContextLensAssembler,
    graphEdgePort,
    edgeAutoProducerService,
    conflictDetectionService,
    reconciliationService,
    pathRelationProposalService,
    resolutionService,
    pathRelationEvictionTimer,
    materializationRouter,
    signalService,
    edgeClassifyQueueRepoHolder
  };
}
