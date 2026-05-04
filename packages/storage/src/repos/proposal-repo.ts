import {
  ProposalResolutionStateSchema,
  ProposalSchema,
  type EventLogEntry,
  type Proposal,
  type ProposalResolutionState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import {
  getEventLogWriter,
  insertEventLogEntry,
  type EventLogDraftInput
} from "./shared/event-log-writer.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

export interface ProposalCreateInput {
  readonly proposal: Proposal;
  readonly workspace_id: string;
  readonly run_id: string | null;
  // A1 (HITL daemon backbone) — these are optional so legacy callers
  // (claim/synthesis-driven proposals; existing fixtures) keep working
  // unchanged. The MCP-driven proposeMemoryUpdate path always supplies
  // them so the soul.list_pending_proposals projection is populated.
  readonly target_object_kind?: string;
  readonly proposed_change_summary?: string;
  readonly created_at?: string;
}

export interface ScopedProposal {
  readonly proposal: Readonly<Proposal>;
  readonly workspace_id: string;
  readonly run_id: string | null;
  // A1 — null until the proposal is reviewed; carries the explicit
  // reviewer identity once review_memory_proposal completes.
  readonly reviewer_identity: string | null;
}

export interface PendingProposalSummary {
  readonly proposal_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly created_at: string;
  readonly proposed_change_summary: string;
}

export interface FindPendingSummariesOptions {
  readonly since?: string | null;
  readonly limit?: number;
}

export type ProposalResolutionEventInput = EventLogDraftInput;
export type ProposalCreationEventInput = EventLogDraftInput;

export interface UpdatePendingResolutionOptions {
  readonly reviewerIdentity?: string;
}

export interface ProposalRepo {
  create(input: ProposalCreateInput): Promise<Readonly<Proposal>>;
  createProposalWithEvents(
    input: ProposalCreateInput,
    events: readonly ProposalCreationEventInput[]
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findScopedById(proposalId: string): Promise<Readonly<ScopedProposal> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  findPendingSummaries(
    workspaceId: string,
    options?: FindPendingSummariesOptions
  ): Promise<readonly Readonly<PendingProposalSummary>[]>;
  findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null>;
  // A1 fix-loop (finding-5): reviewerIdentity is optional at the repo
  // boundary so legacy callers (claim-promotion flows, fixtures) keep
  // compiling, but every code path that should write
  // resolution_state ∈ ('accepted','rejected') now passes it. The
  // SqliteProposalRepo writes the column when present and leaves it
  // untouched when omitted.
  updateResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    reviewerIdentity?: string
  ): Promise<Readonly<Proposal>>;
  updatePendingResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string
  ): Promise<Readonly<Proposal>>;
  updatePendingResolutionWithEvents(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    options?: UpdatePendingResolutionOptions
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
}

const PROPOSAL_SELECT_COLUMNS = `
        runtime_id,
        object_kind,
        proposal_id,
        task_surface_ref,
        derived_from,
        retention_policy,
        dossier_ref,
        recommended_option_id,
        proposal_options,
        resolution_state,
        expires_at,
        last_updated_at,
        workspace_id,
        run_id,
        reviewer_identity,
        target_object_kind,
        proposed_change_summary,
        created_at
`;

interface ProposalRow {
  readonly runtime_id: string;
  readonly object_kind: string;
  readonly proposal_id: string;
  readonly task_surface_ref: string | null;
  readonly derived_from: string | null;
  readonly retention_policy: string;
  readonly dossier_ref: string | null;
  readonly recommended_option_id: string | null;
  readonly proposal_options: string;
  readonly resolution_state: string;
  readonly expires_at: string | null;
  readonly last_updated_at: string;
  // Scope metadata — available for workspace validation, not exposed in domain type.
  readonly workspace_id: string;
  readonly run_id: string | null;
  // A1 — review identity + HITL summary projection columns.
  readonly reviewer_identity: string | null;
  readonly target_object_kind: string;
  readonly proposed_change_summary: string;
  readonly created_at: string | null;
}

export class SqliteProposalRepo implements ProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findPendingStatement;
  private readonly findPendingByRunIdStatement;
  private readonly updateResolutionStatement;
  private readonly updateResolutionWithIdentityStatement;
  private readonly updatePendingResolutionStatement;
  private readonly updatePendingResolutionWithIdentityStatement;
  private readonly eventLogWriter;

  public constructor(private readonly db: StorageDatabase) {
    // A1 — INSERT now also writes the HITL projection columns
    // (target_object_kind, proposed_change_summary, created_at).
    // Defaults from migration 058 keep legacy callers compatible if
    // they pass undefined for those fields.
    this.createStatement = db.connection.prepare(`
      INSERT INTO proposals (
        runtime_id,
        object_kind,
        proposal_id,
        task_surface_ref,
        derived_from,
        retention_policy,
        dossier_ref,
        recommended_option_id,
        proposal_options,
        resolution_state,
        expires_at,
        last_updated_at,
        workspace_id,
        run_id,
        target_object_kind,
        proposed_change_summary,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE proposal_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ?
      ORDER BY last_updated_at DESC, proposal_id DESC
    `);

    this.findPendingStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
      ORDER BY last_updated_at DESC, proposal_id DESC
    `);

    this.findPendingByRunIdStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE run_id = ? AND resolution_state = 'pending' AND dossier_ref IS NOT NULL
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT 1
    `);

    this.updateResolutionStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?
      WHERE proposal_id = ?
    `);

    // A1 fix-loop (finding-5): companion statement for the legacy
    // updateResolution path that also persists reviewer_identity.
    this.updateResolutionWithIdentityStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?, reviewer_identity = ?
      WHERE proposal_id = ?
    `);

    this.updatePendingResolutionStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?
      WHERE proposal_id = ? AND resolution_state = 'pending'
    `);

    this.updatePendingResolutionWithIdentityStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?, reviewer_identity = ?
      WHERE proposal_id = ? AND resolution_state = 'pending'
    `);

    this.eventLogWriter = getEventLogWriter(db.connection);
  }

  public async create(input: ProposalCreateInput): Promise<Readonly<Proposal>> {
    const parsedProposal = parseProposal(input.proposal);
    const parsedWorkspaceId = parseWorkspaceId(input.workspace_id);
    const parsedRunId = parseRunId(input.run_id);
    const targetObjectKind = input.target_object_kind ?? "memory_entry";
    const proposedChangeSummary = input.proposed_change_summary ?? "";
    const createdAt = input.created_at ?? parsedProposal.last_updated_at;

    try {
      this.createStatement.run(
        parsedProposal.runtime_id,
        parsedProposal.object_kind,
        parsedProposal.proposal_id,
        parsedProposal.task_surface_ref,
        parsedProposal.derived_from,
        parsedProposal.retention_policy,
        parsedProposal.dossier_ref,
        parsedProposal.recommended_option_id,
        JSON.stringify(parsedProposal.proposal_options),
        parsedProposal.resolution_state,
        parsedProposal.expires_at,
        parsedProposal.last_updated_at,
        parsedWorkspaceId,
        parsedRunId,
        targetObjectKind,
        proposedChangeSummary,
        createdAt
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create proposal ${parsedProposal.proposal_id}.`,
        error
      );
    }

    return parsedProposal;
  }

  public async createProposalWithEvents(
    input: ProposalCreateInput,
    events: readonly ProposalCreationEventInput[]
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposal = parseProposal(input.proposal);
    const parsedWorkspaceId = parseWorkspaceId(input.workspace_id);
    const parsedRunId = parseRunId(input.run_id);
    const targetObjectKind = input.target_object_kind ?? "memory_entry";
    const proposedChangeSummary = input.proposed_change_summary ?? "";
    const createdAt = input.created_at ?? parsedProposal.last_updated_at;

    try {
      return this.db.connection.transaction(() => {
        const storedEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        this.createStatement.run(
          parsedProposal.runtime_id,
          parsedProposal.object_kind,
          parsedProposal.proposal_id,
          parsedProposal.task_surface_ref,
          parsedProposal.derived_from,
          parsedProposal.retention_policy,
          parsedProposal.dossier_ref,
          parsedProposal.recommended_option_id,
          JSON.stringify(parsedProposal.proposal_options),
          parsedProposal.resolution_state,
          parsedProposal.expires_at,
          parsedProposal.last_updated_at,
          parsedWorkspaceId,
          parsedRunId,
          targetObjectKind,
          proposedChangeSummary,
          createdAt
        );

        return deepFreeze({
          proposal: parsedProposal,
          events: storedEvents
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create proposal ${parsedProposal.proposal_id} with creation events.`,
        error
      );
    }
  }

  public async findById(proposalId: string): Promise<Readonly<Proposal> | null> {
    try {
      const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
      return row === undefined ? null : parseProposalRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load proposal ${proposalId}.`, error);
    }
  }

  public async findScopedById(proposalId: string): Promise<Readonly<ScopedProposal> | null> {
    try {
      const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
      return row === undefined
        ? null
        : deepFreeze({
            proposal: parseProposalRow(row),
            workspace_id: row.workspace_id,
            run_id: row.run_id,
            reviewer_identity: row.reviewer_identity
          });
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load proposal ${proposalId}.`, error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows = this.findByWorkspaceIdStatement.all(parsedWorkspaceId) as ProposalRow[];
      return rows.map((row) => parseProposalRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows = this.findPendingStatement.all(parsedWorkspaceId) as ProposalRow[];
      return rows.map((row) => parseProposalRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list pending proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  // A1 (HITL daemon backbone) — projects pending rows into the
  // soul.list_pending_proposals summary shape. Built dynamically so the
  // optional since / limit filters compose; the underlying findPending
  // result is already workspace-scoped to keep the SECURITY invariant.
  public async findPendingSummaries(
    workspaceId: string,
    options: FindPendingSummariesOptions = {}
  ): Promise<readonly Readonly<PendingProposalSummary>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const since = options.since ?? null;
    const limit = options.limit ?? null;

    let sql = `
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
    `;
    const params: (string | number)[] = [parsedWorkspaceId];
    if (since !== null) {
      sql += " AND created_at >= ?";
      params.push(since);
    }
    sql += " ORDER BY created_at DESC, proposal_id DESC";
    if (limit !== null) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    try {
      const rows = this.db.connection.prepare(sql).all(...params) as ProposalRow[];
      return rows.map((row) =>
        deepFreeze({
          proposal_id: row.proposal_id,
          // derived_from is nullable in the proposals schema; for the
          // MCP-driven proposeMemoryUpdate path it is always populated
          // with the target memory id, so falling back to runtime_id
          // keeps the projection total even for legacy/edge rows.
          target_object_id: row.derived_from ?? row.runtime_id,
          target_object_kind: row.target_object_kind,
          created_at: row.created_at ?? row.last_updated_at,
          proposed_change_summary: row.proposed_change_summary
        })
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list pending proposal summaries for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null> {
    const parsedRunId = parseNonEmptyString(runId, "run_id");

    try {
      const row = this.findPendingByRunIdStatement.get(parsedRunId) as ProposalRow | undefined;
      return row === undefined ? null : parseProposalRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load pending bankruptcy proposal for run ${parsedRunId}.`,
        error
      );
    }
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
    // A1 fix-loop (finding-5): persist reviewer_identity through the
    // legacy update path. Empty/whitespace identities are rejected;
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
    const parsedProposalId = parseProposalId(proposalId);
    const parsedState = parseProposalResolutionState(state);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    // A1 — empty/whitespace identities are rejected; if the caller did
    // not pass reviewerIdentity (legacy callers, e.g. claim-promotion
    // flows), the column is left untouched.
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");

    try {
      return this.db.connection.transaction(() => {
        const storedEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        const result =
          reviewerIdentity === undefined
            ? this.updatePendingResolutionStatement.run(parsedState, parsedUpdatedAt, parsedProposalId)
            : this.updatePendingResolutionWithIdentityStatement.run(
                parsedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }

        const row = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (row === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(row),
          events: storedEvents
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update pending proposal ${parsedProposalId} with review events.`,
        error
      );
    }
  }

  private createPendingResolutionFailure(proposalId: string): StorageError {
    const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
    if (row === undefined) {
      return new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found.`);
    }

    return new StorageError("CONFLICT", `Proposal ${proposalId} is already ${row.resolution_state}.`);
  }
}

function parseProposal(value: Proposal): Readonly<Proposal> {
  try {
    return deepFreeze(ProposalSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal.", error);
  }
}

function parseProposalRow(row: ProposalRow): Readonly<Proposal> {
  let proposalOptions: unknown;

  try {
    proposalOptions = JSON.parse(row.proposal_options);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal options JSON.", error);
  }

  try {
    return deepFreeze(
      ProposalSchema.parse({
        runtime_id: row.runtime_id,
        object_kind: row.object_kind,
        proposal_id: row.proposal_id,
        task_surface_ref: row.task_surface_ref,
        derived_from: row.derived_from,
        retention_policy: row.retention_policy,
        dossier_ref: row.dossier_ref,
        recommended_option_id: row.recommended_option_id,
        proposal_options: proposalOptions,
        resolution_state: row.resolution_state,
        expires_at: row.expires_at,
        last_updated_at: row.last_updated_at
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal row.", error);
  }
}

function parseProposalResolutionState(state: ProposalResolutionState): ProposalResolutionState {
  try {
    return ProposalResolutionStateSchema.parse(state);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal resolution state.", error);
  }
}

function parseProposalId(value: string): string {
  return parseNonEmptyString(value, "proposal_id");
}

function parseWorkspaceId(value: string): string {
  return parseNonEmptyString(value, "workspace_id");
}

function parseRunId(value: string | null): string | null {
  return parseNullableString(value, "run_id");
}

const parseUpdatedAt = parseTimestamp;
