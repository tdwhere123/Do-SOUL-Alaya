import {
  DeferredObligationService,
  RelationAssertionService,
  ResolutionService,
  fieldContractSha256,
  type EventPublisher,
  type GlobalMemoryRecallSubscription,
  type ManifestationResolverEventLogWriterPort
} from "@do-soul/alaya-core";
import {
  SqliteFieldCausalUsageRepo,
  SqliteTemporalPathProjectionReader
} from "@do-soul/alaya-storage";
import { type GraphEdgeCreationPort } from "@do-soul/alaya-soul";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";
import { SqliteHandoffGapAdapter } from "../../handoff/gap-adapter.js";
import { createRecallReadWorkerClient } from "../recall/recall-read-worker-client.js";
import { createSqliteConnectionReadSnapshot } from "../recall/sqlite-read-snapshot.js";
import { createCausalUsageTemporalPathReader } from
  "../recall/causal-usage-temporal-path-reader.js";
import {
  createRecallPathReadPorts,
  createRecallTemporalProjectionEnsurer
} from "../recall/recall-path-readers.js";
import { resolveRecallPathReadBind } from "../recall/recall-path-read-bind.js";
import {
  createGlobalMemoryRecallPort,
  createGlobalMemoryRouteService
} from "../daemon/lifecycle/daemon-runtime-support.js";
import { warnOnRejectedBackgroundTask } from "../daemon/lifecycle/daemon-runtime-helpers.js";
import { createEdgeAndReconciliationRuntime } from "./recall-materialization-edge-reconciliation.js";
import { createPathRelationRuntime } from "./recall-materialization-path-relation.js";
import { createResolutionEffectAuthority } from "./resolution-effect-authority.js";
import {
  createRecallSearchRuntime,
  createRecallServiceRuntime,
  createRecallUtilizationRuntime
} from "./recall-materialization-recall-runtime.js";
import { createSignalMaterializationRuntime } from "./recall-materialization-router.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";

export async function createRecallMaterializationWiring(input: CreateRecallMaterializationWiringInput) {
  const globalMemoryRuntime = createGlobalMemoryRuntime(input);
  const pathReadBind = resolveRecallPathReadBind({
    database: input.database,
    pathReadBind: input.pathReadBind
  });
  const bindTemporalPathReads = pathReadBind === "temporal";
  const directPathReadPorts = createDirectRecallPathReadPorts(input, bindTemporalPathReads);
  const allowDirectSqliteRecallReads = input.database.filename === ":memory:";
  const recallReadWorkerClient = createRecallReadWorkerClient({
    databaseFilename: input.database.filename,
    pathReadBind,
    ...(bindTemporalPathReads
      ? { prepareTemporalProjection: directPathReadPorts.ensureTemporalProjection }
      : {}),
    ...(allowDirectSqliteRecallReads ? { allowDirectSqliteRecallReads: true } : {}),
    warn: input.warn
  });
  const recallReadWorkerReady = recallReadWorkerClient?.ready() ?? Promise.resolve();
  // Startup work intentionally overlaps readiness, so attach rejection handling
  // now and still await the original promise before exposing the runtime.
  void recallReadWorkerReady.catch(() => undefined);

  try {
    const recallReadRuntime = createRecallReadRuntime(
      input,
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

function recallReadSnapshotOrThrow(
  input: CreateRecallMaterializationWiringInput,
  recallReadWorkerClient: ReturnType<typeof createRecallReadWorkerClient>
) {
  if (recallReadWorkerClient?.readSnapshot !== undefined) {
    return recallReadWorkerClient.readSnapshot;
  }
  if (input.database.filename !== ":memory:") {
    throw new Error("recall read worker is required; observe must not fall back to silent direct sqlite");
  }
  input.warn("recall observe using explicit direct sqlite because the database is :memory:", {
    reason: "direct_sqlite_recall_reads",
    database: ":memory:"
  });
  return createSqliteConnectionReadSnapshot(input.database.connection);
}

function createRecallReadRuntime(
  input: CreateRecallMaterializationWiringInput,
  recallReadWorkerClient: ReturnType<typeof createRecallReadWorkerClient>,
  directPathReadPorts: ReturnType<typeof createDirectRecallPathReadPorts>
) {
  const embeddingRuntime = createEmbeddingRuntimeWithWarmupObserver(input);
  const recallSearchRuntime = createRecallSearchRuntime(
    input,
    recallReadWorkerClient,
    directPathReadPorts
  );
  return {
    embeddingRuntime,
    recallUtilizationRuntime: createRecallUtilizationRuntime(input),
    recallServiceRuntime: createRecallServiceRuntime({
      input,
      embeddingRuntime,
      recallSearchRuntime,
      readSnapshot: recallReadSnapshotOrThrow(input, recallReadWorkerClient)
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
  const effectAuthority = createResolutionEffectAuthority({
    database: input.database,
    fieldComposition: input.fieldComposition,
    claimRepo: input.claimFormRepo,
    memoryRepo: input.memoryEntryRepo,
    deliveryReader: input.trustStateRecorder
  });
  return new ResolutionService({
    eventPublisher: input.eventPublisher,
    claimRepo: input.claimFormRepo,
    memoryRepo: input.memoryEntryRepo,
    claimService: input.claimService,
    memoryService: input.memoryService,
    deferredObligationService,
    ...effectAuthority
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
    closeEmbeddingProvider: recallReadRuntime.embeddingRuntime.closeProvider,
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
    reconciliationBasisStatus: materializationRuntime.edgeRuntime.reconciliationBasisStatus,
    pathRelationProposalService: materializationRuntime.pathRelationRuntime.pathRelationProposalService,
    relationAssertionService: materializationRuntime.pathRelationRuntime.relationAssertionService,
    relationAssertionAdmissionPort:
      materializationRuntime.pathRelationRuntime.relationAssertionAdmissionPort,
    relationProjectionCheckpoint:
      materializationRuntime.pathRelationRuntime.relationProjectionCheckpoint,
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
    eventPublisher: input.eventPublisher,
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

function createDirectRecallPathReadPorts(
  input: CreateRecallMaterializationWiringInput,
  bindTemporalPathReads: boolean
) {
  if (!bindTemporalPathReads) throw new Error("recall path reads require temporal projection");
  const relationAssertionService = new RelationAssertionService({
    repo: input.relationAssertionRepo,
    eventPublisher: input.eventPublisher,
    eventHistory: input.eventLogRepo
  });
  const temporalReader = new SqliteTemporalPathProjectionReader(input.relationAssertionRepo);
  return createRecallPathReadPorts({
    temporalProjectionSelected: true,
    temporalPathProjectionReader: createCausalUsageTemporalPathReader({
      base: temporalReader,
      usageRepo: new SqliteFieldCausalUsageRepo(input.database, fieldContractSha256)
    }),
    softAssociationPathReader: input.softAssociationPathRepo,
    ensureTemporalProjection: createRecallTemporalProjectionEnsurer(relationAssertionService)
  });
}

export function createAtomicManifestationEventLogWriter(
  eventPublisher: EventPublisher
): ManifestationResolverEventLogWriterPort {
  return {
    appendAtomically: (entries) =>
      eventPublisher.appendManyWithMutation(entries, (committed) => committed)
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
