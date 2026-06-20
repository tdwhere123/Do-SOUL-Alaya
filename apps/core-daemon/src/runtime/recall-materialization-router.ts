import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  ClaimService,
  ConflictDetectionService,
  type PathCandidateSink,
  ReconciliationService,
  SignalService,
  SynthesisService
} from "@do-soul/alaya-core";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import type { SqliteHandoffGapAdapter } from "../handoff/gap-adapter.js";
import type { PathRelationProposalPort } from "./recall-materialization-path-relation.js";
import type { CreateRecallMaterializationWiringInput } from "./recall-materialization-wiring-types.js";

export function createSignalMaterializationRuntime(input: {
  readonly wiring: CreateRecallMaterializationWiringInput;
  readonly pathRelationProposalPort: PathRelationProposalPort;
  readonly pathCandidateSinkPort: PathCandidateSink;
  readonly conflictDetectionService: ConflictDetectionService | null;
  readonly reconciliationService: ReconciliationService | null;
  readonly handoffGapHandler: SqliteHandoffGapAdapter;
}): Readonly<{
  readonly materializationRouter: MaterializationRouter;
  readonly signalService: SignalService;
}> {
  const { wiring } = input;
  const routerOptions = readMaterializationRouterOptions();
  const materializationRouter = new MaterializationRouter({
    evidenceService: wiring.evidenceService,
    memoryService: createMaterializationMemoryService(wiring),
    synthesisService: wiring.synthesisService as SynthesisService,
    claimService: wiring.claimService as ClaimService,
    pathRelationProposalPort: input.pathRelationProposalPort,
    pathCandidateSinkPort: input.pathCandidateSinkPort,
    enrichPendingPort: { enqueue: wiring.enqueueEnrichPending },
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
  const signalService = new SignalService({
    eventLogRepo: wiring.eventLogRepo,
    signalRepo: wiring.signalRepo,
    runtimeNotifier: wiring.runtimeNotifier,
    postTriageMaterializer: {
      materialize: async (signal: CandidateMemorySignal) =>
        await materializationRouter.materializeSignal(signal)
    }
  });

  return Object.freeze({ materializationRouter, signalService });
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
    materializationConfidenceFloor: readMaterializationConfidenceFloor()
  };
}

function readMaterializationConfidenceFloor(): number | undefined {
  const raw = Number(process.env.ALAYA_MATERIALIZATION_CONF_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;
}
