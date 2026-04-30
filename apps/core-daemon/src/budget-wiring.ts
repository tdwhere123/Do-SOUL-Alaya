import { randomUUID } from "node:crypto";
import type { BudgetBankruptcyServiceProposalPort } from "@do-soul/alaya-core";
import {
  ControlPlaneObjectKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  type Proposal,
  type ProposalOption
} from "@do-soul/alaya-protocol";
import type { ProposalRepo } from "@do-soul/alaya-storage";

interface CreateBudgetProposalPortParams {
  readonly proposalRepo: Pick<ProposalRepo, "create" | "updateResolution" | "findById" | "findPendingByRunId">;
  readonly now: () => string;
  readonly generateProposalId?: () => string;
}

export function createBudgetProposalPort(
  params: CreateBudgetProposalPortParams
): BudgetBankruptcyServiceProposalPort {
  const generateProposalId = params.generateProposalId ?? (() => randomUUID());

  return {
    create: async (input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly dossierRef: string;
      readonly options: readonly Readonly<ProposalOption>[];
      readonly recommendedOptionId: string | null;
      readonly expiresAt: string | null;
    }) => {
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

      return await params.proposalRepo.create({
        proposal,
        workspace_id: input.workspaceId,
        run_id: input.runId
      });
    },
    update: async (
      proposalId: string,
      patch: {
        readonly resolution_state: Proposal["resolution_state"];
        readonly last_updated_at: string;
      }
    ) => await params.proposalRepo.updateResolution(proposalId, patch.resolution_state, patch.last_updated_at),
    findById: async (proposalId: string) => await params.proposalRepo.findById(proposalId),
    findPendingByRunId: async (runId: string) => await params.proposalRepo.findPendingByRunId(runId)
  };
}
