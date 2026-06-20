import {
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type Proposal,
  type ProposalResolutionState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { getEventLogWriter, insertEventLogEntry } from "../shared/event-log-writer.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";
import {
  acceptPendingMemoryUpdateWithEvents,
  acceptPendingPathRelationGovernanceWithEvents,
  acceptPendingSynthesisCreateWithEvents,
  type SqliteProposalWorkflowContext
} from "./accept-workflows.js";
import {
  parseNullableTimestamp,
  parseProposal,
  parseProposalId,
  parseProposalResolutionState,
  parseProposalReviewerAssignment,
  parseProposalReviewerAssignmentRow,
  parseProposalRow,
  parseProposedChanges,
  parseRunId,
  parseSourceDeliveryIds,
  parseUpdatedAt,
  parseWorkspaceId,
  serializeProposedChanges,
  serializeSourceDeliveryIds
} from "./mappers.js";
import { parseProposedPathRelation, serializeProposedPathRelation } from "./path-relations.js";
import { ProposalCreateWorkflow } from "./proposal-create-workflow.js";
import { ProposalReadQueries } from "./proposal-read-queries.js";
import { prepareProposalStatements } from "./sqlite-proposal-statements.js";
import {
  type PendingProposalSummaryRow,
  type ProposalReviewerAssignmentRow,
  type ProposalRow
} from "./rows.js";
import {
  SQLITE_VARIABLE_CHUNK_SIZE,
  type AcceptedMemoryUpdateInput,
  type AcceptedPathRelationGovernanceInput,
  type AcceptedSynthesisCreateInput,
  type CreateProposalWithEventsOptions,
  type FindPendingSummariesOptions,
  type PendingProposalSummary,
  type ProposalListPageOptions,
  type ProposalCreateInput,
  type ProposalCreationEventInput,
  type ProposalRepo,
  type ProposalResolutionEventInput,
  type ProposalReviewerAssignment,
  type ProposalReviewerAssignmentInput,
  type ScopedProposal,
  type UpdatePendingResolutionOptions
} from "./types.js";

interface ParsedPendingResolutionUpdate {
  readonly proposalId: string;
  readonly state: ProposalResolutionState;
  readonly updatedAt: string;
  readonly reviewerIdentity: string | undefined;
}

export class SqliteProposalRepo implements ProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findByWorkspaceIdPagedStatement;
  private readonly countByWorkspaceIdStatement;
  private readonly findPendingStatement;
  private readonly findPendingPagedStatement;
  private readonly countPendingStatement;
  private readonly findPendingByRunIdStatement;
  private readonly assignReviewerStatement;
  private readonly findReviewerAssignmentStatement;
  private readonly updateResolutionStatement;
  private readonly updateResolutionWithIdentityStatement;
  private readonly updatePendingResolutionStatement;
  private readonly updatePendingResolutionWithIdentityStatement;
  private readonly findMemoryEntryByIdStatement;
  private readonly updateMemoryEntryStatement;
  private readonly findRevokableGreenStatusStatement;
  private readonly revokeGreenStatusStatement;
  private readonly findPathRelationByAnchorMemoryIdStatement;
  private readonly createPathRelationStatement;
  private readonly updatePathRelationLegitimacyStatement;
  // see also: synthesis-capsule-repo.ts SqliteSynthesisCapsuleRepo.createStatement
  // — the same INSERT column order, prepared here so the synthesis-create
  // accept-apply can insert the capsule inside the proposal-resolve transaction.
  private readonly createSynthesisCapsuleStatement;
  private readonly eventLogWriter;
  private readonly createWorkflow: ProposalCreateWorkflow;
  private readonly readQueries: ProposalReadQueries;

  public constructor(private readonly db: StorageDatabase) {
    // INSERT also writes the HITL projection columns
    // (target_object_kind, proposed_change_summary, created_at).
    // Defaults from migration 058 keep legacy callers compatible if
    // they pass undefined for those fields.
    const statements = prepareProposalStatements(db);
    this.createStatement = statements.createStatement;
    this.findByIdStatement = statements.findByIdStatement;
    this.findByWorkspaceIdStatement = statements.findByWorkspaceIdStatement;
    this.findByWorkspaceIdPagedStatement = statements.findByWorkspaceIdPagedStatement;
    this.countByWorkspaceIdStatement = statements.countByWorkspaceIdStatement;
    this.findPendingStatement = statements.findPendingStatement;
    this.findPendingPagedStatement = statements.findPendingPagedStatement;
    this.countPendingStatement = statements.countPendingStatement;
    this.findPendingByRunIdStatement = statements.findPendingByRunIdStatement;
    this.assignReviewerStatement = statements.assignReviewerStatement;
    this.findReviewerAssignmentStatement = statements.findReviewerAssignmentStatement;
    this.updateResolutionStatement = statements.updateResolutionStatement;
    this.updateResolutionWithIdentityStatement = statements.updateResolutionWithIdentityStatement;
    this.updatePendingResolutionStatement = statements.updatePendingResolutionStatement;
    this.updatePendingResolutionWithIdentityStatement = statements.updatePendingResolutionWithIdentityStatement;
    this.findMemoryEntryByIdStatement = statements.findMemoryEntryByIdStatement;
    this.updateMemoryEntryStatement = statements.updateMemoryEntryStatement;
    this.findRevokableGreenStatusStatement = statements.findRevokableGreenStatusStatement;
    this.revokeGreenStatusStatement = statements.revokeGreenStatusStatement;
    this.findPathRelationByAnchorMemoryIdStatement = statements.findPathRelationByAnchorMemoryIdStatement;
    this.createPathRelationStatement = statements.createPathRelationStatement;
    this.updatePathRelationLegitimacyStatement = statements.updatePathRelationLegitimacyStatement;
    this.createSynthesisCapsuleStatement = statements.createSynthesisCapsuleStatement;

    this.eventLogWriter = getEventLogWriter(db.connection);
    this.createWorkflow = new ProposalCreateWorkflow(db, this.eventLogWriter, statements);
    this.readQueries = new ProposalReadQueries(db, statements);
  }

  public async create(input: ProposalCreateInput): Promise<Readonly<Proposal>> {
    return await this.createWorkflow.create(input);
  }

  public async createProposalWithEvents(
    input: ProposalCreateInput,
    events: readonly ProposalCreationEventInput[],
    options: CreateProposalWithEventsOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    return await this.createWorkflow.createProposalWithEvents(input, events, options);
  }
  public async findById(proposalId: string): Promise<Readonly<Proposal> | null> {
    return await this.readQueries.findById(proposalId);
  }

  public async findScopedById(proposalId: string): Promise<Readonly<ScopedProposal> | null> {
    return await this.readQueries.findScopedById(proposalId);
  }

  public async findByWorkspaceId(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]> {
    return await this.readQueries.findByWorkspaceId(workspaceId, page);
  }

  public async countByWorkspaceId(workspaceId: string): Promise<number> {
    return await this.readQueries.countByWorkspaceId(workspaceId);
  }

  public async findPending(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]> {
    return await this.readQueries.findPending(workspaceId, page);
  }

  public async countPending(workspaceId: string): Promise<number> {
    return await this.readQueries.countPending(workspaceId);
  }

  public async countPendingMemoryTargetEdges(
    workspaceId: string,
    targetObjectIds: readonly string[]
  ): Promise<number> {
    return await this.readQueries.countPendingMemoryTargetEdges(workspaceId, targetObjectIds);
  }

  public async findPendingSummaries(
    workspaceId: string,
    options: FindPendingSummariesOptions = {}
  ): Promise<readonly Readonly<PendingProposalSummary>[]> {
    return await this.readQueries.findPendingSummaries(workspaceId, options);
  }

  public async findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null> {
    return await this.readQueries.findPendingByRunId(runId);
  }

  public async assignReviewer(input: ProposalReviewerAssignmentInput): Promise<Readonly<ProposalReviewerAssignment>> {
    return await this.readQueries.assignReviewer(input);
  }

  public async findReviewerAssignment(
    proposalId: string
  ): Promise<Readonly<ProposalReviewerAssignment> | null> {
    return await this.readQueries.findReviewerAssignment(proposalId);
  }
  public async updateResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    reviewerIdentity?: string
  ): Promise<Readonly<Proposal>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedState = parseProposalResolutionState(state);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    // Persist reviewer_identity through the legacy update path.
    // Empty/whitespace identities are rejected;
    // when omitted, the column is left untouched (back-compat for
    // claim-promotion / auto-applied bankruptcy paths).
    const parsedReviewerIdentity =
      reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(reviewerIdentity, "reviewer_identity");

    try {
      const result =
        parsedReviewerIdentity === undefined
          ? this.updateResolutionStatement.run(parsedState, parsedUpdatedAt, parsedProposalId)
          : this.updateResolutionWithIdentityStatement.run(
              parsedState,
              parsedUpdatedAt,
              parsedReviewerIdentity,
              parsedProposalId
            );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
      }

      const updated = await this.findById(parsedProposalId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update proposal ${parsedProposalId}.`, error);
    }
  }

  public async updatePendingResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string
  ): Promise<Readonly<Proposal>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedState = parseProposalResolutionState(state);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.updatePendingResolutionStatement.run(parsedState, parsedUpdatedAt, parsedProposalId);

      if (result.changes === 0) {
        const existing = await this.findById(parsedProposalId);
        if (existing === null) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }

        throw new StorageError(
          "CONFLICT",
          `Proposal ${parsedProposalId} is already ${existing.resolution_state}.`
        );
      }

      const updated = await this.findById(parsedProposalId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update pending proposal ${parsedProposalId}.`,
        error
      );
    }
  }

  public async updatePendingResolutionWithEvents(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsed = parsePendingResolutionUpdate(proposalId, state, updatedAt, options);

    try {
      return this.updatePendingResolutionEventsTransaction(parsed, events);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update pending proposal ${parsed.proposalId} with review events.`,
        error
      );
    }
  }

  public async acceptPendingMemoryUpdateWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    memoryUpdate: AcceptedMemoryUpdateInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly memory: Readonly<MemoryEntry>;
    readonly events: readonly EventLogEntry[];
  }>> {
    return await acceptPendingMemoryUpdateWithEvents(
      this.createWorkflowContext(),
      proposalId,
      updatedAt,
      events,
      memoryUpdate,
      options
    );
  }

  public async acceptPendingPathRelationGovernanceWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    pathRelationGovernance: AcceptedPathRelationGovernanceInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly path_relation: Readonly<PathRelation>;
    readonly events: readonly EventLogEntry[];
  }>> {
    return await acceptPendingPathRelationGovernanceWithEvents(
      this.createWorkflowContext(),
      proposalId,
      updatedAt,
      events,
      pathRelationGovernance,
      options
    );
  }

  public async acceptPendingSynthesisCreateWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    synthesisCreate: AcceptedSynthesisCreateInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly synthesis: Readonly<SynthesisCapsule>;
    readonly events: readonly EventLogEntry[];
  }>> {
    return await acceptPendingSynthesisCreateWithEvents(
      this.createWorkflowContext(),
      proposalId,
      updatedAt,
      events,
      synthesisCreate,
      options
    );
  }

  private createWorkflowContext(): SqliteProposalWorkflowContext {
    return {
      db: this.db,
      eventLogWriter: this.eventLogWriter,
      findByIdStatement: this.findByIdStatement,
      findMemoryEntryByIdStatement: this.findMemoryEntryByIdStatement,
      updateMemoryEntryStatement: this.updateMemoryEntryStatement,
      findRevokableGreenStatusStatement: this.findRevokableGreenStatusStatement,
      revokeGreenStatusStatement: this.revokeGreenStatusStatement,
      updatePendingResolutionStatement: this.updatePendingResolutionStatement,
      updatePendingResolutionWithIdentityStatement: this.updatePendingResolutionWithIdentityStatement,
      findPathRelationByAnchorMemoryIdStatement: this.findPathRelationByAnchorMemoryIdStatement,
      createPathRelationStatement: this.createPathRelationStatement,
      updatePathRelationLegitimacyStatement: this.updatePathRelationLegitimacyStatement,
      createSynthesisCapsuleStatement: this.createSynthesisCapsuleStatement,
      createPendingResolutionFailure: (proposalId) => this.createPendingResolutionFailure(proposalId)
    };
  }

  private updatePendingResolutionEventsTransaction(
    parsed: ParsedPendingResolutionUpdate,
    events: readonly ProposalResolutionEventInput[]
  ): Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }> {
    return this.db.connection.transaction(() => {
      const storedEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
      const result = this.runPendingResolutionUpdate(parsed);

      if (result.changes === 0) {
        throw this.createPendingResolutionFailure(parsed.proposalId);
      }

      return deepFreeze({
        proposal: this.findRequiredProposalAfterPendingUpdate(parsed.proposalId),
        events: storedEvents
      });
    })();
  }

  private runPendingResolutionUpdate(parsed: ParsedPendingResolutionUpdate): { readonly changes: number } {
    if (parsed.reviewerIdentity === undefined) {
      return this.updatePendingResolutionStatement.run(parsed.state, parsed.updatedAt, parsed.proposalId);
    }
    return this.updatePendingResolutionWithIdentityStatement.run(
      parsed.state,
      parsed.updatedAt,
      parsed.reviewerIdentity,
      parsed.proposalId
    );
  }

  private findRequiredProposalAfterPendingUpdate(proposalId: string): Readonly<Proposal> {
    const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
    if (row === undefined) {
      throw new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found after update.`);
    }
    return parseProposalRow(row);
  }

  private createPendingResolutionFailure(proposalId: string): StorageError {
    const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
    if (row === undefined) {
      return new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found.`);
    }

    return new StorageError("CONFLICT", `Proposal ${proposalId} is already ${row.resolution_state}.`);
  }


  private findReviewerAssignmentRow(proposalId: string): Readonly<ProposalReviewerAssignment> | null {
    const row = this.findReviewerAssignmentStatement.get(proposalId) as
      | ProposalReviewerAssignmentRow
      | undefined;
    return row === undefined ? null : parseProposalReviewerAssignmentRow(row);
  }
}

function parsePendingResolutionUpdate(
  proposalId: string,
  state: ProposalResolutionState,
  updatedAt: string,
  options: UpdatePendingResolutionOptions
): ParsedPendingResolutionUpdate {
  return {
    proposalId: parseProposalId(proposalId),
    state: parseProposalResolutionState(state),
    updatedAt: parseUpdatedAt(updatedAt),
    reviewerIdentity: parseReviewerIdentityOption(options)
  };
}

function parseReviewerIdentityOption(options: UpdatePendingResolutionOptions): string | undefined {
  return options.reviewerIdentity === undefined
    ? undefined
    : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
}
