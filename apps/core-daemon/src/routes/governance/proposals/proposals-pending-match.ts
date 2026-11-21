import { randomUUID } from "node:crypto";
import type { PublicToolError } from "@do-soul/alaya-protocol";
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

export type PendingMatchResult =
  | { readonly ok: true; readonly proposalId: string | null }
  | { readonly ok: false; readonly error: PublicToolError };

export async function findExistingPendingMatch(
  services: ProposalRouteServices,
  input: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly proposed_changes: Record<string, unknown>;
  }
): Promise<PendingMatchResult> {
  const result = await services.mcpMemoryToolHandler.call({
    toolName: "soul.list_pending_proposals",
    arguments: { limit: 100 },
    context: createHttpReviewerToolContext(input.workspaceId)
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const output = result.output as
    | {
        readonly proposals?: ReadonlyArray<{
          readonly proposal_id: string;
          readonly target_object_id: string;
          readonly proposed_changes: Record<string, unknown> | null;
        }>;
      }
    | null
    | undefined;
  const proposals = output?.proposals ?? [];
  if (proposals.length === 0) return { ok: true, proposalId: null };
  const targetKey = canonicalizeChanges(input.proposed_changes);
  for (const proposal of proposals) {
    if (proposal.target_object_id !== input.memoryId) continue;
    if (proposal.proposed_changes === null) continue;
    if (canonicalizeChanges(proposal.proposed_changes) === targetKey) {
      return { ok: true, proposalId: proposal.proposal_id };
    }
  }
  return { ok: true, proposalId: null };
}

function canonicalizeChanges(value: Record<string, unknown>): string {
  const sortedKeys = Object.keys(value).sort();
  return JSON.stringify(sortedKeys.map((key) => [key, value[key]]));
}
