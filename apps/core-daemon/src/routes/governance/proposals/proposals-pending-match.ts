import { randomUUID } from "node:crypto";
import { HTTP_REVIEWER_AGENT_TARGET } from "../../../mcp-memory/proposal/reviewer-surfaces.js";
import type { ProposalRouteServices } from "./proposals-types.js";

export function createHttpReviewerToolContext(workspaceId: string) {
  return {
    workspaceId,
    runId: null,
    agentTarget: HTTP_REVIEWER_AGENT_TARGET,
    sessionId: `${HTTP_REVIEWER_AGENT_TARGET}-${randomUUID()}`
  };
}

export async function findExistingPendingMatch(
  services: ProposalRouteServices,
  input: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly proposed_changes: Record<string, unknown>;
  }
): Promise<string | null> {
  // Query the repository directly without a 100-row cap so older pending proposals
  // are still deduplicated.
  const proposals = await services.proposalRepo.findPendingSummaries(input.workspaceId);
  const targetKey = canonicalizeChanges(input.proposed_changes);
  for (const proposal of proposals) {
    if (proposal.target_object_id !== input.memoryId) continue;
    if (proposal.proposed_changes === null) continue;
    if (canonicalizeChanges(proposal.proposed_changes) === targetKey) {
      return proposal.proposal_id;
    }
  }
  return null;
}

function canonicalizeChanges(value: Record<string, unknown>): string {
  const sortedKeys = Object.keys(value).sort();
  return JSON.stringify(sortedKeys.map((key) => [key, value[key]]));
}
