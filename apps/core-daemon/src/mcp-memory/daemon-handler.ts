import {
  createMcpMemoryProposalWorkflow,
  SourceDeliveryAnchorValidationError,
  type McpMemoryProposalWorkflowDependencies,
  type McpMemoryProposalWorkflowEventLogRepo,
  type McpMemoryProposalWorkflowProposalRepo,
  type McpMemoryProposalWorkflowRuntimeNotifier,
  type ReviewerIdentityBinding
} from "./proposal-workflow.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "./tool-handler.js";
import {
  createSoulResolveHandler,
  type SoulResolveHandlerDependencies
} from "./resolve-handler.js";

export interface DaemonMcpMemoryToolHandlerInput {
  readonly zeroDayToolAccess: NonNullable<McpMemoryToolHandlerDependencies["zeroDayToolAccess"]>;
  readonly recallService: McpMemoryToolHandlerDependencies["recallService"];
  readonly memoryService: McpMemoryToolHandlerDependencies["memoryService"];
  readonly dynamicsService?: McpMemoryToolHandlerDependencies["dynamicsService"];
  readonly memoryEntryRepo: NonNullable<McpMemoryToolHandlerDependencies["memoryEntryRepo"]>;
  readonly evidenceService?: McpMemoryToolHandlerDependencies["evidenceService"];
  readonly pathRelationProposalService?: McpMemoryToolHandlerDependencies["pathRelationProposalService"];
  // invariant: co-recall accrues only for semantically coherent delivered pairs.
  // see also: mcp-memory/tool-handler.ts coRecallCoherenceGate.
  readonly coRecallCoherenceGate?: McpMemoryToolHandlerDependencies["coRecallCoherenceGate"];
  // invariant: path-relation proposal accept must validate object anchors before the storage insert.
  // see also: apps/core-daemon/src/mcp-memory/proposal-workflow.ts objectAnchorGate
  readonly objectAnchorGate?: McpMemoryProposalWorkflowDependencies["objectAnchorGate"];
  // invariant: reads member evidence gists so the synthesis-create accept-apply
  // can distill a deterministic NO-LLM summary and validate cluster evidence
  // exists before the durable insert. Wired from EvidenceService.findByIdScoped.
  // see also: apps/core-daemon/src/mcp-memory/proposal-workflow.ts synthesisEvidenceReader
  readonly synthesisEvidenceReader?: McpMemoryProposalWorkflowDependencies["synthesisEvidenceReader"];
  // invariant: resolves the cluster's member memories at capsule-build time so
  // source_memory_refs is populated (the compress arm earns the `compressed`
  // disposition only for a listed member). Wired from memoryEntryRepo.findByEvidenceRefs.
  // see also: apps/core-daemon/src/mcp-memory/proposal-workflow.ts synthesisMemberResolver
  readonly synthesisMemberResolver?: McpMemoryProposalWorkflowDependencies["synthesisMemberResolver"];
  readonly signalService: McpMemoryToolHandlerDependencies["signalService"];
  readonly graphExploreService: McpMemoryToolHandlerDependencies["graphExploreService"];
  readonly edgeProposalService?: McpMemoryToolHandlerDependencies["edgeProposalService"];
  readonly graphEdgePort?: McpMemoryToolHandlerDependencies["graphEdgePort"];
  readonly sessionOverrideService: McpMemoryToolHandlerDependencies["sessionOverrideService"];
  readonly trustStateRecorder: McpMemoryToolHandlerDependencies["trustStateRecorder"];
  readonly eventPublisher: NonNullable<McpMemoryToolHandlerDependencies["eventPublisher"]>;
  readonly asyncSideEffectAudit?: McpMemoryToolHandlerDependencies["asyncSideEffectAudit"];
  readonly gardenTaskRepo?: McpMemoryToolHandlerDependencies["gardenTaskRepo"];
  // invariant: applies a host-worker EDGE_CLASSIFY verdict to the existing
  // heuristic path. see also: mcp-memory/tool-handler.ts completeEdgeClassifyTask.
  readonly edgeVerdictApplier?: McpMemoryToolHandlerDependencies["edgeVerdictApplier"];
  readonly eventLogRepo: McpMemoryProposalWorkflowEventLogRepo;
  readonly proposalRepo: McpMemoryProposalWorkflowProposalRepo;
  readonly runtimeNotifier: McpMemoryProposalWorkflowRuntimeNotifier;
  readonly reviewerIdentityBinding?: ReviewerIdentityBinding;
  readonly attachSurfaceRegistrar?: McpMemoryToolHandlerDependencies["attachSurfaceRegistrar"];
  // invariant: ResolutionService is required so soul.resolve is
  // routable from every attached agent. The handler binds workspace
  // and delivery scope from the trusted MCP call context before
  // dispatching to the service.
  readonly resolutionService: SoulResolveHandlerDependencies["resolutionService"];
  // invariant: indirect scope check resolver. Reads a claim's
  // source_object_refs so the resolve handler can authorise
  // claim_form resolutions through the memory_entry rows that recall
  // actually delivered.
  // see also: apps/core-daemon/src/mcp-memory/resolve-handler.ts
  //   assertDeliveryInScope
  readonly claimSourceReader?: SoulResolveHandlerDependencies["claimSourceReader"];
}

function buildSoulResolveHandler(
  input: Pick<
    DaemonMcpMemoryToolHandlerInput,
    "resolutionService" | "trustStateRecorder" | "claimSourceReader"
  >
) {
  return createSoulResolveHandler({
    resolutionService: input.resolutionService,
    trustStateRecorder: {
      findDeliveryById: async (deliveryId) => {
        const delivery = await input.trustStateRecorder.findDeliveryById(deliveryId);
        if (delivery === null) {
          return null;
        }
        return {
          delivery_id: delivery.delivery_id,
          agent_target: delivery.agent_target,
          workspace_id: delivery.workspace_id,
          run_id: delivery.run_id,
          delivered_object_ids: delivery.delivered_object_ids,
          ...(delivery.delivered_objects === undefined
            ? {}
            : { delivered_objects: delivery.delivered_objects })
        };
      }
    },
    ...(input.claimSourceReader === undefined
      ? {}
      : { claimSourceReader: input.claimSourceReader })
  });
}

function buildDaemonMcpMemoryProposalWorkflow(
  input: Pick<
    DaemonMcpMemoryToolHandlerInput,
    | "eventLogRepo"
    | "proposalRepo"
    | "runtimeNotifier"
    | "memoryService"
    | "trustStateRecorder"
    | "objectAnchorGate"
    | "synthesisEvidenceReader"
    | "synthesisMemberResolver"
    | "dynamicsService"
  >,
  reviewerIdentityBinding: ReviewerIdentityBinding | undefined
) {
  return createMcpMemoryProposalWorkflow({
    eventLogRepo: input.eventLogRepo,
    proposalRepo: input.proposalRepo,
    runtimeNotifier: input.runtimeNotifier,
    memoryService: input.memoryService,
    sourceDeliveryAnchorValidator: {
      validate: async (sourceDeliveryIds, context) => {
        for (const deliveryId of sourceDeliveryIds) {
          const delivery = await input.trustStateRecorder.findDeliveryById(deliveryId);
          if (
            delivery === null ||
            delivery.agent_target !== context.agentTarget ||
            delivery.workspace_id !== context.workspaceId ||
            delivery.run_id !== context.runId
          ) {
            throw new SourceDeliveryAnchorValidationError(
              `source_delivery_ids contains an unknown or out-of-scope delivery_id: ${deliveryId}`
            );
          }
        }
      }
    },
    ...(input.objectAnchorGate === undefined ? {} : { objectAnchorGate: input.objectAnchorGate }),
    ...(input.synthesisEvidenceReader === undefined
      ? {}
      : { synthesisEvidenceReader: input.synthesisEvidenceReader }),
    ...(input.synthesisMemberResolver === undefined
      ? {}
      : { synthesisMemberResolver: input.synthesisMemberResolver }),
    ...(input.dynamicsService === undefined ? {} : { dynamicsService: input.dynamicsService }),
    ...(reviewerIdentityBinding === undefined ? {} : { reviewerIdentityBinding })
  });
}

export function createDaemonMcpMemoryToolHandler(input: DaemonMcpMemoryToolHandlerInput) {
  const reviewerIdentityBinding =
    input.reviewerIdentityBinding ?? createReviewerIdentityBindingFromEnv(process.env);
  const soulResolveHandler = buildSoulResolveHandler(input);
  return createMcpMemoryToolHandler({
    zeroDayToolAccess: input.zeroDayToolAccess,
    recallService: input.recallService,
    memoryService: input.memoryService,
    ...(input.dynamicsService === undefined ? {} : { dynamicsService: input.dynamicsService }),
    memoryEntryRepo: input.memoryEntryRepo,
    ...(input.evidenceService === undefined ? {} : { evidenceService: input.evidenceService }),
    ...(input.pathRelationProposalService === undefined
      ? {}
      : { pathRelationProposalService: input.pathRelationProposalService }),
    ...(input.coRecallCoherenceGate === undefined
      ? {}
      : { coRecallCoherenceGate: input.coRecallCoherenceGate }),
    signalService: input.signalService,
    graphExploreService: input.graphExploreService,
    ...(input.edgeProposalService === undefined ? {} : { edgeProposalService: input.edgeProposalService }),
    ...(reviewerIdentityBinding === undefined ? {} : { reviewerIdentityBinding }),
    ...(input.graphEdgePort === undefined ? {} : { graphEdgePort: input.graphEdgePort }),
    sessionOverrideService: input.sessionOverrideService,
    trustStateRecorder: input.trustStateRecorder,
    eventPublisher: input.eventPublisher,
    ...(input.asyncSideEffectAudit === undefined ? {} : { asyncSideEffectAudit: input.asyncSideEffectAudit }),
    ...(input.gardenTaskRepo === undefined ? {} : { gardenTaskRepo: input.gardenTaskRepo }),
    ...(input.edgeVerdictApplier === undefined ? {} : { edgeVerdictApplier: input.edgeVerdictApplier }),
    ...(input.attachSurfaceRegistrar === undefined
      ? {}
      : { attachSurfaceRegistrar: input.attachSurfaceRegistrar }),
    soulResolveHandler,
    proposalWorkflow: buildDaemonMcpMemoryProposalWorkflow(input, reviewerIdentityBinding)
  });
}

export function createReviewerIdentityBindingFromEnv(
  env: NodeJS.ProcessEnv
): ReviewerIdentityBinding | undefined {
  const token = env.ALAYA_REVIEWER_TOKEN?.trim();
  const identity = env.ALAYA_REVIEWER_IDENTITY?.trim();
  if ((token === undefined || token.length === 0) && (identity === undefined || identity.length === 0)) {
    return undefined;
  }
  if (token === undefined || token.length === 0 || identity === undefined || identity.length === 0) {
    throw new Error("ALAYA_REVIEWER_TOKEN and ALAYA_REVIEWER_IDENTITY must be configured together.");
  }
  return Object.freeze({ token, identity });
}
