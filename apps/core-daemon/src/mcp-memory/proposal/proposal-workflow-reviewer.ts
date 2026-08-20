import { NonEmptyStringSchema } from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "../tool/tool-handler.js";
import { createWorkflowError } from "../tool/mcp-tool-error.js";
import { HUMAN_REVIEWER_AGENT_TARGETS } from "./reviewer-surfaces.js";
export {
  assertReviewCallerIsAllowed,
  resolveReviewerIdentity,
  type ReviewerIdentityBinding
} from "./reviewer-gating.js";
export { createWorkflowError } from "../tool/mcp-tool-error.js";

export function assertReviewerAssignment(
  scopedProposal: Readonly<{
    readonly reviewer_assignment?: Readonly<{ readonly reviewer_identity: string }> | null;
  }>,
  reviewerIdentity: string
): void {
  const assignment = scopedProposal.reviewer_assignment ?? null;
  if (assignment !== null && assignment.reviewer_identity !== reviewerIdentity) {
    throw createWorkflowError("VALIDATION", "Proposal is assigned to a different reviewer.");
  }
}

export function assertProposalContext(
  scopedProposal: Readonly<{
    readonly workspace_id: string;
    readonly run_id: string | null;
  }>,
  context: McpMemoryToolCallContext
): void {
  const workspaceId = NonEmptyStringSchema.parse(context.workspaceId);
  if (scopedProposal.workspace_id !== workspaceId) {
    throw createWorkflowError("NOT_FOUND", "Proposal not found in current workspace/run context.");
  }
  const isHumanReviewerSurface = HUMAN_REVIEWER_AGENT_TARGETS.has(context.agentTarget);
  if (context.runId === null && isHumanReviewerSurface) {
    return;
  }
  if (context.runId === null) {
    if (scopedProposal.run_id !== null) {
      throw createWorkflowError(
        "NOT_FOUND",
        "Proposal not found in current workspace/run context."
      );
    }
    return;
  }
  const runId = NonEmptyStringSchema.parse(context.runId);
  if (scopedProposal.run_id !== runId) {
    throw createWorkflowError("NOT_FOUND", "Proposal not found in current workspace/run context.");
  }
}

export function normalizeResolutionError(error: unknown): unknown {
  if (error instanceof Error && "code" in error && error.code === "CONFLICT") {
    return createWorkflowError("VALIDATION", error.message);
  }
  if (error instanceof Error && "code" in error && error.code === "VALIDATION_FAILED") {
    return createWorkflowError("VALIDATION", error.message);
  }
  return error;
}
