import type { EventLogEntry } from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "./tool-handler-types.js";
import type { McpMemoryProposalWorkflowDependencies } from "./proposal-workflow.js";

type ScopedProposal = NonNullable<
  Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
>;

export interface ProposalReviewKarmaMutation {
  readonly applySynchronousResolutionMutation: () => readonly ProposalResolutionEventInput[];
  readonly afterCommit: () => void;
}

type ProposalResolutionEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export function buildProposalReviewKarmaMutation(
  deps: McpMemoryProposalWorkflowDependencies,
  scopedProposal: ScopedProposal,
  verdict: "accept" | "reject",
  context: McpMemoryToolCallContext
): ProposalReviewKarmaMutation | undefined {
  const dynamicsService = deps.dynamicsService;
  if (dynamicsService === undefined) {
    return undefined;
  }
  if (scopedProposal.target_object_kind !== "memory_entry") {
    return undefined;
  }

  const targetObjectId =
    scopedProposal.target_object_id ?? scopedProposal.proposal.derived_from ?? null;
  if (targetObjectId === null || targetObjectId.length === 0) {
    return undefined;
  }

  let afterCommit: (() => void) | undefined;
  return {
    applySynchronousResolutionMutation: () => {
      const mutation = dynamicsService.emitKarmaEventInCurrentTransaction({
        kind: verdict === "accept" ? "accept_gain" : "reject_penalty",
        objectId: targetObjectId,
        workspaceId: context.workspaceId,
        runId: context.runId
      });
      afterCommit = mutation.afterCommit;
      return mutation.events;
    },
    afterCommit: () => afterCommit?.()
  };
}
