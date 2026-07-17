import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  ClaimService,
  ConflictDetectionService,
  createSignalEmissionWriter,
  ReconciliationService,
  SignalService,
  SynthesisService
} from "@do-soul/alaya-core";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import type { SqliteHandoffGapAdapter } from "../handoff/gap-adapter.js";
import type {
  PathRelationProposalPort,
  TemporalRelationAssertionPort
} from "./recall-materialization-path-relation.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";
import { createSourceGroundingDeferTransitions } from "./source-grounding-defer/transitions.js";

type SignalMaterializationRuntimeInput = Readonly<{
  readonly wiring: CreateRecallMaterializationWiringInput;
  readonly pathRelationProposalPort: PathRelationProposalPort;
  readonly temporalRelationAssertionPort: TemporalRelationAssertionPort;
  readonly conflictDetectionService: ConflictDetectionService | null;
  readonly reconciliationService: ReconciliationService | null;
  readonly handoffGapHandler: SqliteHandoffGapAdapter;
}>;

export function createSignalMaterializationRuntime(
  input: SignalMaterializationRuntimeInput
): Readonly<{
  readonly materializationRouter: MaterializationRouter;
  readonly signalService: SignalService;
}> {
  const materializationRouter = createMaterializationRouter(input);
  const signalService = createMaterializationSignalService(input.wiring, materializationRouter);
  return Object.freeze({ materializationRouter, signalService });
}

function createMaterializationRouter(
  input: SignalMaterializationRuntimeInput
): MaterializationRouter {
  const routerOptions = readMaterializationRouterOptions();
  return new MaterializationRouter({
    evidenceService: input.wiring.evidenceService,
    memoryService: createMaterializationMemoryService(input.wiring),
    synthesisService: input.wiring.synthesisService as SynthesisService,
    claimService: input.wiring.claimService as ClaimService,
    pathRelationProposalPort: input.pathRelationProposalPort,
    temporalRelationAssertionPort: input.temporalRelationAssertionPort,
    enrichPendingPort: { enqueue: input.wiring.enqueueEnrichPending },
    ...(input.conflictDetectionService === null
      ? {}
      : { conflictDetectionPort: input.conflictDetectionService }),
    ...(input.reconciliationService === null
      ? {}
      : { reconciliationPort: input.reconciliationService }),
    handoffGapHandler: input.handoffGapHandler,
    retainUnroutedHighConfidenceFacts: routerOptions.retainUnroutedHighConfidenceFacts,
    fullTurnEvidenceExcerpt: routerOptions.fullTurnEvidenceExcerpt,
    projectionRoutingEnabled: routerOptions.projectionRoutingEnabled,
    deriveFacetTags: routerOptions.deriveFacetTags,
    ...(routerOptions.materializationConfidenceFloor === undefined
      ? {}
      : { materializationConfidenceFloor: routerOptions.materializationConfidenceFloor })
  });
}

function createMaterializationSignalService(
  wiring: CreateRecallMaterializationWiringInput,
  materializationRouter: MaterializationRouter
): SignalService {
  return new SignalService({
    eventLogRepo: wiring.eventLogRepo,
    signalRepo: wiring.signalRepo,
    emissionWriter: createSignalEmissionWriter({
      eventPublisher: wiring.eventPublisher,
      signalRepo: wiring.signalRepo
    }),
    runtimeNotifier: wiring.runtimeNotifier,
    sourceGroundingDeferQueue: wiring.sourceGroundingDeferQueueRepo,
    sourceGroundingDeferTransitions: createSourceGroundingDeferTransitions({
      eventLogRepo: wiring.eventLogRepo,
      signalRepo: wiring.signalRepo,
      queueRepo: wiring.sourceGroundingDeferQueueRepo
    }),
    postTriageMaterializer: {
      materialize: async (signal: CandidateMemorySignal, context) =>
        await materializationRouter.materializeSignal(signal, context)
    }
  });
}

function createMaterializationMemoryService(
  wiring: CreateRecallMaterializationWiringInput
) {
  return {
    create: async (createInput: Parameters<typeof wiring.memoryService.create>[0]) => {
      const created = await wiring.memoryService.create(createInput);
      return {
        object_kind: created.object_kind,
        object_id: created.object_id,
        enrichmentEnqueued:
          (createInput as { enqueueEnrichment?: unknown }).enqueueEnrichment !== undefined
      };
    }
  };
}

function readMaterializationRouterOptions() {
  return {
    retainUnroutedHighConfidenceFacts:
      process.env.ALAYA_RETAIN_UNROUTED_FACTS !== "0" &&
      process.env.ALAYA_RETAIN_UNROUTED_FACTS !== "false",
    fullTurnEvidenceExcerpt:
      process.env.ALAYA_EVIDENCE_FULL_TURN !== "0" &&
      process.env.ALAYA_EVIDENCE_FULL_TURN !== "false",
    // Defaults OFF so a merge never flips durable write behavior pre-bench.
    projectionRoutingEnabled: readProjectionRoutingEnabled(),
    deriveFacetTags: readFacetTagsEnabled(),
    materializationConfidenceFloor: readMaterializationConfidenceFloor()
  };
}

function readProjectionRoutingEnabled(): boolean {
  return /^(?:1|true|on|yes)$/iu.test(process.env.ALAYA_RECALL_PROJECTIONS ?? "");
}

function readFacetTagsEnabled(): boolean {
  return /^(?:1|true|on|yes)$/iu.test(process.env.ALAYA_RECALL_FACET_TAGS ?? "");
}

function readMaterializationConfidenceFloor(): number | undefined {
  const raw = Number(process.env.ALAYA_MATERIALIZATION_CONF_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;
}
