import type { McpMemoryToolCallContext } from "./tool-handler-types.js";
import type { McpMemoryProposalWorkflowDependencies } from "./proposal-workflow.js";

type ScopedProposal = NonNullable<
  Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
>;

export async function emitProposalReviewKarma(
  deps: McpMemoryProposalWorkflowDependencies,
  scopedProposal: ScopedProposal,
  verdict: "accept" | "reject",
  context: McpMemoryToolCallContext
): Promise<void> {
  if (deps.dynamicsService === undefined) {
    return;
  }
  if (scopedProposal.target_object_kind !== "memory_entry") {
    return;
  }

  const targetObjectId =
    scopedProposal.target_object_id ?? scopedProposal.proposal.derived_from ?? null;
  if (targetObjectId === null || targetObjectId.length === 0) {
    return;
  }

  await deps.dynamicsService.emitKarmaEvent({
    kind: verdict === "accept" ? "accept_gain" : "reject_penalty",
    objectId: targetObjectId,
    workspaceId: context.workspaceId,
    runId: context.runId
  });
}
