import type { EventLogEntry, Proposal } from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { insertEventLogEntry } from "../shared/event-log-writer.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  parseNullableTimestamp,
  parseProposal,
  parseProposalReviewerAssignment,
  parseProposalRow,
  parseRunId,
  parseWorkspaceId,
  serializeProposedChanges,
  serializeSourceDeliveryIds
} from "./mappers.js";
import { serializeProposedPathRelation } from "./path-relations.js";
import type { ProposalRow } from "./rows.js";
import type { ProposalStatements } from "./sqlite-proposal-statements.js";
import type {
  CreateProposalWithEventsIfAbsentResult,
  CreateProposalWithEventsOptions,
  PendingProposalDedupeKey,
  ProposalCreateInput,
  ProposalCreationEventInput,
  ProposalReviewerAssignment
} from "./types.js";

type ProposalEventLogWriter = Parameters<typeof insertEventLogEntry>[0];

export interface ProposalCreateWorkflowHost extends Pick<
  ProposalStatements,
  "createStatement" | "findPendingByDedupeKeyStatement" | "assignReviewerStatement"
> {
  readonly eventLogWriter: ProposalEventLogWriter;
  transaction<T>(fn: () => T, options?: { readonly immediate?: boolean }): T;
}

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

interface ParsedPendingProposalDedupeKey {
  readonly workspaceId: string;
  readonly derivedFrom: string;
  readonly dossierRef: string;
  readonly targetObjectKind: string;
}

export class ProposalCreateWorkflow {
  public constructor(private readonly host: ProposalCreateWorkflowHost) {}

  public async create(input: ProposalCreateInput): Promise<Readonly<Proposal>> {
    const request = parseProposalCreateRequest(input);

    try {
      insertProposal(this.host, request);
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
      return this.host.transaction(() => {
        const storedEvents = events.map((event) => insertEventLogEntry(this.host.eventLogWriter, event));
        insertProposal(this.host, request);
        if (reviewerAssignment !== undefined) {
          this.insertReviewerAssignment(reviewerAssignment);
        }

        return deepFreeze({
          proposal: request.proposal,
          events: storedEvents
        });
      });
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

  public async createProposalWithEventsIfAbsent(
    input: ProposalCreateInput,
    events: readonly ProposalCreationEventInput[],
    dedupeKey: PendingProposalDedupeKey,
    options: CreateProposalWithEventsOptions = {}
  ): Promise<CreateProposalWithEventsIfAbsentResult> {
    const request = parseProposalCreateRequest(input);
    const parsedDedupeKey = parsePendingProposalDedupeKey(dedupeKey);
    const reviewerAssignment =
      options.reviewerAssignment === undefined
        ? undefined
        : parseProposalReviewerAssignment(options.reviewerAssignment);

    try {
      return this.host.transaction(() => {
        const existing = findPendingProposalByDedupeKey(this.host, parsedDedupeKey);
        if (existing !== null) {
          return deepFreeze({ proposal: existing, events: [], status: "already_pending" as const });
        }

        const storedEvents = events.map((event) => insertEventLogEntry(this.host.eventLogWriter, event));
        insertProposal(this.host, request);
        if (reviewerAssignment !== undefined) {
          this.insertReviewerAssignment(reviewerAssignment);
        }

        return deepFreeze({
          proposal: request.proposal,
          events: storedEvents,
          status: "created" as const
        });
      }, { immediate: true });
    } catch (error) {
      const existing = findPendingProposalByDedupeKey(this.host, parsedDedupeKey);
      if (isUniqueConstraintError(error) && existing !== null) {
        return deepFreeze({ proposal: existing, events: [], status: "already_pending" as const });
      }

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
    this.host.assignReviewerStatement.run(
      assignment.proposal_id,
      assignment.reviewer_identity,
      assignment.assigned_at,
      assignment.deadline_at,
      assignment.escalation_after_ms
    );
  }
}

function parsePendingProposalDedupeKey(
  key: PendingProposalDedupeKey
): ParsedPendingProposalDedupeKey {
  return {
    workspaceId: parseWorkspaceId(key.workspace_id),
    derivedFrom: parseNonEmptyString(key.derived_from, "derived_from"),
    dossierRef: parseNonEmptyString(key.dossier_ref, "dossier_ref"),
    targetObjectKind: parseNonEmptyString(key.target_object_kind, "target_object_kind")
  };
}

function findPendingProposalByDedupeKey(
  statements: Pick<ProposalStatements, "findPendingByDedupeKeyStatement">,
  key: ParsedPendingProposalDedupeKey
): Readonly<Proposal> | null {
  const row = statements.findPendingByDedupeKeyStatement.get(
    key.workspaceId,
    key.targetObjectKind,
    key.derivedFrom,
    key.dossierRef
  ) as ProposalRow | undefined;
  return row === undefined ? null : parseProposalRow(row);
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
  statements: Pick<ProposalStatements, "createStatement">,
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

function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    const messageValue = (current as { readonly message?: unknown }).message;
    if (typeof codeValue === "string" && codeValue.startsWith("SQLITE_CONSTRAINT")) {
      return true;
    }
    if (typeof messageValue === "string" && messageValue.includes("UNIQUE constraint failed")) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
