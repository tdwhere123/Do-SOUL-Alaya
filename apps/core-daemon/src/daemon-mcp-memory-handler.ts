import {
  createMcpMemoryProposalWorkflow,
  SourceDeliveryAnchorValidationError,
  type McpMemoryProposalWorkflowEventLogRepo,
  type McpMemoryProposalWorkflowProposalRepo,
  type McpMemoryProposalWorkflowRuntimeNotifier,
  type ReviewerIdentityBinding
} from "./mcp-memory-proposal-workflow.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "./mcp-memory-tool-handler.js";

export function createDaemonMcpMemoryToolHandler(input: {
  readonly recallService: McpMemoryToolHandlerDependencies["recallService"];
  readonly memoryService: McpMemoryToolHandlerDependencies["memoryService"];
  readonly memoryEntryRepo: NonNullable<McpMemoryToolHandlerDependencies["memoryEntryRepo"]>;
  readonly evidenceService?: McpMemoryToolHandlerDependencies["evidenceService"];
  readonly pathRelationProposalService?: McpMemoryToolHandlerDependencies["pathRelationProposalService"];
  readonly signalService: McpMemoryToolHandlerDependencies["signalService"];
  readonly graphExploreService: McpMemoryToolHandlerDependencies["graphExploreService"];
  readonly graphEdgePort?: McpMemoryToolHandlerDependencies["graphEdgePort"];
  readonly sessionOverrideService: McpMemoryToolHandlerDependencies["sessionOverrideService"];
  readonly trustStateRecorder: McpMemoryToolHandlerDependencies["trustStateRecorder"];
  readonly eventPublisher: NonNullable<McpMemoryToolHandlerDependencies["eventPublisher"]>;
  readonly gardenTaskRepo?: McpMemoryToolHandlerDependencies["gardenTaskRepo"];
  readonly eventLogRepo: McpMemoryProposalWorkflowEventLogRepo;
  readonly proposalRepo: McpMemoryProposalWorkflowProposalRepo;
  readonly runtimeNotifier: McpMemoryProposalWorkflowRuntimeNotifier;
  readonly reviewerIdentityBinding?: ReviewerIdentityBinding;
}) {
  return createMcpMemoryToolHandler({
    recallService: input.recallService,
    memoryService: input.memoryService,
    memoryEntryRepo: input.memoryEntryRepo,
    ...(input.evidenceService === undefined ? {} : { evidenceService: input.evidenceService }),
    ...(input.pathRelationProposalService === undefined
      ? {}
      : { pathRelationProposalService: input.pathRelationProposalService }),
    signalService: input.signalService,
    graphExploreService: input.graphExploreService,
    ...(input.graphEdgePort === undefined ? {} : { graphEdgePort: input.graphEdgePort }),
    sessionOverrideService: input.sessionOverrideService,
    trustStateRecorder: input.trustStateRecorder,
    eventPublisher: input.eventPublisher,
    ...(input.gardenTaskRepo === undefined ? {} : { gardenTaskRepo: input.gardenTaskRepo }),
    proposalWorkflow: createMcpMemoryProposalWorkflow({
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
      reviewerIdentityBinding:
        input.reviewerIdentityBinding ?? createReviewerIdentityBindingFromEnv(process.env)
    })
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
