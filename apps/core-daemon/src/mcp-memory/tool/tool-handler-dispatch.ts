import {
  GardenClaimTaskResponseSchema,
  GardenCompleteTaskResponseSchema,
  GardenListPendingTasksResponseSchema,
  type GardenClaimTaskRequest,
  type GardenCompleteTaskRequest,
  type GardenListPendingTasksRequest,
  type SoulApplyOverrideRequest,
  type SoulBatchReviewEdgeProposalsRequest,
  type SoulEmitCandidateSignalRequest,
  type SoulExploreGraphRequest,
  type SoulListPendingEdgeProposalsRequest,
  type SoulListPendingProposalsRequest,
  type SoulMemorySearchRequest,
  type SoulMemorySearchResponse,
  type SoulOpenPointerRequest,
  type SoulProposeEdgeRequest,
  type SoulProposeMemoryUpdateRequest,
  type SoulReportContextUsageRequest,
  type SoulReportContextUsageResponse,
  type SoulReviewMemoryProposalRequest
} from "@do-soul/alaya-protocol";
import { soulToolDefs } from "@do-soul/alaya-engine-gateway";
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

const soulToolSpecByName = new Map(soulToolDefs.map((spec) => [spec.name, spec] as const));

type ToolInvoker = (
  parsedArguments: unknown,
  context: McpMemoryToolCallContext
) => Promise<McpMemoryToolCallResult>;

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
  const invokeByName: Record<AlayaMemoryToolName, ToolInvoker> = {
    "soul.recall": async (parsed, context) =>
      ok("soul.recall", await input.recall(parsed as SoulMemorySearchRequest, context)),
    "soul.open_pointer": async (parsed, context) =>
      ok("soul.open_pointer", await input.operations.openPointer(parsed as SoulOpenPointerRequest, context)),
    "soul.emit_candidate_signal": async (parsed, context) =>
      ok(
        "soul.emit_candidate_signal",
        await input.operations.emitCandidateSignal(parsed as SoulEmitCandidateSignalRequest, context)
      ),
    "soul.propose_memory_update": async (parsed, context) =>
      ok(
        "soul.propose_memory_update",
        await input.operations.proposeMemoryUpdate(parsed as SoulProposeMemoryUpdateRequest, context)
      ),
    "soul.review_memory_proposal": async (parsed, context) =>
      ok(
        "soul.review_memory_proposal",
        await input.operations.reviewMemoryProposal(parsed as SoulReviewMemoryProposalRequest, context)
      ),
    "soul.list_pending_proposals": async (parsed, context) =>
      ok(
        "soul.list_pending_proposals",
        await input.operations.listPendingProposals(parsed as SoulListPendingProposalsRequest, context)
      ),
    "soul.propose_edge": async (parsed, context) =>
      ok("soul.propose_edge", await input.operations.proposeEdge(parsed as SoulProposeEdgeRequest, context)),
    "soul.list_pending_edge_proposals": async (parsed, context) =>
      ok(
        "soul.list_pending_edge_proposals",
        await input.operations.listPendingEdgeProposals(parsed as SoulListPendingEdgeProposalsRequest, context)
      ),
    "soul.batch_review_edge_proposals": async (parsed, context) =>
      ok(
        "soul.batch_review_edge_proposals",
        await input.operations.batchReviewEdgeProposals(parsed as SoulBatchReviewEdgeProposalsRequest, context)
      ),
    "soul.apply_override": async (parsed, context) =>
      ok("soul.apply_override", await input.operations.applyOverride(parsed as SoulApplyOverrideRequest, context)),
    "soul.explore_graph": async (parsed, context) =>
      ok("soul.explore_graph", await input.operations.exploreGraph(parsed as SoulExploreGraphRequest, context)),
    "soul.report_context_usage": async (parsed, context) =>
      ok(
        "soul.report_context_usage",
        await input.reportContextUsage(parsed as SoulReportContextUsageRequest, context)
      ),
    "soul.resolve": async (parsed, context) =>
      ok("soul.resolve", await input.operations.resolveStagedWarning(parsed, context)),
    "garden.list_pending_tasks": async (parsed, context) =>
      ok(
        "garden.list_pending_tasks",
        GardenListPendingTasksResponseSchema.parse(
          await input.gardenTasks.listPendingGardenTasks(parsed as GardenListPendingTasksRequest, context)
        )
      ),
    "garden.claim_task": async (parsed, context) =>
      ok(
        "garden.claim_task",
        GardenClaimTaskResponseSchema.parse(
          await input.gardenTasks.claimGardenTask(parsed as GardenClaimTaskRequest, context)
        )
      ),
    "garden.complete_task": async (parsed, context) =>
      ok(
        "garden.complete_task",
        GardenCompleteTaskResponseSchema.parse(
          await input.gardenTasks.completeGardenTask(parsed as GardenCompleteTaskRequest, context)
        )
      )
  };

  for (const spec of soulToolDefs) {
    const name = spec.name as AlayaMemoryToolName;
    if (invokeByName[name] === undefined) {
      throw new Error(`Dispatcher missing ${spec.name}`);
    }
  }

  return {
    dispatchToolCall: async ({ toolName, rawArguments, context }) => {
      const spec = soulToolSpecByName.get(toolName);
      if (spec === undefined) {
        throw new Error(`Missing soul tool spec: ${toolName}`);
      }
      const invoke = invokeByName[toolName];
      return await invoke(spec.parametersSchema.parse(rawArguments), context);
    }
  };
}
