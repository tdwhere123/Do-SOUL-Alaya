import { selectObservedTemporalProjection } from "@do-soul/alaya-soul";
import {
  parseDefaultOnFlag,
  parseEnvBoolean,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import { processEnvLookup } from "../config/daemon-config-environment.js";
import {
  ClaimService,
  ConflictDetectionService,
  createAuditedSourceAdmission,
  createSignalEmissionWriter,
  createSourceObservationPublication,
  fieldContractSha256,
  ReconciliationService,
  SignalService,
  SynthesisService
} from "@do-soul/alaya-core";
import {
  MaterializationRouter,
  type SourceObservationPublicationPort
} from "@do-soul/alaya-soul";
import type { SqliteHandoffGapAdapter } from "../../handoff/gap-adapter.js";
import type {
  PathRelationProposalPort,
  TemporalRelationAssertionPort
} from "./recall-materialization-path-relation.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";
import { createSourceGroundingDeferTransitions } from "../source-grounding-defer/transitions.js";

export type SignalMaterializationRuntimeInput = Readonly<{
  readonly wiring: CreateRecallMaterializationWiringInput;
  readonly pathRelationProposalPort: PathRelationProposalPort;
  readonly temporalRelationAssertionPort: TemporalRelationAssertionPort;
  readonly conflictDetectionService: ConflictDetectionService | null;
  readonly reconciliationService: ReconciliationService | null;
  readonly handoffGapHandler: SqliteHandoffGapAdapter;
}>;

type RouterOptions = ConstructorParameters<typeof MaterializationRouter>[0];
type RouterWiring = Pick<CreateRecallMaterializationWiringInput,
  "evidenceService" | "memoryService" | "fieldComposition" | "eventLogRepo" | "enqueueEnrichPending"> &
  Pick<RouterOptions, "synthesisService" | "claimService"> & {
    readonly runtimeNotifier: { notifyEntry(entry: import("@do-soul/alaya-protocol").EventLogEntry): void | Promise<void> };
  };
type MaterializationRouterInput = Omit<SignalMaterializationRuntimeInput, "wiring" | "handoffGapHandler"> & {
  readonly wiring: RouterWiring;
  readonly handoffGapHandler: RouterOptions["handoffGapHandler"];
};

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

export function createMaterializationRouter(
  input: MaterializationRouterInput
): MaterializationRouter {
  const routerOptions = readMaterializationRouterOptions();
  return new MaterializationRouter({
    evidenceService: input.wiring.evidenceService,
    memoryService: createMaterializationMemoryService(input.wiring),
    synthesisService: input.wiring.synthesisService as SynthesisService,
    claimService: input.wiring.claimService as ClaimService,
    sourceObservationPublicationPort: createSourceObservationPublicationPort(input.wiring),
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

function createSourceObservationPublicationPort(
  wiring: RouterWiring
): SourceObservationPublicationPort {
  const publication = createSourceObservationPublication({
    deriveTemporalProjection: (assertion, sourceObservedAt) =>
      selectObservedTemporalProjection(assertion, undefined, sourceObservedAt ?? undefined) ?? {},
    stores: wiring.fieldComposition.stores,
    sourceAdmission: createAuditedSourceAdmission({
      sha256: fieldContractSha256,
      stores: wiring.fieldComposition.stores,
      eventLogRepo: wiring.eventLogRepo,
      runtimeNotifier: wiring.runtimeNotifier
    }),
    evidenceService: wiring.evidenceService,
    memoryService: wiring.memoryService,
    sha256: fieldContractSha256
  });
  return {
    async publish(input) {
      const published = await publication.publish({
        signal: input.signal,
        sourceEventAnchor: input.context.source_event_anchor
      });
      return {
        bound: published.bound,
        evidence: {
          object_kind: published.evidence.object_kind,
          object_id: published.evidence.object_id
        },
        memory: {
          object_kind: published.memory.object_kind,
          object_id: published.memory.object_id
        }
      };
    }
  };
}

function createMaterializationMemoryService(
  wiring: Pick<RouterWiring, "memoryService">
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

export function isRetainUnroutedFactsEnabled(
  raw: string | undefined = processEnvLookup().ALAYA_RETAIN_UNROUTED_FACTS
): boolean {
  return parseEnvBoolean(raw, "ALAYA_RETAIN_UNROUTED_FACTS");
}

function readMaterializationRouterOptions() {
  return {
    retainUnroutedHighConfidenceFacts: isRetainUnroutedFactsEnabled(),
    fullTurnEvidenceExcerpt: parseDefaultOnFlag(
      processEnvLookup().ALAYA_EVIDENCE_FULL_TURN,
      "ALAYA_EVIDENCE_FULL_TURN"
    ),
    materializationConfidenceFloor: readMaterializationConfidenceFloor()
  };
}

function readMaterializationConfidenceFloor(): number | undefined {
  const raw = Number(processEnvLookup().ALAYA_MATERIALIZATION_CONF_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;
}
