import type { PathCandidateSink } from "@do-soul/alaya-core";
import type { EdgeProposalReconcilePort } from "../garden/runtime-types.js";

type Warn = (message: string, meta: Record<string, unknown>) => void;

type WorkspaceListPort = Readonly<{
  list(): Promise<readonly Readonly<{ readonly workspace_id: string; readonly workspace_state?: string }>[]>
}>;

export function createGardenLegacyPathCandidateRejectionPort(warn: Warn): PathCandidateSink {
  const sink: PathCandidateSink = {
    submitCandidate: async (candidateInput) => {
      warn("garden legacy path candidate rejected without temporal assertion evidence", {
        workspace_id: candidateInput.workspaceId,
        relation_kind: candidateInput.relationKind
      });
      return "rejected";
    }
  };
  return Object.freeze(sink);
}

// invariant: accepted legacy proposals carry neither assertion evidence nor a
// source EventLog anchor. Garden must defer their recovery until a temporal
// remapping path can establish both, never replay the legacy mint.
export function createGardenEdgeProposalReconcileDeferralPort(
  edgeProposalService: Pick<EdgeProposalReconcilePort, "sweepExpired">,
  warn: Warn
): EdgeProposalReconcilePort {
  const port: EdgeProposalReconcilePort = {
    reconcileStuckAccepts: async (input) => {
      warn("garden edge proposal accept-to-mint reconciliation deferred without temporal assertion provenance", {
        workspace_id: input.workspaceId,
        limit: input.limit
      });
      return Object.freeze({
        scanned: 0,
        reminted: 0,
        already_present: 0,
        rejected: 0,
        transient_failed: 0
      });
    },
    sweepExpired: async (input) => await edgeProposalService.sweepExpired(input)
  };
  return Object.freeze(port);
}

// invariant: bootstrap edges lack assertion evidence and a source EventLog
// anchor, so temporal clean-break leaves them deferred at daemon startup.
export async function deferGardenBootstrapPathReconciliation(
  workspaceRepo: WorkspaceListPort,
  warn: Warn
): Promise<void> {
  let workspaces: readonly Readonly<{ readonly workspace_id: string; readonly workspace_state?: string }>[];
  try {
    workspaces = await workspaceRepo.list();
  } catch (error) {
    warn("garden bootstrap path reconciliation deferral enumeration failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  for (const workspace of workspaces) {
    if (workspace.workspace_state === "active" || workspace.workspace_state === undefined) {
      warn("garden bootstrap path reconciliation deferred without temporal assertion provenance", {
        workspace_id: workspace.workspace_id
      });
    }
  }
}
