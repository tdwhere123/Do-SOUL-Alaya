import type { AlayaDaemonRuntime } from "./daemon-runtime-types.js";
import { finalizeAlayaDaemonRuntime } from "./daemon-runtime-finalization.js";
import { createOptionalMemoryHqRepo } from "./daemon-runtime-support.js";
import { HqAnswerOverlapPairSource } from "@do-soul/alaya-core";
import type { FinalizeDaemonRuntimeWiringInput } from "../index.js";

export async function finalizeDaemonRuntimeFromWiring(
  input: FinalizeDaemonRuntimeWiringInput
): Promise<AlayaDaemonRuntime> {
  return await finalizeAlayaDaemonRuntime({
    requestProtection: input.requestProtection,
    runtimeNotifier: input.runtimeNotifier,
    startupSteps: input.startupSteps,
    bootstrapMcpToolingInput: createBootstrapMcpToolingInput(input),
    attachSurfaceRegistrarInput: createAttachSurfaceRegistrarInput(input),
    mcpMemoryToolHandlerInput: createMcpMemoryToolHandlerInput(input),
    appInput: createDaemonAppInput(input),
    lifecycleControlsInput: createLifecycleControlsInput(input),
    serviceExports: createDaemonServiceExports(input)
  });
}

function createBootstrapMcpToolingInput(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    eventLogRepo: input.eventLogRepo,
    extensionDescriptorRepo: input.extensionDescriptorRepo,
    now: () => new Date().toISOString(),
    runtimeNotifier: input.runtimeNotifier,
    toolSpecService: input.toolSpecService,
    warnLogger: input.warnLogger
  };
}

function createAttachSurfaceRegistrarInput(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    surfaceService: input.surfaceService,
    warn: input.warnLogger.warn
  };
}

function createMcpMemoryToolHandlerInput(input: FinalizeDaemonRuntimeWiringInput) {
  const coRecallCoherenceGate = createCoRecallCoherenceGate(input);
  return {
    recallService: input.recallService,
    memoryService: input.memoryService,
    dynamicsService: {
      emitKarmaEvent: (emitInput: Parameters<typeof input.dynamicsService.emitKarmaEvent>[0]) =>
        input.dynamicsService.emitKarmaEvent(emitInput),
      emitKarmaEventInCurrentTransaction: (
        emitInput: Parameters<typeof input.dynamicsService.emitKarmaEventInCurrentTransaction>[0]
      ) => input.dynamicsService.emitKarmaEventInCurrentTransaction(emitInput)
    },
    memoryEntryRepo: input.memoryEntryRepo,
    evidenceService: input.evidenceService,
    pathRelationProposalService: input.pathRelationProposalService,
    ...(coRecallCoherenceGate === undefined ? {} : { coRecallCoherenceGate }),
    objectAnchorGate: input.pathRelationProposalService,
    synthesisEvidenceReader: createSynthesisEvidenceReader(input),
    synthesisMemberResolver: createSynthesisMemberResolver(input),
    signalService: input.signalService,
    graphExploreService: input.graphExploreService,
    edgeProposalService: input.edgeProposalService,
    graphEdgePort: input.graphEdgePort,
    sessionOverrideService: input.sessionOverrideService,
    trustStateRecorder: input.trustStateRecorder,
    eventPublisher: input.eventPublisher,
    asyncSideEffectAudit: { eventLogRepo: input.eventLogRepo, runtimeNotifier: input.runtimeNotifier },
    ...(input.gardenTaskRepo === undefined ? {} : { gardenTaskRepo: input.gardenTaskRepo }),
    edgeVerdictApplier: {
      applyVerdict: (verdictInput: Parameters<typeof input.edgeAutoProducerService.applyVerdict>[0]) =>
        input.edgeAutoProducerService.applyVerdict(verdictInput)
    },
    eventLogRepo: input.eventLogRepo,
    proposalRepo: input.proposalRepo,
    runtimeNotifier: input.runtimeNotifier,
    resolutionService: input.resolutionService,
    claimSourceReader: createClaimSourceReader(input)
  };
}

function createCoRecallCoherenceGate(input: FinalizeDaemonRuntimeWiringInput) {
  const embeddingRecallService = input.embeddingRecallService;
  if (embeddingRecallService === undefined) {
    return undefined;
  }

  return {
    coherentPairKeys: (
      workspaceId: string,
      deliveredObjectIds: readonly string[]
    ): Promise<ReadonlySet<string>> =>
      embeddingRecallService.coherentPairKeys({
        workspaceId,
        runId: null,
        objectIds: deliveredObjectIds,
        floor: 0.5
      })
  };
}

function createSynthesisEvidenceReader(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    findGistById: async (evidenceId: string, scopedWorkspaceId: string) => {
      const evidence = await input.evidenceService.findByIdScoped(evidenceId, scopedWorkspaceId);
      return evidence === null ? null : evidence.gist;
    }
  };
}

function createSynthesisMemberResolver(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    findMemberObjectIdsByEvidenceRefs: async (
      scopedWorkspaceId: string,
      evidenceRefs: readonly string[]
    ) => {
      const capsuleEvidence = new Set(evidenceRefs);
      const members = await input.memoryEntryRepo.findByEvidenceRefs(scopedWorkspaceId, evidenceRefs);
      return members
        .filter((member: { readonly evidence_refs: readonly string[] }) =>
          member.evidence_refs.every((ref: string) => capsuleEvidence.has(ref))
        )
        .map((member: { readonly object_id: string }) => member.object_id);
    }
  };
}

function createClaimSourceReader(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    findSourceObjectRefs: async (targetObjectId: string) => {
      const claim = await input.claimFormRepo.findById(targetObjectId);
      return claim === null ? null : claim.source_object_refs;
    }
  };
}

function createDaemonAppInput(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    ...createDaemonAppEnvironmentInput(input),
    ...createDaemonAppServiceInput(input)
  };
}

function createDaemonAppEnvironmentInput(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    requestProtection: input.requestProtection,
    remoteDaemonOptInEnabled: input.remoteDaemonOptInEnabled,
    principalCodingEngineAvailable: input.principalCodingAvailability.available,
    repoRoot: input.repoRoot,
    filesDirectory: input.filesDirectory,
    env: process.env,
    listServerHardConstraints: input.listServerHardConstraints,
    warn: input.warnLogger.warn
  };
}

function createDaemonAppServiceInput(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    workspaceService: input.securedWorkspaceService,
    engineBindingService: input.engineBindingService,
    workspaceGitBindingRepo: input.workspaceRepo,
    runService: input.runService,
    workerRunRepo: input.workerRunRepo,
    toolExecutionRecordRepo: input.toolExecutionRecordRepo,
    securityStatusService: input.securityStatusService,
    embeddingStatusService: input.embeddingStatusService,
    conversationService: input.conversationService,
    runHotStateService: input.runHotStateService,
    eventLogRepo: input.eventLogRepo,
    governanceLeaseService: input.governanceLeaseService,
    sessionOverrideService: input.sessionOverrideService,
    budgetBankruptcyService: input.budgetBankruptcyService,
    contextLensAssembler: input.contextLensAssembler,
    signalService: input.signalService,
    evidenceService: input.evidenceService,
    gardenBacklogTelemetryService: input.gardenBacklogTelemetryService,
    memoryService: input.memoryService,
    greenService: input.greenService,
    healthJournalService: input.healthJournalService,
    configService: input.configService,
    environmentStatusService: input.environmentStatusService,
    slotService: input.slotService,
    arbitrationService: input.arbitrationService,
    recallService: input.recallService,
    recallUtilizationService: input.recallUtilizationService,
    singleUsedAnchorEmitter: input.singleUsedAnchorEmitter,
    deliveryAnchorReader: input.deliveryAnchorReader,
    taskSurfaceBuilder: input.taskSurfaceBuilder,
    synthesisService: input.synthesisService,
    claimService: input.claimService,
    proposalService: input.proposalService,
    proposalRepo: input.proposalRepo,
    healthIssueGroupRepo: input.healthIssueGroupRepo,
    fileRepo: input.fileRepo,
    runtimeNotifier: input.runtimeNotifier,
    topologyAuditService: input.topologyAuditService,
    graphExploreService: input.graphExploreService,
    topologyService: input.topologyService,
    soulApprovalService: input.soulApprovalService,
    soulGraphService: input.soulGraphService,
    graphContractService: input.graphContractService,
    projectMappingService: input.projectMappingService,
    globalMemoryService: input.globalMemoryService
  };
}

function createLifecycleControlsInput(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    warnLogger: input.warnLogger,
    gardenBacklogTelemetryService: input.gardenBacklogTelemetryService,
    gardenRuntime: input.gardenRuntime,
    securityStatusService: input.securityStatusService,
    globalMemoryRecallInvalidationSubscription: input.globalMemoryRecallInvalidationSubscription,
    requestProtection: input.requestProtection,
    database: input.database,
    recallReadWorkerClient: input.recallReadWorkerClient,
    intervalsToClear: [input.pathRelationEvictionTimer]
  };
}

function createAnswersWithPairSourceExport(input: FinalizeDaemonRuntimeWiringInput) {
  const hqRepo = createOptionalMemoryHqRepo(input.database);
  return hqRepo === null ? {} : { answersWithPairSource: new HqAnswerOverlapPairSource(hqRepo) };
}

function createDaemonServiceExports(input: FinalizeDaemonRuntimeWiringInput) {
  return {
    environmentStatusService: input.environmentStatusService,
    embeddingStatusService: input.embeddingStatusService,
    embeddingProviderWarmup: input.embeddingProviderWarmup,
    getEmbeddingProviderDimensions: input.getEmbeddingProviderDimensions,
    ...(input.embeddingRecallService === undefined
      ? {}
      : { embeddingRecallService: input.embeddingRecallService }),
    ...createAnswersWithPairSourceExport(input),
    graphHealthService: input.graphHealthService,
    configService: input.configService,
    recallService: input.recallService,
    signalService: input.signalService,
    synthesisService: input.synthesisService,
    pathRelationProposalService: input.pathRelationProposalService,
    recallUtilizationService: input.recallUtilizationService,
    runService: input.runService,
    trustStateRecorder: input.trustStateRecorder,
    workspaceService: input.securedWorkspaceService,
    principalCodingEngineAvailable: input.principalCodingAvailability.available,
    gardenRuntime: input.gardenRuntime,
    initialGardenLastPassAt: input.initialGardenLastPassAt,
    gardenTaskRepo: input.gardenTaskRepo
  };
}
