import { randomUUID } from "node:crypto";
import type { BudgetBankruptcyServiceProposalPort, EventPublisherInput } from "@do-soul/alaya-core";
import {
  AlayaError,
  ControlPlaneObjectKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  type Proposal,
  type ProposalOption
} from "@do-soul/alaya-protocol";
import type { ProposalRepo } from "@do-soul/alaya-storage";

interface CreateBudgetProposalPortParams {
  readonly proposalRepo: Pick<ProposalRepo,
    "createProposalWithEvents" | "updatePendingResolution" | "updatePendingResolutionWithEvents" | "findById" | "findPendingByRunId">;
  readonly now: () => string;
  readonly generateProposalId?: () => string;
}

export function createBudgetProposalPort(
  params: CreateBudgetProposalPortParams
): BudgetBankruptcyServiceProposalPort {
  const generateProposalId = params.generateProposalId ?? (() => randomUUID());

  return {
    createWithEvents: async (input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly dossierRef: string;
      readonly options: readonly Readonly<ProposalOption>[];
      readonly recommendedOptionId: string | null;
      readonly expiresAt: string | null;
    }, events: readonly EventPublisherInput[]) => {
      const proposalId = generateProposalId();
      const proposal = ProposalSchema.parse({
        runtime_id: proposalId,
        object_kind: ControlPlaneObjectKind.PROPOSAL,
        task_surface_ref: null,
        expires_at: input.expiresAt,
        derived_from: null,
        retention_policy: RetentionPolicy.SESSION_ONLY,
        proposal_id: proposalId,
        dossier_ref: input.dossierRef,
        recommended_option_id: input.recommendedOptionId,
        proposal_options: input.options as readonly ProposalOption[],
        resolution_state: ProposalResolutionState.PENDING,
        last_updated_at: params.now()
      } satisfies Proposal);

      return await params.proposalRepo.createProposalWithEvents({
        proposal,
        workspace_id: input.workspaceId,
        run_id: input.runId,
        // Bankruptcy-derived proposals target a bankruptcy_dossier, not
        // a memory_entry. Without this
        // override the Inspector pending queue would mislabel the row
        // as `memory_entry → <id>`, risking a wrong accept/reject
        // decision.
        target_object_kind: "bankruptcy_dossier",
        proposed_change_summary: `Bankruptcy resolution: ${input.dossierRef}`
      }, events);
    },
    update: async (
      proposalId: string,
      patch: {
        readonly resolution_state: Proposal["resolution_state"];
        readonly last_updated_at: string;
      }
    ) => {
      try {
        return await params.proposalRepo.updatePendingResolution(proposalId, patch.resolution_state, patch.last_updated_at);
      } catch (error) {
        if (!(error instanceof AlayaError) || error.code !== "CONFLICT") throw error;
        // Another recovery may have applied the same durable decision already.
        const existing = await params.proposalRepo.findById(proposalId);
        if (existing?.resolution_state === patch.resolution_state && existing.last_updated_at === patch.last_updated_at) {
          return existing;
        }
        throw error;
      }
    },
    updateWithEvents: async (proposalId, patch, events) =>
      await params.proposalRepo.updatePendingResolutionWithEvents(
        proposalId, patch.resolution_state, patch.last_updated_at, events
      ),
    findById: async (proposalId: string) => await params.proposalRepo.findById(proposalId),
    findPendingByRunId: async (runId: string) => await params.proposalRepo.findPendingByRunId(runId)
  };
}
