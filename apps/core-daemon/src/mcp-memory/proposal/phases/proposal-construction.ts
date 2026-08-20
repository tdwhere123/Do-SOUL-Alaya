import {
  ControlPlaneObjectKind,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  type Proposal,
  type SoulProposeMemoryUpdateRequest
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "../../tool/tool-handler-types.js";
import type { PreparedMemoryProposalOperation } from "./request-operation.js";

export function buildMemoryProposal(input: Readonly<{
  readonly proposalId: string;
  readonly timestamp: string;
  readonly request: SoulProposeMemoryUpdateRequest;
  readonly context: McpMemoryToolCallContext;
  readonly mutation: PreparedMemoryProposalOperation;
}>): Proposal {
  return ProposalSchema.parse({
    runtime_id: input.proposalId,
    object_kind: ControlPlaneObjectKind.PROPOSAL,
    task_surface_ref: input.context.surfaceId ?? null,
    expires_at: null,
    derived_from: input.request.target_object_id,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: input.proposalId,
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [{
      option_id: `${input.mutation.operation}_${input.proposalId}`,
      option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
      preserves_protected_constraints: true,
      dropped_candidates: [],
      unresolved_after_apply: [],
      requires_confirmation: true
    }],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: input.timestamp
  });
}
