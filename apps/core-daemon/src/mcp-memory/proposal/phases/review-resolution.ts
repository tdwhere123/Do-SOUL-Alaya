import type { EventLogEntry, Proposal } from "@do-soul/alaya-protocol";
import type { SoulReviewMemoryProposalRequest } from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "../../tool/tool-handler-types.js";
import {
  acceptProposalWithDurableMemoryUpdate,
  acceptProposalWithDurablePathRelationGovernance,
  acceptProposalWithDurableSynthesisCreate,
  prepareAcceptedProposalApply
} from "../proposal-acceptance.js";
import { createWorkflowError, normalizeResolutionError } from "../proposal-workflow-reviewer.js";
import type { McpMemoryProposalWorkflowDependencies } from "../proposal-workflow.js";
import type { ProposalResolutionEventInput } from "../proposal-workflow-types.js";
import { combineResolutionMutations } from "./resolution-mutation.js";

export type ProposalReviewResolutionOptions = Readonly<{
  readonly reviewerIdentity: string;
  readonly applySynchronousResolutionMutation?: () => readonly ProposalResolutionEventInput[];
}>;

type ScopedProposal = NonNullable<Awaited<ReturnType<
  McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]
>>>;
type AcceptedApply = Awaited<ReturnType<typeof prepareAcceptedProposalApply>>;

export async function prepareAcceptedReviewApply(input: Readonly<{
  readonly deps: McpMemoryProposalWorkflowDependencies;
  readonly scopedProposal: ScopedProposal;
  readonly request: SoulReviewMemoryProposalRequest;
  readonly context: McpMemoryToolCallContext;
  readonly now: () => string;
  readonly generateObjectId: () => string;
}>): Promise<AcceptedApply | undefined> {
  if (input.request.verdict !== "accept") return undefined;
  return await prepareAcceptedProposalApply(
    input.deps,
    input.scopedProposal,
    input.context,
    input.now,
    input.generateObjectId
  );
}

export async function applyProposalReviewResolution(input: Readonly<{
  readonly deps: McpMemoryProposalWorkflowDependencies;
  readonly scopedProposal: ScopedProposal;
  readonly reviewedAt: string;
  readonly toState: Proposal["resolution_state"];
  readonly reviewEvents: readonly ProposalResolutionEventInput[];
  readonly acceptedApply: AcceptedApply | undefined;
  readonly options: ProposalReviewResolutionOptions;
}>): Promise<Readonly<{ readonly proposal: Readonly<Proposal>; readonly events: readonly EventLogEntry[] }>> {
  try {
    return await applyResolutionBranch(input);
  } catch (error) {
    throw normalizeResolutionError(error);
  }
}

async function applyResolutionBranch(input: Readonly<{
  readonly deps: McpMemoryProposalWorkflowDependencies;
  readonly scopedProposal: ScopedProposal;
  readonly reviewedAt: string;
  readonly toState: Proposal["resolution_state"];
  readonly reviewEvents: readonly ProposalResolutionEventInput[];
  readonly acceptedApply: AcceptedApply | undefined;
  readonly options: ProposalReviewResolutionOptions;
}>): Promise<Readonly<{ readonly proposal: Readonly<Proposal>; readonly events: readonly EventLogEntry[] }>> {
  const id = input.scopedProposal.proposal.proposal_id;
  const apply = input.acceptedApply;
  if (apply === undefined) {
    return await input.deps.proposalRepo.updatePendingResolutionWithEvents(
      id, input.toState, input.reviewedAt, input.reviewEvents, input.options
    );
  }
  if (apply.kind === "privacy_erase") return await acceptPrivacyErase(input, apply);
  if (apply.kind === "memory_update") {
    return await acceptProposalWithDurableMemoryUpdate(
      input.deps, id, input.reviewedAt, input.reviewEvents, apply.memoryUpdate, input.options
    );
  }
  if (apply.kind === "path_relation_governance") {
    return await acceptProposalWithDurablePathRelationGovernance(
      input.deps, id, input.reviewedAt, input.reviewEvents,
      apply.pathRelationGovernance, input.options
    );
  }
  return await acceptProposalWithDurableSynthesisCreate(
    input.deps, id, input.reviewedAt, input.reviewEvents, apply.synthesisCreate, input.options
  );
}

async function acceptPrivacyErase(
  input: Readonly<{
    readonly deps: McpMemoryProposalWorkflowDependencies;
    readonly scopedProposal: ScopedProposal;
    readonly reviewedAt: string;
    readonly reviewEvents: readonly ProposalResolutionEventInput[];
    readonly options: ProposalReviewResolutionOptions;
  }>,
  privacyErase: Extract<AcceptedApply, { readonly kind: "privacy_erase" }>
): Promise<Readonly<{ readonly proposal: Readonly<Proposal>; readonly events: readonly EventLogEntry[] }>> {
  const accept = input.deps.proposalRepo.acceptPendingPrivacyEraseWithEvents;
  if (accept === undefined) {
    throw createWorkflowError("NEEDS_CONTEXT", "Atomic privacy erase acceptance is unavailable.");
  }
  let mutationApplied = false;
  const resolved = await accept.call(
    input.deps.proposalRepo,
    input.scopedProposal.proposal.proposal_id,
    input.reviewedAt,
    input.reviewEvents,
    {
      transactionScope: privacyErase.transactionScope,
      apply: (storedReviewEvents) => {
        mutationApplied = true;
        return [
          ...privacyErase.applySynchronousResolutionMutation(storedReviewEvents),
          ...(input.options.applySynchronousResolutionMutation?.() ?? [])
        ];
      }
    },
    { reviewerIdentity: input.options.reviewerIdentity }
  );
  if (!mutationApplied) {
    throw createWorkflowError("NEEDS_CONTEXT", "Privacy erase acceptance omitted its mutation.");
  }
  return resolved;
}

export function buildProposalReviewResolutionOptions(
  reviewerIdentity: string,
  mutation: (() => readonly ProposalResolutionEventInput[]) | undefined
): ProposalReviewResolutionOptions {
  return {
    reviewerIdentity,
    ...(mutation === undefined ? {} : { applySynchronousResolutionMutation: mutation })
  };
}
