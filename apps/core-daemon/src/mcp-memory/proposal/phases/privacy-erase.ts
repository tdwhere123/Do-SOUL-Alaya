import {
  buildEraseBarrierEventInput,
  createProjectionEraseBarrier,
  fieldContractSha256
} from "@do-soul/alaya-core";
import type { EventLogEntry, MemoryEntryMutableFields } from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "../../tool/tool-handler-types.js";
import type { McpMemoryProposalWorkflowDependencies } from "../proposal-workflow.js";
import type { ProposalResolutionEventInput } from "../proposal-workflow-types.js";
import { authorizePrivacyErase } from "./privacy-hard-effect.js";

export type AcceptedPrivacyEraseApply = Readonly<{
  readonly kind: "privacy_erase";
  readonly transactionScope: object;
  readonly applySynchronousResolutionMutation: (
    storedReviewEvents: readonly EventLogEntry[]
  ) => readonly ProposalResolutionEventInput[];
}>;

export function prepareAcceptedPrivacyErase(input: Readonly<{
  readonly deps: McpMemoryProposalWorkflowDependencies;
  readonly proposalId: string;
  readonly targetObjectKind: string | null | undefined;
  readonly targetObjectId: string;
  readonly proposedChanges: Readonly<MemoryEntryMutableFields> | null | undefined;
  readonly context: McpMemoryToolCallContext;
  readonly now: () => string;
  readonly generateObjectId: () => string;
  readonly createError: (code: "VALIDATION" | "NEEDS_CONTEXT", message: string) => Error;
}>): AcceptedPrivacyEraseApply {
  assertPrivacyEraseProposal(input);
  const { privacyErasePort, effectStore } = requirePrivacyEffectPorts(input);
  const barrier = createProjectionEraseBarrier({
    barrier_id: input.generateObjectId(),
    workspace_id: input.context.workspaceId,
    generation_id: null,
    subject_kind: "source_record",
    subject_id: input.targetObjectId,
    erased_at: input.now()
  }, fieldContractSha256);
  return {
    kind: "privacy_erase",
    transactionScope: privacyErasePort.transactionScope,
    applySynchronousResolutionMutation: (storedReviewEvents) => [
      ...authorizePrivacyErase({
        store: effectStore.store,
        lookup: effectStore.lookup,
        storedReviewEvents,
        proposalId: input.proposalId,
        workspaceId: input.context.workspaceId,
        targetObjectId: input.targetObjectId,
        reviewedAt: barrier.erased_at,
        createError: input.createError
      }),
      buildEraseBarrierEventInput(privacyErasePort.apply(barrier))
    ]
  };
}

function requirePrivacyEffectPorts(input: Readonly<{
  readonly deps: McpMemoryProposalWorkflowDependencies;
  readonly createError: (code: "NEEDS_CONTEXT", message: string) => Error;
}>) {
  const privacyErasePort = input.deps.privacyErasePort;
  const effectStore = input.deps.privacyEffectDecisionStore;
  if (privacyErasePort === undefined || effectStore === undefined) {
    throw input.createError(
      "NEEDS_CONTEXT",
      "Atomic privacy erase and hard-effect decision ports are required."
    );
  }
  if (privacyErasePort.transactionScope !== effectStore.transactionScope) {
    throw input.createError(
      "NEEDS_CONTEXT",
      "Privacy erase and hard-effect decision ports must share one transaction scope."
    );
  }
  return { privacyErasePort, effectStore };
}

function assertPrivacyEraseProposal(input: Readonly<{
  readonly proposalId: string;
  readonly targetObjectKind: string | null | undefined;
  readonly proposedChanges: Readonly<MemoryEntryMutableFields> | null | undefined;
  readonly createError: (code: "VALIDATION", message: string) => Error;
}>): void {
  if (input.targetObjectKind !== "source_record") {
    throw input.createError(
      "VALIDATION",
      `Privacy erase proposal ${input.proposalId} must target a source_record.`
    );
  }
  if (input.proposedChanges != null) {
    throw input.createError(
      "VALIDATION",
      `Privacy erase proposal ${input.proposalId} cannot carry memory changes.`
    );
  }
}
