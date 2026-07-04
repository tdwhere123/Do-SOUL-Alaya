import { randomUUID } from "node:crypto";
import type { ProposalRouteServices } from "./proposals-types.js";

export function createInspectorToolContext(workspaceId: string) {
  return { workspaceId, runId: null, agentTarget: "inspector", sessionId: `inspector-${randomUUID()}` };
}

export async function findExistingPendingMatch(
  services: ProposalRouteServices,
  input: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly proposed_changes: Record<string, unknown>;
  }
): Promise<string | null> {
  const result = await services.mcpMemoryToolHandler.call({
    toolName: "soul.list_pending_proposals",
    arguments: { limit: 100 },
    context: {
      workspaceId: input.workspaceId,
      runId: null,
      agentTarget: "inspector",
      sessionId: `inspector-${randomUUID()}`
    }
  });
  if (!result.ok) return null;
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
  if (proposals.length === 0) return null;
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
