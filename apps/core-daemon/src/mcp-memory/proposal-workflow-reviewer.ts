import {
  NonEmptyStringSchema,
  type SoulReviewMemoryProposalRequest
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "./tool-handler.js";
import { HUMAN_REVIEWER_AGENT_TARGETS, INSPECTOR_REVIEWER_AGENT_TARGET } from "./reviewer-surfaces.js";
import { constantTimeTokenEqual } from "../shared/constant-time-token.js";

export interface ReviewerIdentityBinding {
  readonly token: string;
  readonly identity: string;
}

export function assertReviewCallerIsAllowed(
  context: McpMemoryToolCallContext,
  binding: ReviewerIdentityBinding | undefined
): void {
  if (binding !== undefined) {
    return;
  }

  // The Inspector HTTP loopback asserts reviewer_identity over the network with
  // no token; without a configured binding it would forge the audit trail.
  if (context.agentTarget === INSPECTOR_REVIEWER_AGENT_TARGET) {
    throw createWorkflowError("VALIDATION", "reviewer binding not configured");
  }

  if (HUMAN_REVIEWER_AGENT_TARGETS.has(context.agentTarget)) {
    return;
  }

  throw createWorkflowError(
    "VALIDATION",
    "Review requires a human reviewer surface (Inspector/alaya review) or a configured reviewer token."
  );
}

export function resolveReviewerIdentity(
  input: SoulReviewMemoryProposalRequest,
  binding: ReviewerIdentityBinding | undefined
): string {
  if (binding === undefined) {
    return input.reviewer_identity;
  }
  if (!matchesReviewerToken(input.reviewer_token, binding.token)) {
    throw createWorkflowError("VALIDATION", "Invalid reviewer token.");
  }
  if (input.reviewer_identity !== binding.identity) {
    throw createWorkflowError("VALIDATION", "Reviewer identity does not match server-bound reviewer.");
  }
  return binding.identity;
}

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

function matchesReviewerToken(providedToken: string | undefined, expectedToken: string): boolean {
  if (providedToken === undefined || providedToken.length === 0) {
    return false;
  }
  return constantTimeTokenEqual(providedToken, expectedToken);
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

export function createWorkflowError(
  code: "NOT_FOUND" | "VALIDATION" | "NEEDS_CONTEXT",
  message: string
): Error & { readonly code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
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
