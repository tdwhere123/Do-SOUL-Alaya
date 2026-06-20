import type { EventLogEntry, Proposal } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { insertEventLogEntry } from "../shared/event-log-writer.js";
import { parseNonEmptyString } from "../shared/validators.js";
import { parseNullableTimestamp, parseProposal, parseProposalReviewerAssignment, parseRunId, parseWorkspaceId, serializeProposedChanges, serializeSourceDeliveryIds } from "./mappers.js";
import { serializeProposedPathRelation } from "./path-relations.js";
import type { ProposalStatements } from "./sqlite-proposal-statements.js";
import type { CreateProposalWithEventsOptions, ProposalCreateInput, ProposalCreationEventInput, ProposalReviewerAssignment } from "./types.js";

interface ParsedProposalCreateRequest {
  readonly proposal: Readonly<Proposal>;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly targetObjectKind: string;
  readonly proposedChangeSummary: string;
  readonly proposedChanges: string | null;
  readonly proposedPathRelation: string | null;
  readonly createdAt: string;
  readonly targetBaselineUpdatedAt: string | null;
  readonly sourceDeliveryIds: string | null;
}

export class ProposalCreateWorkflow {
  public constructor(
    private readonly db: StorageDatabase,
    private readonly eventLogWriter: Parameters<typeof insertEventLogEntry>[0],
    private readonly statements: ProposalStatements
  ) {}

  public async create(input: ProposalCreateInput): Promise<Readonly<Proposal>> {
    const request = parseProposalCreateRequest(input);

    try {
      insertProposal(this.statements, request);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create proposal ${request.proposal.proposal_id}.`,
        error
      );
    }

    return request.proposal;
  }

  public async createProposalWithEvents(
    input: ProposalCreateInput,
    events: readonly ProposalCreationEventInput[],
    options: CreateProposalWithEventsOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const request = parseProposalCreateRequest(input);
    const reviewerAssignment =
      options.reviewerAssignment === undefined
        ? undefined
        : parseProposalReviewerAssignment(options.reviewerAssignment);

    try {
      return this.db.connection.transaction(() => {
        const storedEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        insertProposal(this.statements, request);
        if (reviewerAssignment !== undefined) {
          this.insertReviewerAssignment(reviewerAssignment);
        }

        return deepFreeze({
          proposal: request.proposal,
          events: storedEvents
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create proposal ${request.proposal.proposal_id} with creation events.`,
        error
      );
    }
  }


  private insertReviewerAssignment(assignment: ProposalReviewerAssignment): void {
    this.statements.assignReviewerStatement.run(
      assignment.proposal_id,
      assignment.reviewer_identity,
      assignment.assigned_at,
      assignment.deadline_at,
      assignment.escalation_after_ms
    );
  }
}

function parseProposalCreateRequest(input: ProposalCreateInput): ParsedProposalCreateRequest {
  const proposal = parseProposal(input.proposal);
  return {
    proposal,
    workspaceId: parseWorkspaceId(input.workspace_id),
    runId: parseRunId(input.run_id),
    targetObjectKind: parseNonEmptyString(input.target_object_kind, "target_object_kind"),
    proposedChangeSummary: input.proposed_change_summary ?? "",
    proposedChanges: serializeProposedChanges(input.proposed_changes ?? null),
    proposedPathRelation: serializeProposedPathRelation(input.proposed_path_relation ?? null),
    createdAt: input.created_at ?? proposal.last_updated_at,
    targetBaselineUpdatedAt: parseNullableTimestamp(input.target_baseline_updated_at ?? null),
    sourceDeliveryIds: serializeSourceDeliveryIds(input.source_delivery_ids ?? null)
  };
}

function insertProposal(
  statements: ProposalStatements,
  request: ParsedProposalCreateRequest
): void {
  const proposal = request.proposal;
  statements.createStatement.run(
    proposal.runtime_id,
    proposal.object_kind,
    proposal.proposal_id,
    proposal.task_surface_ref,
    proposal.derived_from,
    proposal.retention_policy,
    proposal.dossier_ref,
    proposal.recommended_option_id,
    JSON.stringify(proposal.proposal_options),
    proposal.resolution_state,
    proposal.expires_at,
    proposal.last_updated_at,
    request.workspaceId,
    request.runId,
    request.targetObjectKind,
    request.proposedChangeSummary,
    request.proposedChanges,
    request.proposedPathRelation,
    request.createdAt,
    request.targetBaselineUpdatedAt,
    request.sourceDeliveryIds
  );
}
