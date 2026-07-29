import type { CreateGardenSchedulerRuntimeSupportInput } from "./scheduler-runtime-types.js";

const EDGE_PROPOSAL_RECONCILE_CAP_PER_PASS = 32;
const EDGE_PROPOSAL_EXPIRY_CAP_PER_PASS = 64;

export function createEdgeProposalMaintenance(input: CreateGardenSchedulerRuntimeSupportInput): Readonly<{
  readonly reconcileStuckEdgeProposalAccepts: () => Promise<void>;
  readonly sweepExpiredEdgeProposals: () => Promise<void>;
}> {
  return Object.freeze({
    reconcileStuckEdgeProposalAccepts: async (): Promise<void> => {
      await runEdgeProposalPass(
        input,
        "edge proposal accept->mint reconcile pass failed; continuing",
        async (workspaceId) => {
          const result = await input.edgeProposalReconcile!.reconcileStuckAccepts({
            workspaceId,
            limit: EDGE_PROPOSAL_RECONCILE_CAP_PER_PASS
          });
          if (result.scanned > 0) {
            input.warn("edge proposal accept->mint reconcile pass acted on stranded accepts", {
              workspace_id: workspaceId,
              scanned: result.scanned,
              reminted: result.reminted,
              already_present: result.already_present,
              rejected: result.rejected,
              transient_failed: result.transient_failed
            });
          }
        }
      );
    },
    sweepExpiredEdgeProposals: async (): Promise<void> => {
      await runEdgeProposalPass(
        input,
        "edge proposal TTL sweep failed; continuing",
        async (workspaceId) => {
          const result = await input.edgeProposalReconcile!.sweepExpired({
            workspaceId,
            limit: EDGE_PROPOSAL_EXPIRY_CAP_PER_PASS
          });
          if (result.expired > 0 || result.skipped > 0) {
            input.warn("edge proposal TTL sweep expired past-TTL pending proposals", {
              workspace_id: workspaceId,
              scanned: result.scanned,
              expired: result.expired,
              skipped: result.skipped
            });
          }
        }
      );
    }
  });
}

async function runEdgeProposalPass(
  input: CreateGardenSchedulerRuntimeSupportInput,
  failureMessage: string,
  runForWorkspace: (workspaceId: string) => Promise<void>
): Promise<void> {
  if (input.edgeProposalReconcile === undefined) {
    return;
  }
  const workspaces = await input.workspaceRepo.list();
  for (const workspace of workspaces) {
    try {
      await runForWorkspace(workspace.workspace_id);
    } catch (error) {
      input.warn(failureMessage, {
        workspace_id: workspace.workspace_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
