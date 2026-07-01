import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { PathRelationProposalPayload } from "@do-soul/alaya-storage";
import { reportAsyncSideEffectFailure } from "@do-soul/alaya-core";
import {
  ControlPlaneObjectKind,
  MemoryGovernanceEventType,
  PathGovernanceClass,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  SoulProposalCreatedPayloadSchema,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import type { ProposalRouteServices } from "./proposals-types.js";
import { readJsonObject } from "./proposals-request-helpers.js";

export async function promoteStrictlyGovernedProposal(
  context: Context,
  services: ProposalRouteServices
): Promise<Response> {
  const workspaceId = context.req.param("wsId")!;
  const memoryId = context.req.param("memoryId")!;
  await services.workspaceService.getById(workspaceId);
  const missing = await rejectMissingMemory(context, services, memoryId, workspaceId);
  if (missing !== null) return missing;
  const reason = await readPromotionReason(context, memoryId);
  const created = await createStrictlyGovernedProposal(services, { workspaceId, memoryId, reason });
  await notifyStrictGovernanceProposalEvents(services, created, workspaceId);
  return context.json({ success: true, data: strictGovernanceResponse(created.proposal.proposal_id, memoryId) }, 200);
}

async function notifyStrictGovernanceProposalEvents(
  services: ProposalRouteServices,
  created: Awaited<ReturnType<typeof createStrictlyGovernedProposal>>,
  workspaceId: string
): Promise<void> {
  for (const event of created.events) {
    try {
      await services.runtimeNotifier.notifyEntry(event);
    } catch (error) {
      await reportAsyncSideEffectFailure(
        {
          source: "daemon.proposals.promote_strictly_governed",
          operation: "runtime_notify",
          subjectType: "proposal",
          subjectId: created.proposal.proposal_id,
          workspaceId,
          runId: null,
          causedBy: "inspector",
          committedEventId: event.event_id,
          severity: "error",
          warningCode: "ALAYA_PROPOSAL_NOTIFY_FAILED",
          warningMessage: "[ProposalRoute] promote-strictly-governed notification failed"
        },
        error
      );
    }
  }
}

async function rejectMissingMemory(
  context: Context,
  services: ProposalRouteServices,
  memoryId: string,
  workspaceId: string
): Promise<Response | null> {
  const memory = await services.memoryService.findByIdScoped(memoryId, workspaceId);
  if (memory !== null) return null;
  return context.json(
    { success: false, error: { code: "NOT_FOUND", message: "Memory entry not found" } },
    404
  );
}

async function readPromotionReason(context: Context, memoryId: string): Promise<string> {
  const body = await readJsonObject(context);
  if (body !== null && typeof body.reason === "string" && body.reason.trim().length > 0) {
    return body.reason.trim();
  }
  return `Promote ${memoryId}: Inspector user requested PathRelation governance_class = strictly_governed.`;
}

async function createStrictlyGovernedProposal(
  services: ProposalRouteServices,
  input: { readonly workspaceId: string; readonly memoryId: string; readonly reason: string }
) {
  const proposalId = randomUUID();
  const timestamp = new Date().toISOString();
  const proposal = buildStrictlyGovernedProposal(input.memoryId, proposalId, timestamp);
  const summary = `${input.reason} Target PathRelation legitimacy.governance_class = ${PathGovernanceClass.STRICTLY_GOVERNED}.`;
  return await services.proposalRepo.createProposalWithEvents(
    {
      proposal,
      workspace_id: input.workspaceId,
      run_id: null,
      target_object_kind: "path_relation",
      proposed_change_summary: summary,
      proposed_path_relation: buildStrictlyGovernedPathRelationProposal(input.memoryId),
      created_at: timestamp
    },
    [buildProposalCreatedEvent(proposal, input.workspaceId)]
  );
}

function buildStrictlyGovernedProposal(memoryId: string, proposalId: string, timestamp: string): Proposal {
  return ProposalSchema.parse({
    runtime_id: proposalId,
    object_kind: ControlPlaneObjectKind.PROPOSAL,
    task_surface_ref: null,
    expires_at: null,
    derived_from: memoryId,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: proposalId,
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [buildStrictlyGovernedProposalOption(proposalId)],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: timestamp
  });
}

function buildStrictlyGovernedProposalOption(proposalId: string) {
  return {
    option_id: `promote_strictly_governed_${proposalId}`,
    option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
    preserves_protected_constraints: true,
    dropped_candidates: [], unresolved_after_apply: [],
    requires_confirmation: true
  };
}

function buildProposalCreatedEvent(
  proposal: Proposal,
  workspaceId: string
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
    entity_type: "proposal",
    entity_id: proposal.proposal_id,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: "inspector",
    payload_json: SoulProposalCreatedPayloadSchema.parse({
      object_id: proposal.runtime_id, object_kind: proposal.object_kind, workspace_id: workspaceId, run_id: null
    })
  };
}

function strictGovernanceResponse(proposalId: string, memoryId: string) {
  return {
    proposal_id: proposalId,
    status: "created",
    target_object_id: memoryId,
    target_object_kind: "path_relation",
    requested_governance_class: PathGovernanceClass.STRICTLY_GOVERNED
  };
}

function buildStrictlyGovernedPathRelationProposal(memoryId: string): PathRelationProposalPayload {
  return {
    target_anchor: {
      kind: "object_facet",
      object_id: memoryId,
      facet_key: "strictly_governed_constraint"
    },
    constitution: {
      relation_kind: "governance_constraint",
      why_this_relation_exists: ["operator requested strictly_governed governance promotion"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "source_to_target",
      stability_class: "pinned",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: ["inspector:promote-strictly-governed"],
      governance_class: PathGovernanceClass.STRICTLY_GOVERNED
    }
  };
}
