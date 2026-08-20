import type {
  MemoryEntryMutableFields,
  Proposal
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "../../tool/tool-handler-types.js";
import type { McpMemoryProposalWorkflowDependencies } from "../proposal-workflow.js";

export async function prepareAcceptedMemoryUpdate(input: Readonly<{
  readonly deps: McpMemoryProposalWorkflowDependencies;
  readonly scopedProposal: Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly target_object_id?: string | null;
    readonly proposed_changes?: Readonly<MemoryEntryMutableFields> | null;
    readonly target_baseline_updated_at?: string | null;
  }>;
  readonly context: McpMemoryToolCallContext;
  readonly resolveTarget: () => string;
  readonly resolveChanges: () => Readonly<MemoryEntryMutableFields>;
  readonly createError: (code: "NOT_FOUND" | "NEEDS_CONTEXT", message: string) => Error;
}>): Promise<Readonly<{
  readonly kind: "memory_update";
  readonly memoryUpdate: Readonly<{
    readonly target_object_id: string;
    readonly workspace_id: string;
    readonly proposed_changes: Readonly<MemoryEntryMutableFields>;
    readonly caused_by: string;
    readonly expected_baseline_updated_at: string | null;
  }>;
}>> {
  const memoryService = input.deps.memoryService;
  if (memoryService === undefined || memoryService.validateUpdate === undefined) {
    throw input.createError(
      "NEEDS_CONTEXT",
      "Atomic memory update validation and apply ports are unavailable."
    );
  }
  const targetObjectId = input.resolveTarget();
  const proposedChanges = input.resolveChanges();
  const target = await memoryService.findByIdScoped(targetObjectId, input.context.workspaceId);
  if (target === null) {
    throw input.createError("NOT_FOUND", `Target memory object not found: ${targetObjectId}`);
  }
  await memoryService.validateUpdate(targetObjectId, proposedChanges);
  return {
    kind: "memory_update",
    memoryUpdate: {
      target_object_id: targetObjectId,
      workspace_id: input.context.workspaceId,
      proposed_changes: proposedChanges,
      caused_by: `proposal_accept:${input.scopedProposal.proposal.proposal_id}`,
      expected_baseline_updated_at: input.scopedProposal.target_baseline_updated_at ?? null
    }
  };
}
