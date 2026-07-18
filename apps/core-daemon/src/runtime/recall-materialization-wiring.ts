import { isPathActiveForRecall } from "@do-soul/alaya-protocol";
import {
  DeferredObligationService,
  ManifestationResolver,
  PathActivationCandidateProducer,
  RelationAssertionService,
  ResolutionService,
  type GlobalMemoryRecallSubscription,
  type ManifestationResolverEventLogWriterPort,
  type PathActivationCandidateProducerPathReaderPort
} from "@do-soul/alaya-core";
import { SqliteTemporalPathProjectionReader } from "@do-soul/alaya-storage";
import { type GraphEdgeCreationPort } from "@do-soul/alaya-soul";
import { createDaemonEmbeddingRuntime } from "../ai/daemon-embedding-runtime.js";
import { SqliteHandoffGapAdapter } from "../handoff/gap-adapter.js";
import { createRecallReadWorkerClient } from "./recall-read-worker-client.js";
import {
  createRecallPathReadPorts,
  createRecallTemporalProjectionEnsurer
} from "./recall-path-readers.js";
import {
  createGlobalMemoryRecallCachePort,
  createGlobalMemoryRecallPort,
  createGlobalMemoryRouteService
} from "./daemon-runtime-support.js";
import { warnOnRejectedBackgroundTask } from "./daemon-runtime-helpers.js";
import { createEdgeAndReconciliationRuntime } from "./recall-materialization-edge-reconciliation.js";
import { createPathRelationRuntime } from "./recall-materialization-path-relation.js";
import {
  createRecallSearchRuntime,
  createRecallServiceRuntime,
  createRecallUtilizationRuntime
} from "./recall-materialization-recall-runtime.js";
import { createSignalMaterializationRuntime } from "./recall-materialization-router.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";

export async function createRecallMaterializationWiring(input: CreateRecallMaterializationWiringInput) {
  const globalMemoryRuntime = createGlobalMemoryRuntime(input);
  const directPathReadPorts = createDirectRecallPathReadPorts(input);
  const recallReadWorkerClient = createRecallReadWorkerClient({
    databaseFilename: input.database.filename,
    temporalProjectionSelected: input.temporalProjectionSelected === true,
    ...(input.temporalProjectionSelected === true
      ? { prepareTemporalProjection: directPathReadPorts.ensureTemporalProjection }
      : {}),
    warn: input.warn
  });
  const recallReadWorkerReady = recallReadWorkerClient?.ready() ?? Promise.resolve();
  // Startup work intentionally overlaps readiness, so attach rejection handling
  // now and still await the original promise before exposing the runtime.
  void recallReadWorkerReady.catch(() => undefined);

  try {
    const recallReadRuntime = createRecallReadRuntime(
      input,
      globalMemoryRuntime,
      recallReadWorkerClient,
      directPathReadPorts
    );
    const materializationRuntime = await createRecallMaterializationRuntime(
      input,
      recallReadRuntime
    );
    await recallReadWorkerReady;

    return buildRecallMaterializationWiringResult(
      globalMemoryRuntime,
      recallReadRuntime,
      materializationRuntime,
      recallReadWorkerClient
    );
  } catch (error) {
    return await closeRecallReadWorkerAfterStartupFailure({
      recallReadWorkerClient,
      warn: input.warn,
      error
    });
  }
}

function createGlobalMemoryRuntime(input: CreateRecallMaterializationWiringInput) {
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
  return {
    globalMemoryService,
    globalMemoryRecallService,
    globalMemoryRecallInvalidationSubscription
  };
}

function createRecallReadRuntime(
  input: CreateRecallMaterializationWiringInput,
  globalMemoryRuntime: ReturnType<typeof createGlobalMemoryRuntime>,
  recallReadWorkerClient: ReturnType<typeof createRecallReadWorkerClient>,
  directPathReadPorts: ReturnType<typeof createDirectRecallPathReadPorts>
) {
  const embeddingRuntime = createEmbeddingRuntimeWithWarmupObserver(input);
  const recallPathRuntime = createRecallPathRuntime(
    recallReadWorkerClient,
    directPathReadPorts
  );
  const manifestationRuntime = createManifestationRuntime(
    input,
    recallPathRuntime.pathActivationCandidateProducer
  );
  const recallSearchRuntime = createRecallSearchRuntime(
    input,
    recallReadWorkerClient,
    recallPathRuntime.directPathReadPorts
  );
  return {
    embeddingRuntime,
    recallPathRuntime,
    recallUtilizationRuntime: createRecallUtilizationRuntime(input),
    recallServiceRuntime: createRecallServiceRuntime({
      input,
      embeddingRuntime,
      globalMemoryRuntime,
      recallPathRuntime,
      manifestationSidecarPort: manifestationRuntime.manifestationSidecarPort,
      recallSearchRuntime
    })
  };
}

async function createRecallMaterializationRuntime(
  input: CreateRecallMaterializationWiringInput,
  recallReadRuntime: ReturnType<typeof createRecallReadRuntime>
) {
  const pathRelationRuntime = createPathRelationRuntime(input);
  const edgeRuntime = await createEdgeAndReconciliationRuntime(input);
  const materializationRuntime = createSignalMaterializationRuntime({
    wiring: input,
    pathRelationProposalPort: pathRelationRuntime.pathRelationProposalPort,
    temporalRelationAssertionPort: pathRelationRuntime.temporalRelationAssertionPort,
    conflictDetectionService: edgeRuntime.conflictDetectionService,
    reconciliationService: edgeRuntime.reconciliationService,
    handoffGapHandler: new SqliteHandoffGapAdapter(input.sqliteHandoffGapRepo)
  });
  return {
    graphEdgePort: createGraphEdgePort(input),
    edgeRuntime,
    pathRelationRuntime,
    resolutionService: createResolutionService(input),
    materializationRuntime,
    recallReadRuntime
  };
}

function createGraphEdgePort(input: CreateRecallMaterializationWiringInput): GraphEdgeCreationPort {
  return {
    createEdge: async (params) => {
      await input.edgeProposalService.proposeEdge(params);
    }
  };
}

function createResolutionService(input: CreateRecallMaterializationWiringInput) {
  const deferredObligationService = new DeferredObligationService({
    repo: input.deferredObligationRepo,
    eventPublisher: input.eventPublisher
  });
  return new ResolutionService({
    eventPublisher: input.eventPublisher,
    claimRepo: input.claimFormRepo,
    memoryRepo: input.memoryEntryRepo,
    claimService: input.claimService,
    memoryService: input.memoryService,
    deferredObligationService
  });
}

function buildRecallMaterializationWiringResult(
  globalMemoryRuntime: ReturnType<typeof createGlobalMemoryRuntime>,
  recallReadRuntime: ReturnType<typeof createRecallReadRuntime>,
  materializationRuntime: Awaited<ReturnType<typeof createRecallMaterializationRuntime>>,
  recallReadWorkerClient: ReturnType<typeof createRecallReadWorkerClient>
) {
  return {
    globalMemoryService: globalMemoryRuntime.globalMemoryService,
    globalMemoryRecallService: globalMemoryRuntime.globalMemoryRecallService,
    globalMemoryRecallInvalidationSubscription:
      globalMemoryRuntime.globalMemoryRecallInvalidationSubscription,
    embeddingStatusService: recallReadRuntime.embeddingRuntime.embeddingStatusService,
    embeddingProviderWarmup: recallReadRuntime.embeddingRuntime.providerWarmup,
    getEmbeddingProviderDimensions: recallReadRuntime.embeddingRuntime.getProviderDimensions,
    embeddingRecallService: recallReadRuntime.embeddingRuntime.embeddingRecallService,
    embeddingBackfillHandler: recallReadRuntime.embeddingRuntime.embeddingBackfillHandler,
    embeddingDefaultPolicyDecorator: recallReadRuntime.embeddingRuntime.defaultPolicyDecorator,
    recallUtilizationService: recallReadRuntime.recallUtilizationRuntime.recallUtilizationService,
    singleUsedAnchorEmitter: recallReadRuntime.recallUtilizationRuntime.singleUsedAnchorEmitter,
    deliveryAnchorReader: recallReadRuntime.recallUtilizationRuntime.deliveryAnchorReader,
    recallService: recallReadRuntime.recallServiceRuntime.recallService,
    contextLensAssembler: recallReadRuntime.recallServiceRuntime.contextLensAssembler,
    conversationContextLensAssembler:
      recallReadRuntime.recallServiceRuntime.conversationContextLensAssembler,
    graphEdgePort: materializationRuntime.graphEdgePort,
    edgeAutoProducerService: materializationRuntime.edgeRuntime.edgeAutoProducerService,
    conflictDetectionService: materializationRuntime.edgeRuntime.conflictDetectionService,
    reconciliationService: materializationRuntime.edgeRuntime.reconciliationService,
    pathRelationProposalService: materializationRuntime.pathRelationRuntime.pathRelationProposalService,
    resolutionService: materializationRuntime.resolutionService,
    pathRelationEvictionTimer: materializationRuntime.pathRelationRuntime.pathRelationEvictionTimer,
    materializationRouter: materializationRuntime.materializationRuntime.materializationRouter,
    signalService: materializationRuntime.materializationRuntime.signalService,
    edgeClassifyQueueRepoHolder: materializationRuntime.edgeRuntime.edgeClassifyQueueRepoHolder,
    recallReadWorkerClient
  };
}

function createEmbeddingRuntimeWithWarmupObserver(input: CreateRecallMaterializationWiringInput) {
  const embeddingRuntime = createDaemonEmbeddingRuntime({
    database: input.database,
    configEnv: input.configEnv,
    eventLogRepo: input.eventLogRepo,
    healthJournalService: input.healthJournalService,
    memoryEntryRepo: input.memoryEntryRepo,
    warn: input.warn
  });
  void warnOnRejectedBackgroundTask(
    embeddingRuntime.providerWarmup.then((status) => {
      if (status === "ready") {
        input.warn("embedding provider warmup ready", { status });
        return;
      }
      if (status === "failed") {
        input.warn("embedding provider warmup FAILED — bi-default-on is lexical-only", {
          status,
          degraded_reason: "provider_warmup_failed"
        });
      }
    }),
    input.warn,
    "embedding provider warmup observer failed"
  );
  return embeddingRuntime;
}

function createRecallPathRuntime(
  recallReadWorkerClient: ReturnType<typeof createRecallReadWorkerClient>,
  directPathReadPorts: ReturnType<typeof createDirectRecallPathReadPorts>
) {
  const recallPathExpansionPort =
    recallReadWorkerClient?.pathExpansionPort ?? directPathReadPorts.pathExpansionPort;
  const recallPathPlasticityPort =
    recallReadWorkerClient?.pathPlasticityPort ?? directPathReadPorts.pathPlasticityPort;
  const pathActivationReaderPort: PathActivationCandidateProducerPathReaderPort = {
    async findActiveByAnchorObjectIds(workspaceId, memoryObjectIds) {
      if (memoryObjectIds.length === 0) {
        return [];
      }
      const anchors = memoryObjectIds.map((objectId) => ({
        kind: "object" as const,
        object_id: objectId
      }));
      const paths = await recallPathExpansionPort.findByAnchors(workspaceId, anchors);
      return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
    }
  };
  const pathActivationCandidateProducer = new PathActivationCandidateProducer({
    pathReader: pathActivationReaderPort
  });
  return {
    recallPathExpansionPort,
    recallPathPlasticityPort,
    directPathReadPorts,
    pathActivationCandidateProducer
  };
}

function createDirectRecallPathReadPorts(input: CreateRecallMaterializationWiringInput) {
  if (input.temporalProjectionSelected === true) {
    const relationAssertionService = new RelationAssertionService({
      repo: input.relationAssertionRepo,
      eventPublisher: input.eventPublisher,
      eventHistory: input.eventLogRepo
    });
    return createRecallPathReadPorts({
      temporalProjectionSelected: true,
      temporalPathProjectionReader: new SqliteTemporalPathProjectionReader(
        input.relationAssertionRepo
      ),
      ensureTemporalProjection: createRecallTemporalProjectionEnsurer(relationAssertionService)
    });
  }
  return createRecallPathReadPorts({ legacyPathReader: input.pathRelationRepo });
}

function createManifestationRuntime(
  input: CreateRecallMaterializationWiringInput,
  pathActivationCandidateProducer: PathActivationCandidateProducer
) {
  let manifestationResolverInstance: ManifestationResolver | null = null;
  const getManifestationResolver = (): ManifestationResolver => {
    if (manifestationResolverInstance === null) {
      manifestationResolverInstance = new ManifestationResolver({
        budgetConfigProvider: input.manifestationBudgetConfigProvider,
        eventLogWriter: createAtomicManifestationEventLogWriter(input.eventLogRepo)
      });
    }
    return manifestationResolverInstance;
  };
  return {
    manifestationSidecarPort: {
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
    }
  };
}

export function createAtomicManifestationEventLogWriter(
  eventLogRepo: Pick<CreateRecallMaterializationWiringInput["eventLogRepo"], "append" | "transactional">
): ManifestationResolverEventLogWriterPort {
  return {
    appendAtomically: (entries) => eventLogRepo.transactional(() =>
      entries.map((entry) => eventLogRepo.append(entry))
    )
  };
}

async function closeRecallReadWorkerAfterStartupFailure(input: {
  readonly recallReadWorkerClient: Readonly<{ close(): Promise<void> }> | null;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly error: unknown;
}): Promise<never> {
  if (input.recallReadWorkerClient !== null) {
    try {
      await input.recallReadWorkerClient.close();
    } catch (closeError) {
      input.warn("recall read worker startup cleanup failed", {
        error: closeError instanceof Error ? closeError.message : String(closeError)
      });
    }
  }
  throw input.error;
}

export const recallMaterializationWiringTestInternals = Object.freeze({
  closeRecallReadWorkerAfterStartupFailure
});
