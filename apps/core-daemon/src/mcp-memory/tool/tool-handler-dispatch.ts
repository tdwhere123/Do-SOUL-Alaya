import {
  GardenClaimTaskRequestSchema,
  GardenClaimTaskResponseSchema,
  GardenCompleteTaskRequestSchema,
  GardenCompleteTaskResponseSchema,
  GardenListPendingTasksRequestSchema,
  GardenListPendingTasksResponseSchema,
  SoulApplyOverrideRequestSchema,
  SoulBatchReviewEdgeProposalsRequestSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulExploreGraphRequestSchema,
  SoulListPendingEdgeProposalsRequestSchema,
  SoulListPendingProposalsRequestSchema,
  SoulMemorySearchRequestSchema,
  SoulOpenPointerRequestSchema,
  SoulProposeEdgeRequestSchema,
  SoulProposeMemoryUpdateRequestSchema,
  SoulReportContextUsageRequestSchema,
  SoulReviewMemoryProposalRequestSchema,
  type SoulMemorySearchRequest,
  type SoulMemorySearchResponse,
  type SoulReportContextUsageRequest,
  type SoulReportContextUsageResponse
} from "@do-soul/alaya-protocol";
import type { AlayaMemoryToolName } from "./tool-catalog.js";
import {
  type GardenTaskOperations,
  type McpMemoryToolOperations
} from "./tool-handler-operations.js";
import { ok } from "./tool-handler-support.js";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolCallResult
} from "./tool-handler-types.js";

export function createMcpMemoryToolDispatcher(input: Readonly<{
  readonly gardenTasks: GardenTaskOperations;
  readonly recall: (
    request: SoulMemorySearchRequest,
    context: McpMemoryToolCallContext
  ) => Promise<SoulMemorySearchResponse>;
  readonly reportContextUsage: (
    request: SoulReportContextUsageRequest,
    context: McpMemoryToolCallContext
  ) => Promise<SoulReportContextUsageResponse>;
  readonly operations: McpMemoryToolOperations;
}>): Readonly<{
  dispatchToolCall(call: {
    readonly toolName: AlayaMemoryToolName;
    readonly rawArguments: unknown;
    readonly context: McpMemoryToolCallContext;
  }): Promise<McpMemoryToolCallResult>;
}> {
  return {
    dispatchToolCall: async ({ toolName, rawArguments, context }) => {
      switch (toolName) {
        case "soul.recall":
          return ok(toolName, await input.recall(SoulMemorySearchRequestSchema.parse(rawArguments), context));
        case "soul.open_pointer":
          return ok(toolName, await input.operations.openPointer(SoulOpenPointerRequestSchema.parse(rawArguments), context));
        case "soul.emit_candidate_signal":
          return ok(toolName, await input.operations.emitCandidateSignal(SoulEmitCandidateSignalRequestSchema.parse(rawArguments), context));
        case "soul.propose_memory_update":
          return ok(toolName, await input.operations.proposeMemoryUpdate(SoulProposeMemoryUpdateRequestSchema.parse(rawArguments), context));
        case "soul.review_memory_proposal":
          return ok(toolName, await input.operations.reviewMemoryProposal(SoulReviewMemoryProposalRequestSchema.parse(rawArguments), context));
        case "soul.list_pending_proposals":
          return ok(toolName, await input.operations.listPendingProposals(SoulListPendingProposalsRequestSchema.parse(rawArguments), context));
        case "soul.propose_edge":
          return ok(toolName, await input.operations.proposeEdge(SoulProposeEdgeRequestSchema.parse(rawArguments), context));
        case "soul.list_pending_edge_proposals":
          return ok(toolName, await input.operations.listPendingEdgeProposals(SoulListPendingEdgeProposalsRequestSchema.parse(rawArguments), context));
        case "soul.batch_review_edge_proposals":
          return ok(toolName, await input.operations.batchReviewEdgeProposals(SoulBatchReviewEdgeProposalsRequestSchema.parse(rawArguments), context));
        case "soul.apply_override":
          return ok(toolName, await input.operations.applyOverride(SoulApplyOverrideRequestSchema.parse(rawArguments), context));
        case "soul.explore_graph":
          return ok(toolName, await input.operations.exploreGraph(SoulExploreGraphRequestSchema.parse(rawArguments), context));
        case "soul.report_context_usage":
          return ok(toolName, await input.reportContextUsage(SoulReportContextUsageRequestSchema.parse(rawArguments), context));
        case "soul.resolve":
          return ok(toolName, await input.operations.resolveStagedWarning(rawArguments, context));
        case "garden.list_pending_tasks":
          return ok(
            toolName,
            GardenListPendingTasksResponseSchema.parse(
              await input.gardenTasks.listPendingGardenTasks(
                GardenListPendingTasksRequestSchema.parse(rawArguments),
                context
              )
            )
          );
        case "garden.claim_task":
          return ok(
            toolName,
            GardenClaimTaskResponseSchema.parse(
              await input.gardenTasks.claimGardenTask(
                GardenClaimTaskRequestSchema.parse(rawArguments),
                context
              )
            )
          );
        case "garden.complete_task":
          return ok(
            toolName,
            GardenCompleteTaskResponseSchema.parse(
              await input.gardenTasks.completeGardenTask(
                GardenCompleteTaskRequestSchema.parse(rawArguments),
                context
              )
            )
          );
      }
    }
  };
}
