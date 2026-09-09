import {
  RecallContextEventType,
  SoulActiveConstraintSchema
} from "@do-soul/alaya-protocol";
import {
  ContextLensAssembler,
  RecallService,
  type RecallReadSnapshotPort
} from "@do-soul/alaya-core";
import { findActiveConstraints } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../recall-read-worker/observer-operations.js";
import { createBoundedActiveConstraintsReader } from "../recall-read-worker/active-constraints.js";
import { DegradationPipeline } from "@do-soul/alaya-soul";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";
import {
  annotateRecallEmbeddingWarmupHold,
  type EmbeddingWarmupHoldReason
} from "../../ai/embedding-warmup-hold.js";
import { createManifestationContextLensAssembler } from "../../manifestation/context-lens-assembler.js";
import {
  buildSingleUsedAnchorPayload,
  type SingleUsedAnchorTelemetryEmitter
} from "../../routes/memory/recall/recall-utilization.js";
import { createRecallUtilizationService } from "../../services/status/recall-utilization-service.js";
import { type RecallPathReadPorts } from "../recall/recall-path-readers.js";
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
  recallReadWorkerClient: ReturnType<typeof import("../recall/recall-read-worker-client.js").createRecallReadWorkerClient>,
  directPathReadPorts: RecallPathReadPorts
) {
  return {
    recallActiveConstraintsPort:
      recallReadWorkerClient?.activeConstraintsPort
      ?? createRecallActiveConstraintsPort(input, directPathReadPorts),
    conditionalFieldPort: recallReadWorkerClient?.conditionalFieldPort
  };
}

export function createRecallActiveConstraintsPort(
  input: Readonly<{
    readonly database?: import("@do-soul/alaya-storage").StorageDatabase;
    readonly memoryEntryRepo: Parameters<typeof findActiveConstraints>[0]["memoryRepo"];
    readonly claimFormRepo: Parameters<typeof findActiveConstraints>[0]["claimFormRepo"];
  }>,
  directPathReadPorts: RecallPathReadPorts
) {
  const bounded = input.database === undefined ? undefined : createBoundedActiveConstraintsReader(input.database);
  return {
    ...(bounded === undefined ? {} : {
      readBounded: async (request: import("@do-soul/alaya-protocol").BoundedActiveConstraintsRequest) =>
        bounded(request)
    }),
    findActiveConstraints: async (
      activeConstraintsInput: Readonly<{
        readonly workspaceId: string;
        readonly cap?: number | null;
        readonly asOf?: string;
      }>
    ) => {
      const result = await findActiveConstraints({
        workspaceId: activeConstraintsInput.workspaceId,
        memoryRepo: input.memoryEntryRepo,
        claimFormRepo: input.claimFormRepo,
        pathRelationRepo: {
          findActiveAll: async (workspaceId: string) => {
            const relations = activeConstraintsInput.asOf === undefined
              ? await directPathReadPorts.findActiveByWorkspace(workspaceId)
              : await directPathReadPorts.findActiveByWorkspace(workspaceId, {
                asOf: activeConstraintsInput.asOf
              });
            return { relations, truncated: false };
          }
        },
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
  readonly recallSearchRuntime: ReturnType<typeof createRecallSearchRuntime>;
  readonly readSnapshot: RecallReadSnapshotPort;
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
  readonly recallSearchRuntime: ReturnType<typeof createRecallSearchRuntime>;
  readonly readSnapshot: RecallReadSnapshotPort;
}) {
  const service = new RecallService({
    activeConstraintsPort: input.recallSearchRuntime.recallActiveConstraintsPort,
    ...(input.embeddingRuntime.defaultPolicyDecorator === undefined
      ? {}
      : { defaultPolicyDecorator: input.embeddingRuntime.defaultPolicyDecorator }),
    readSnapshot: input.readSnapshot,
    observerReaders: createConditionalFieldObserverReaders(input.input.database),
    ...(input.recallSearchRuntime.conditionalFieldPort === undefined
      ? {}
      : { conditionalFieldPort: input.recallSearchRuntime.conditionalFieldPort })
  });
  return withEmbeddingWarmupHoldAnnotation(service, input.embeddingRuntime.getWarmupHoldReason);
}

function withEmbeddingWarmupHoldAnnotation(
  service: RecallService,
  getWarmupHoldReason: () => EmbeddingWarmupHoldReason | null
): RecallService {
  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop === "recall") {
        return async (params: Parameters<RecallService["recall"]>[0]) => {
          const result = await target.recall(params);
          return annotateRecallEmbeddingWarmupHold(result, getWarmupHoldReason());
        };
      }
      return Reflect.get(target, prop, receiver);
    }
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
