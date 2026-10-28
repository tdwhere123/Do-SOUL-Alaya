import { randomUUID } from "node:crypto";
import { ControlPlaneObjectKind, MemoryGovernanceEventType, ProposalOptionKind, ProposalResolutionState,
  ProposalSchema, RetentionPolicy, SoulProposalCreatedPayloadSchema, type EventLogEntry, type Proposal } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { EventPublisher, EventPublisherInput } from "../../runtime/event-publisher.js";

export interface GardenProposalInput {
  readonly workspaceId: string;
  readonly derivedFrom: string;
  readonly dossierRef: string;
  readonly causedBy: string;
  readonly droppedCandidates?: readonly string[];
  readonly unresolvedAfterApply?: readonly string[];
}

export function buildProposalCreatedEvent(proposal: Readonly<Proposal>, context: Readonly<{
  workspaceId: string; runId: string | null; causedBy: string; sourceDeliveryIds?: readonly string[] | null;
}>): EventPublisherInput {
  return {
    event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
    entity_type: "proposal", entity_id: proposal.proposal_id, workspace_id: context.workspaceId,
    run_id: context.runId, caused_by: context.causedBy,
    payload_json: SoulProposalCreatedPayloadSchema.parse({ object_id: proposal.runtime_id,
      object_kind: proposal.object_kind, workspace_id: context.workspaceId, run_id: context.runId,
      ...(context.sourceDeliveryIds == null ? {} : { source_delivery_ids: context.sourceDeliveryIds }) })
  };
}

interface GardenProposalStore {
  readonly transactionScope: object;
  createProposalWithEventsIfAbsent(
    input: { readonly proposal: Proposal; readonly workspace_id: string; readonly run_id: null; readonly target_object_kind: "memory_entry" },
    events: readonly EventPublisherInput[],
    key: { readonly workspace_id: string; readonly target_object_kind: "memory_entry"; readonly derived_from: string; readonly dossier_ref: string }
  ): Promise<Readonly<{ readonly proposal: Readonly<Proposal>; readonly events: readonly EventLogEntry[]; readonly status: string }>>;
}

/** Authors the proposal and its audit; Storage owns only their atomic persistence. */
export function createGardenProposalWriter(deps: Readonly<{
  proposalRepo: GardenProposalStore; eventPublisher: Pick<EventPublisher, "getStorageConnectionIdentity" | "propagateCommitted">;
  now?: () => string; generateId?: () => string;
}>) {
  const now = deps.now ?? (() => new Date().toISOString()), generateId = deps.generateId ?? randomUUID;
  return {
    async create(input: GardenProposalInput): Promise<{ readonly candidate_id: string; readonly created: boolean }> {
      if (deps.eventPublisher.getStorageConnectionIdentity() !== deps.proposalRepo.transactionScope) {
        throw new CoreError("CONFLICT", "Garden proposal creation requires the EventLog transaction connection");
      }
      const proposalId = generateId(), runtimeId = generateId(), optionId = generateId();
      const proposal = ProposalSchema.parse({ runtime_id: runtimeId, object_kind: ControlPlaneObjectKind.PROPOSAL,
        proposal_id: proposalId, task_surface_ref: null, derived_from: input.derivedFrom, retention_policy: RetentionPolicy.RUN_SCOPED,
        dossier_ref: input.dossierRef, recommended_option_id: optionId, proposal_options: [{ option_id: optionId,
          option_kind: ProposalOptionKind.REQUEST_CONFIRMATION, preserves_protected_constraints: true,
          dropped_candidates: [...(input.droppedCandidates ?? [])], unresolved_after_apply: [...(input.unresolvedAfterApply ?? [])],
          requires_confirmation: true }], resolution_state: ProposalResolutionState.PENDING, expires_at: null, last_updated_at: now() });
      const event = buildProposalCreatedEvent(proposal, { workspaceId: input.workspaceId, runId: null, causedBy: input.causedBy });
      const result = await deps.proposalRepo.createProposalWithEventsIfAbsent({ proposal, workspace_id: input.workspaceId,
        run_id: null, target_object_kind: "memory_entry" }, [event], { workspace_id: input.workspaceId,
        target_object_kind: "memory_entry", derived_from: input.derivedFrom, dossier_ref: input.dossierRef });
      await deps.eventPublisher.propagateCommitted(result.events);
      return { candidate_id: result.proposal.proposal_id, created: result.status === "created" };
    }
  };
}
