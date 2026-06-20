import {
  RecallContextEventType,
  SoulActiveConstraintSchema
} from "@do-soul/alaya-protocol";
import {
  ContextLensAssembler,
  RecallService,
  RuleBasedEntityExtractor
} from "@do-soul/alaya-core";
import { findActiveConstraints } from "@do-soul/alaya-storage";
import { DegradationPipeline } from "@do-soul/alaya-soul";
import { createDaemonEmbeddingRuntime } from "../ai/daemon-embedding-runtime.js";
import { createManifestationContextLensAssembler } from "../manifestation/context-lens-assembler.js";
import {
  buildSingleUsedAnchorPayload,
  type SingleUsedAnchorTelemetryEmitter
} from "../routes/recall-utilization.js";
import { createRecallUtilizationService } from "../services/recall-utilization-service.js";
import { createGlobalMemoryRecallCachePort } from "./daemon-runtime-support.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";

export function createRecallUtilizationRuntime(input: CreateRecallMaterializationWiringInput) {
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
  return {
    recallUtilizationService,
    singleUsedAnchorEmitter,
    deliveryAnchorReader: {
      async findDeliveredObjectIds(deliveryId: string): Promise<readonly string[] | null> {
        const delivery = await input.trustStateRecorder.findDeliveryById(deliveryId);
        return delivery === null ? null : delivery.delivered_object_ids;
      }
    }
  };
}

export function createRecallSearchRuntime(
  input: CreateRecallMaterializationWiringInput,
  recallReadWorkerClient: ReturnType<typeof import("./recall-read-worker-client.js").createRecallReadWorkerClient>
) {
  return {
    recallMemoryRepo: recallReadWorkerClient?.memoryRepo ?? input.memoryEntryRepo,
    recallEvidenceSearchPort: createRecallEvidenceSearchPort(input, recallReadWorkerClient),
    recallSynthesisSearchPort: createRecallSynthesisSearchPort(input, recallReadWorkerClient),
    recallActiveConstraintsPort: createRecallActiveConstraintsPort(input)
  };
}

function createRecallEvidenceSearchPort(
  input: CreateRecallMaterializationWiringInput,
  recallReadWorkerClient: ReturnType<typeof import("./recall-read-worker-client.js").createRecallReadWorkerClient>
) {
  return recallReadWorkerClient?.evidenceSearchPort ?? {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      input.evidenceCapsuleRepo.searchByKeyword === undefined
        ? []
        : await input.evidenceCapsuleRepo.searchByKeyword(workspaceId, queryText, limit),
    findByIds: async (workspaceId: string, evidenceObjectIds: readonly string[]) => {
      const results = await input.evidenceCapsuleRepo.findByIds(evidenceObjectIds);
      return results.filter((evidence) => evidence.workspace_id === workspaceId);
    }
  };
}

function createRecallSynthesisSearchPort(
  input: CreateRecallMaterializationWiringInput,
  recallReadWorkerClient: ReturnType<typeof import("./recall-read-worker-client.js").createRecallReadWorkerClient>
) {
  return recallReadWorkerClient?.synthesisSearchPort ?? {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      input.synthesisCapsuleRepo.searchByKeyword === undefined
        ? []
        : await input.synthesisCapsuleRepo.searchByKeyword(workspaceId, queryText, limit),
    findByIds: async (objectIds: readonly string[]) => {
      const scoped = [];
      for (const objectId of objectIds) {
        const synthesis = await input.synthesisCapsuleRepo.findById(objectId);
        if (synthesis !== null) {
          scoped.push(synthesis);
        }
      }
      return scoped;
    }
  };
}

function createRecallActiveConstraintsPort(input: CreateRecallMaterializationWiringInput) {
  return {
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
        constraints: Object.freeze(result.constraints.map(toActiveConstraintRecord)),
        total_count: result.total_count
      });
    }
  };
}

function toActiveConstraintRecord(record: Awaited<ReturnType<typeof findActiveConstraints>>["constraints"][number]) {
  return SoulActiveConstraintSchema.parse({
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
  });
}

export function createRecallServiceRuntime(input: {
  readonly input: CreateRecallMaterializationWiringInput;
  readonly embeddingRuntime: ReturnType<typeof createDaemonEmbeddingRuntime>;
  readonly globalMemoryRuntime: {
    readonly globalMemoryRecallService:
      | import("@do-soul/alaya-core").GlobalMemoryRecallServicePort
      | undefined;
  };
  readonly recallPathRuntime: {
    readonly recallPathPlasticityPort: unknown;
    readonly recallPathExpansionPort: unknown;
  };
  readonly manifestationSidecarPort: unknown;
  readonly recallSearchRuntime: ReturnType<typeof createRecallSearchRuntime>;
}) {
  const recallService = createRecallService(input);
  const contextLensAssembler = createRecallContextLensAssembler(input.input, recallService);
  return {
    recallService,
    contextLensAssembler,
    conversationContextLensAssembler: createManifestationContextLensAssembler({
      delegate: contextLensAssembler
    })
  };
}

function createRecallService(input: {
  readonly input: CreateRecallMaterializationWiringInput;
  readonly embeddingRuntime: ReturnType<typeof createDaemonEmbeddingRuntime>;
  readonly globalMemoryRuntime: {
    readonly globalMemoryRecallService:
      | import("@do-soul/alaya-core").GlobalMemoryRecallServicePort
      | undefined;
  };
  readonly recallPathRuntime: {
    readonly recallPathPlasticityPort: unknown;
    readonly recallPathExpansionPort: unknown;
  };
  readonly manifestationSidecarPort: unknown;
  readonly recallSearchRuntime: ReturnType<typeof createRecallSearchRuntime>;
}) {
  return new RecallService({
    memoryRepo: input.recallSearchRuntime.recallMemoryRepo,
    slotRepo: input.input.slotRepo,
    eventLogRepo: input.input.eventLogRepo,
    graphSupportPort: input.input.graphExploreService,
    projectMappingPort: input.input.projectMappingService,
    pathPlasticityPort: input.recallPathRuntime.recallPathPlasticityPort as never,
    pathExpansionPort: input.recallPathRuntime.recallPathExpansionPort as never,
    activeConstraintsPort: input.recallSearchRuntime.recallActiveConstraintsPort,
    robustSourceRefParsing: readRobustSourceRefParsing(),
    evidenceSearchPort: input.recallSearchRuntime.recallEvidenceSearchPort,
    synthesisSearchPort: input.recallSearchRuntime.recallSynthesisSearchPort,
    ...createRecallGlobalMemoryPorts(input),
    budgetPenaltyPort: {
      getSnapshot: async (runId: string) =>
        await input.input.budgetBankruptcyService.getSnapshot(runId, input.input.budgetNow())
    },
    claimResolverPort: input.input.claimFormRepo,
    embeddingRecallService: input.embeddingRuntime.embeddingRecallService,
    manifestationSidecarPort: input.manifestationSidecarPort as never,
    ...(input.embeddingRuntime.defaultPolicyDecorator === undefined
      ? {}
      : { defaultPolicyDecorator: input.embeddingRuntime.defaultPolicyDecorator }),
    entityExtractionPort: new RuleBasedEntityExtractor(),
    warn: input.input.warn
  });
}

function createRecallContextLensAssembler(
  input: CreateRecallMaterializationWiringInput,
  recallService: RecallService
) {
  return new ContextLensAssembler({
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
}

function readRobustSourceRefParsing(): boolean {
  return (
    process.env.ALAYA_RECALL_SOURCE_REF_ROBUST === "1" ||
    process.env.ALAYA_RECALL_SOURCE_REF_ROBUST === "true"
  );
}

function createRecallGlobalMemoryPorts(input: {
  readonly input: CreateRecallMaterializationWiringInput;
  readonly globalMemoryRuntime: {
    readonly globalMemoryRecallService:
      | import("@do-soul/alaya-core").GlobalMemoryRecallServicePort
      | undefined;
  };
}) {
  if (input.input.globalMemoryRepo === null) {
    return {};
  }

  return {
    globalRecallPort: input.globalMemoryRuntime.globalMemoryRecallService,
    ...(input.input.globalMemoryRecallCacheRepo === null
      ? {}
      : {
          globalRecallCachePort: createGlobalMemoryRecallCachePort({
            globalMemoryRecallCacheRepo: input.input.globalMemoryRecallCacheRepo,
            now: () => new Date().toISOString()
          })
        })
  };
}
