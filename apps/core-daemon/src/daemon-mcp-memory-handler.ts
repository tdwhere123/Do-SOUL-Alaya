import {
  createMcpMemoryProposalWorkflow,
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
  readonly signalService: McpMemoryToolHandlerDependencies["signalService"];
  readonly graphExploreService: McpMemoryToolHandlerDependencies["graphExploreService"];
  readonly sessionOverrideService: McpMemoryToolHandlerDependencies["sessionOverrideService"];
  readonly trustStateRecorder: McpMemoryToolHandlerDependencies["trustStateRecorder"];
  readonly eventLogRepo: McpMemoryProposalWorkflowEventLogRepo;
  readonly proposalRepo: McpMemoryProposalWorkflowProposalRepo;
  readonly runtimeNotifier: McpMemoryProposalWorkflowRuntimeNotifier;
  readonly reviewerIdentityBinding?: ReviewerIdentityBinding;
}) {
  return createMcpMemoryToolHandler({
    recallService: input.recallService,
    memoryService: input.memoryService,
    signalService: input.signalService,
    graphExploreService: input.graphExploreService,
    sessionOverrideService: input.sessionOverrideService,
    trustStateRecorder: input.trustStateRecorder,
    proposalWorkflow: createMcpMemoryProposalWorkflow({
      eventLogRepo: input.eventLogRepo,
      proposalRepo: input.proposalRepo,
      runtimeNotifier: input.runtimeNotifier,
      memoryService: input.memoryService,
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
