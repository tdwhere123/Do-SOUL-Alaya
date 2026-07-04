import {
  DynamicsService,
  EdgeProposalService,
  EvidenceService,
  GovernanceLeaseService,
  GraphContractService,
  GraphExploreService,
  GreenService,
  HealthJournalService,
  MemoryService,
  PathRelationProposalService,
  SynthesisService
} from "@do-soul/alaya-core";
import { SqliteHealthIssueGroupRepo } from "@do-soul/alaya-storage";
import { TopologyService } from "@do-soul/alaya-soul";
import { createGraphHealthService } from "../services/graph-health-service.js";
import { createSecurityStatusBootstrapServices } from "../security/status-bootstrap.js";
import { createSoulGraphService } from "./soul-graph-runtime-support.js";
import {
  createPathFailureHealthInbox,
  createRecallFailureHealthInbox
} from "./daemon-service-wiring.js";
import { requireAtomicKarmaTransition } from "./karma-atomic-wiring-guard.js";
import type { DaemonServiceFoundationInput } from "./daemon-service-foundation.js";

type FoundationEventPublisher = ReturnType<
  typeof createSecurityStatusBootstrapServices
>["eventPublisher"];

export function createKnowledgeFoundation(
  input: DaemonServiceFoundationInput,
  eventPublisher: FoundationEventPublisher
) {
  const dynamicsServiceRef = createDynamicsServiceRef();
  const evidenceService = createEvidenceService(input, dynamicsServiceRef);
  const governanceLeaseService = new GovernanceLeaseService({
    eventLogRepo: input.eventLogRepo,
    runLookup: input.runRepo
  });
  const healthJournalService = createHealthJournalService(input);
  const greenService = createGreenService(input, governanceLeaseService);
  const dynamicsService = createDynamicsService(input, greenService, eventPublisher);
  dynamicsServiceRef.current = dynamicsService;
  const memoryService = createMemoryService(input, evidenceService, dynamicsService, greenService);
  const interactionRuntime = createKnowledgeInteractionRuntime(input, eventPublisher);
  const graphRuntime = createKnowledgeGraphRuntime(input);
  const synthesisService = new SynthesisService({
    synthesisCapsuleRepo: input.synthesisCapsuleRepo,
    evidenceService,
    memoryService,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
  return {
    evidenceService,
    governanceLeaseService,
    healthJournalService,
    greenService,
    dynamicsService,
    memoryService,
    graphExploreService: interactionRuntime.graphExploreService,
    pathRelationProposalServiceRef: interactionRuntime.pathRelationProposalServiceRef,
    healthIssueGroupRepo: interactionRuntime.healthIssueGroupRepo,
    pathFailureHealthInboxPort: interactionRuntime.pathFailureHealthInboxPort,
    recallFailureHealthInboxPort: interactionRuntime.recallFailureHealthInboxPort,
    edgeProposalService: interactionRuntime.edgeProposalService,
    topologyService: graphRuntime.topologyService,
    soulGraphService: graphRuntime.soulGraphService,
    graphHealthService: graphRuntime.graphHealthService,
    graphContractService: graphRuntime.graphContractService,
    synthesisService
  };
}

function createDynamicsServiceRef(): {
  current: {
    emitKarmaEvent(input: {
      kind: "evidence_gain";
      objectId: string;
      workspaceId: string;
      runId?: string | null;
    }): Promise<void>;
  } | null;
} {
  return { current: null };
}

function createEvidenceService(
  input: DaemonServiceFoundationInput,
  dynamicsServiceRef: ReturnType<typeof createDynamicsServiceRef>
) {
  return new EvidenceService({
    evidenceCapsuleRepo: input.evidenceCapsuleRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    karmaEmitter: {
      emitKarmaEvent: async (emitInput) => {
        if (dynamicsServiceRef.current === null) {
          return;
        }
        await dynamicsServiceRef.current.emitKarmaEvent(emitInput);
      }
    },
    memoryRefLookup: {
      findMemoriesByEvidenceRef: async (evidenceObjectId, workspaceId) => {
        const memories = await input.memoryEntryRepo.findByEvidenceRefs(workspaceId, [evidenceObjectId]);
        return memories.map((entry: { readonly object_id: string }) => ({ object_id: entry.object_id }));
      }
    },
    warn: input.warnLogger.warn
  });
}

function createHealthJournalService(input: DaemonServiceFoundationInput) {
  return new HealthJournalService({
    repo: input.healthJournalRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
}

function createGreenService(
  input: DaemonServiceFoundationInput,
  governanceLeaseService: GovernanceLeaseService
) {
  return new GreenService({
    greenStatusRepo: input.greenStatusRepo,
    memoryRepo: input.memoryEntryRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    leaseService: governanceLeaseService,
    warn: input.warnLogger.warn
  });
}

function createDynamicsService(
  input: DaemonServiceFoundationInput,
  greenService: GreenService,
  eventPublisher: FoundationEventPublisher
) {
  // Fail fast if the karma path is not single-transaction-atomic (residual #1).
  requireAtomicKarmaTransition({
    eventPublisher,
    eventLogRepo: input.eventLogRepo,
    karmaEventRepo: input.karmaEventRepo,
    memoryRepo: input.memoryEntryRepo
  });
  return new DynamicsService({
    memoryRepo: input.memoryEntryRepo,
    karmaEventRepo: input.karmaEventRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    greenService,
    eventPublisher
  });
}

function createMemoryService(
  input: DaemonServiceFoundationInput,
  evidenceService: EvidenceService,
  dynamicsService: DynamicsService,
  greenService: GreenService
) {
  return new MemoryService({
    memoryEntryRepo: input.memoryEntryRepo,
    evidenceService,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    dynamicsService,
    greenService,
    synthesisCapsuleLookup: {
      findById: (objectId: string) => input.synthesisCapsuleRepo.findById(objectId)
    },
    enrichPendingWriter: { enqueue: input.enqueueEnrichPending }
  });
}

function createEdgeProposalService(
  input: DaemonServiceFoundationInput,
  eventPublisher: FoundationEventPublisher,
  pathRelationProposalServiceRef: {
    current: Pick<PathRelationProposalService, "submitCandidate"> | null;
  },
  pathFailureHealthInboxPort: ReturnType<typeof createPathFailureHealthInbox>
) {
  return new EdgeProposalService({
    memoryRepo: input.memoryEntryRepo,
    proposalRepo: input.edgeProposalRepo,
    pathCandidatePort: {
      submitCandidate: async (candidateInput) => {
        if (pathRelationProposalServiceRef.current === null) {
          throw new Error("PathRelationProposalService used before recall wiring completed.");
        }
        return await pathRelationProposalServiceRef.current.submitCandidate(candidateInput);
      }
    },
    healthInboxPort: {
      recordPathRelationFailure: (entry) => pathFailureHealthInboxPort.recordPathRelationFailure(entry)
    },
    eventPublisher
  });
}

function createKnowledgeGraphRuntime(input: DaemonServiceFoundationInput) {
  return {
    topologyService: new TopologyService({
      pathRelationRepo: input.pathRelationRepo,
      snapshotHistory: {
        getHistory: async (workspaceId, limit) =>
          await input.pathGraphSnapshotRepo.findHistory(workspaceId, limit)
      }
    }),
    soulGraphService: createSoulGraphService({
      memoryEntryRepo: input.memoryEntryRepo,
      pathRelationRepo: input.pathRelationRepo,
      proposalRepo: input.proposalRepo,
      eventLogRepo: input.eventLogRepo
    }),
    graphHealthService: createGraphHealthService({
      pathRelationRepo: input.pathRelationRepo,
      eventLogRepo: input.eventLogRepo
    }),
    graphContractService: new GraphContractService({
      pathRelationRepo: input.pathRelationRepo
    })
  };
}

function createKnowledgeInteractionRuntime(
  input: DaemonServiceFoundationInput,
  eventPublisher: FoundationEventPublisher
) {
  const pathRelationProposalServiceRef: {
    current: Pick<PathRelationProposalService, "submitCandidate"> | null;
  } = { current: null };
  const healthIssueGroupRepo = new SqliteHealthIssueGroupRepo(input.database);
  const pathFailureHealthInboxPort = createPathFailureHealthInbox({ healthIssueGroupRepo });
  const recallFailureHealthInboxPort = createRecallFailureHealthInbox({ healthIssueGroupRepo });
  return {
    graphExploreService: new GraphExploreService({
      pathRepo: input.pathRelationRepo,
      eventLogRepo: input.eventLogRepo
    }),
    pathRelationProposalServiceRef,
    healthIssueGroupRepo,
    pathFailureHealthInboxPort,
    recallFailureHealthInboxPort,
    edgeProposalService: createEdgeProposalService(
      input,
      eventPublisher,
      pathRelationProposalServiceRef,
      pathFailureHealthInboxPort
    )
  };
}
