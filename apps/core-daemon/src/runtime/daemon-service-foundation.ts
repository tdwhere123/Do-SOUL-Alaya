import {
  ArbitrationService,
  BudgetBankruptcyService,
  CanonicalAliasService,
  ClaimService,
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
  ProjectMappingService,
  ProposalService,
  SessionOverrideService,
  SlotService,
  StrongRefService,
  SurfaceBindingService,
  SurfaceDriftService,
  SurfaceService,
  SynthesisService,
  TaskSurfaceBuilder,
  ToolSpecService,
  ZeroDaySecurityLayer
} from "@do-soul/alaya-core";
import {
  SqliteDriftLeaseRepo,
  SqliteHealthIssueGroupRepo
} from "@do-soul/alaya-storage";
import {
  BootstrappingService,
  TopologyService
} from "@do-soul/alaya-soul";
import { createBudgetProposalPort } from "../budget/wiring.js";
import { parseZeroDayPoliciesJson } from "../security/zero-day-policies.js";
import { createSecurityStatusBootstrapServices } from "../security/status-bootstrap.js";
import { createConfigService } from "../services/config-service.js";
import { createEnvironmentStatusService } from "../services/environment-status-service.js";
import { createGraphHealthService } from "../services/graph-health-service.js";
import {
  CORE_DAEMON_ENVIRONMENT_TOOLS,
  derivePrincipalCodingAvailability
} from "../services/principal-coding-availability.js";
import { createTrustStateRecorder } from "../trust/state.js";
import {
  createManifestationBudgetConfigProvider,
} from "./daemon-runtime-helpers.js";
import { createSoulGraphService } from "./soul-graph-runtime-support.js";
import {
  createPathFailureHealthInbox,
  createRecallFailureHealthInbox
} from "./daemon-service-wiring.js";
import {
  defaultBootstrappingTemplates,
  defaultCanonicalAliasMap
} from "./daemon-defaults.js";

type DaemonServiceFoundationInput = {
  readonly [key: string]: any;
};

export async function createDaemonServiceFoundation(input: DaemonServiceFoundationInput) {
  const environmentFoundation = await createEnvironmentSecurityFoundation(input);
  const configFoundation = createConfigFoundation(input, environmentFoundation.eventPublisher);
  const knowledgeFoundation = createKnowledgeFoundation(
    input,
    environmentFoundation.eventPublisher
  );
  const governanceFoundation = createGovernanceAndSurfaceFoundation(
    input,
    environmentFoundation.eventPublisher,
    knowledgeFoundation.healthJournalService
  );

  return {
    ...environmentFoundation,
    ...configFoundation,
    ...knowledgeFoundation,
    ...governanceFoundation
  };
}

async function createEnvironmentSecurityFoundation(input: DaemonServiceFoundationInput) {
  const environmentStatusService = createEnvironmentStatusService({
    toolNames: CORE_DAEMON_ENVIRONMENT_TOOLS,
    getDatabasePath: () => input.database.filename,
    getFilesDirectory: () => input.filesDirectory
  });
  const environmentStatus = await environmentStatusService.getStatus();
  const principalCodingAvailability = derivePrincipalCodingAvailability({
    runtimeConfigured: process.env.ALAYA_PRINCIPAL_RUNTIME === "claude_code",
    tools: environmentStatus.tools
  });
  const zeroDaySecurityLayer = new ZeroDaySecurityLayer({
    loadPolicies: async () => parseZeroDayPoliciesJson(process.env.ZERO_DAY_POLICIES_JSON)
  });
  const {
    eventPublisher,
    runHotStateService,
    securityStatusService,
    workspaceService: securedWorkspaceService
  } = createSecurityStatusBootstrapServices({
    workspaceRepo: input.workspaceRepo,
    runRepo: input.runRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    zeroDayLayer: zeroDaySecurityLayer,
    engineConfigRepo: input.workspaceEngineConfigRepo,
    bootstrappingPlanner: new BootstrappingService({
      templates: defaultBootstrappingTemplates,
      now: () => new Date().toISOString()
    }),
    pathRelationRepo: input.pathRelationRepo,
    bootstrappingRecordRepo: input.bootstrappingRecordRepo
  });
  return {
    environmentStatusService,
    principalCodingAvailability,
    eventPublisher,
    runHotStateService,
    securityStatusService,
    securedWorkspaceService
  };
}

function createConfigFoundation(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"]
) {
  const rawConfigService = createConfigService({
    configRepo: input.configRepo,
    eventPublisher,
    configPathsProvider: () => input.configPaths
  });
  const manifestationBudgetConfigProvider = createManifestationBudgetConfigProvider(input.configRepo);
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: input.trustStateRepo,
    clock: () => new Date().toISOString()
  });
  const toolSpecService = new ToolSpecService({ toolSpecRepo: input.toolSpecRepo });
  const strongRefService = new StrongRefService({ repo: input.strongRefRepo });
  return {
    rawConfigService,
    manifestationBudgetConfigProvider,
    trustStateRecorder,
    toolSpecService,
    strongRefService
  };
}

function createKnowledgeFoundation(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"]
) {
  const dynamicsServiceRef = createDynamicsServiceRef();
  const evidenceService = createEvidenceService(input, dynamicsServiceRef);
  const governanceLeaseService = new GovernanceLeaseService({ eventLogRepo: input.eventLogRepo });
  const healthJournalService = createHealthJournalService(input);
  const greenService = createGreenService(input, governanceLeaseService);
  const dynamicsService = createDynamicsService(input, greenService);
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

function createGovernanceAndSurfaceFoundation(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"],
  healthJournalService: HealthJournalService
) {
  const canonicalAliasService = new CanonicalAliasService({
    aliasMap: defaultCanonicalAliasMap,
    eventPublisher
  });
  const slotClaimRuntime = createSlotClaimRuntime(input, eventPublisher, canonicalAliasService);
  const governanceServices = createGovernanceServices(input);
  const surfaceService = createSurfaceService(input, eventPublisher, healthJournalService);
  const taskSurfaceBuilder = new TaskSurfaceBuilder({
    surfaceRepo: input.surfaceIdentityRepo,
    eventLogRepo: input.eventLogRepo
  });

  return {
    arbitrationService: slotClaimRuntime.arbitrationService,
    slotService: slotClaimRuntime.slotService,
    claimService: slotClaimRuntime.claimService,
    sessionOverrideService: governanceServices.sessionOverrideService,
    proposalService: governanceServices.proposalService,
    surfaceService,
    taskSurfaceBuilder,
    budgetNow: governanceServices.budgetNow,
    budgetBankruptcyService: governanceServices.budgetBankruptcyService,
    projectMappingService: governanceServices.projectMappingService
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
  greenService: GreenService
) {
  return new DynamicsService({
    memoryRepo: input.memoryEntryRepo,
    karmaEventRepo: input.karmaEventRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    greenService
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
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"],
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

function createSlotClaimRuntime(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"],
  canonicalAliasService: CanonicalAliasService
) {
  const claimServiceRef: { current: ClaimService | null } = { current: null };
  const arbitrationService = new ArbitrationService({
    slotRepo: input.slotRepo,
    claimRepo: input.claimFormRepo,
    conflictMatrixRepo: input.conflictMatrixRepo,
    claimService: {
      transitionLifecycle: async (...args) => {
        const claimService = claimServiceRef.current;
        if (claimService === null) {
          throw new Error("ArbitrationService claimService used before ClaimService initialization.");
        }
        return await claimService.transitionLifecycle(...args);
      }
    },
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
  const slotService = new SlotService({
    slotRepo: input.slotRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier,
    arbitrationService: {
      arbitrateSlot: async (slotId, options) => await arbitrationService.arbitrateSlot(slotId, options)
    }
  });
  const claimService = new ClaimService({
    claimFormRepo: input.claimFormRepo,
    eventLogRepo: input.eventLogRepo,
    slotService,
    runtimeNotifier: input.runtimeNotifier,
    eventPublisher,
    canonicalAliasService
  });
  claimServiceRef.current = claimService;

  return { arbitrationService, slotService, claimService };
}

function createSurfaceService(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"],
  healthJournalService: HealthJournalService
) {
  const surfaceDriftService = new SurfaceDriftService({
    leaseRepo: new SqliteDriftLeaseRepo(input.database),
    eventPublisher,
    healthJournal: {
      record: async (entry) => {
        await healthJournalService.record(entry);
      }
    }
  });
  const surfaceBindingService = new SurfaceBindingService({
    surfaceBindingRepo: input.surfaceBindingRepo,
    crossCuttingPermissionLookup: input.crossCuttingPermissionRepo,
    eventPublisher,
    surfaceDriftService
  });
  return new SurfaceService({
    surfaceIdentityRepo: input.surfaceIdentityRepo,
    surfaceAnchorRepo: input.surfaceAnchorRepo,
    runtimeNotifier: input.runtimeNotifier,
    surfaceDriftService,
    surfaceBindingCascader: surfaceBindingService
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

function createGovernanceServices(input: DaemonServiceFoundationInput) {
  const sessionOverrideService = new SessionOverrideService({
    eventLogRepo: input.eventLogRepo
  });
  const proposalService = new ProposalService({
    proposalRepo: input.proposalRepo,
    eventLogRepo: input.eventLogRepo,
    runtimeNotifier: input.runtimeNotifier
  });
  const budgetNow = () => new Date().toISOString();
  return {
    sessionOverrideService,
    proposalService,
    budgetNow,
    budgetBankruptcyService: new BudgetBankruptcyService({
      eventLogRepo: input.eventLogRepo,
      proposalService: createBudgetProposalPort({
        proposalRepo: input.proposalRepo,
        now: budgetNow
      }),
      runtimeNotifier: input.runtimeNotifier,
      now: budgetNow
    }),
    projectMappingService: new ProjectMappingService({
      projectMappingRepo: input.projectMappingAnchorRepo,
      memoryRepo: input.memoryEntryRepo,
      eventLogRepo: input.eventLogRepo,
      runtimeNotifier: input.runtimeNotifier
    })
  };
}

function createKnowledgeInteractionRuntime(
  input: DaemonServiceFoundationInput,
  eventPublisher: ReturnType<typeof createSecurityStatusBootstrapServices>["eventPublisher"]
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
