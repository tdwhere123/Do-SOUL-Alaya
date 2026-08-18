import { constantTimeTokenEqual } from "../../shared/constant-time-token.js";
import { createWorkflowError } from "../tool/mcp-tool-error.js";
import type { McpMemoryToolCallContext } from "../tool/tool-handler-types.js";
import { HUMAN_REVIEWER_AGENT_TARGETS, INSPECTOR_REVIEWER_AGENT_TARGET } from "./reviewer-surfaces.js";

export interface ReviewerIdentityBinding {
  readonly token: string;
  readonly identity: string;
}

export interface ReviewerTokenInput {
  readonly reviewer_identity: string;
  readonly reviewer_token?: string;
}

export function assertReviewCallerIsAllowed(
  context: McpMemoryToolCallContext,
  binding: ReviewerIdentityBinding | undefined
): void {
  // The Inspector HTTP loopback asserts reviewer_identity over the network with
  // no token; without a configured binding it would forge the audit trail.
  if (context.agentTarget === INSPECTOR_REVIEWER_AGENT_TARGET) {
    if (binding === undefined) {
      throw createWorkflowError("VALIDATION", "reviewer binding not configured");
    }
    return;
  }

  if (HUMAN_REVIEWER_AGENT_TARGETS.has(context.agentTarget)) {
    return;
  }

  throw createWorkflowError(
    "VALIDATION",
    "Review requires a human reviewer surface (Inspector/alaya review); attached agents cannot review."
  );
}

export function resolveReviewerIdentity(
  input: ReviewerTokenInput,
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

export function matchesReviewerToken(
  providedToken: string | undefined,
  expectedToken: string
): boolean {
  if (providedToken === undefined || providedToken.length === 0) {
    return false;
  }
  return constantTimeTokenEqual(providedToken, expectedToken);
}
