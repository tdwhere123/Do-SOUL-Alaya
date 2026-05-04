import {
  createMcpMemoryProposalWorkflow,
  type McpMemoryProposalWorkflowEventLogRepo,
  type McpMemoryProposalWorkflowProposalRepo,
  type McpMemoryProposalWorkflowRuntimeNotifier
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
      runtimeNotifier: input.runtimeNotifier
    })
  });
}
