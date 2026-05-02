import {
  ProposalResolutionStateSchema,
  ProposalSchema,
  type Proposal,
  type ProposalResolutionState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

export interface ProposalCreateInput {
  readonly proposal: Proposal;
  readonly workspace_id: string;
  readonly run_id: string | null;
}

export interface ScopedProposal {
  readonly proposal: Readonly<Proposal>;
  readonly workspace_id: string;
  readonly run_id: string | null;
}

export interface ProposalRepo {
  create(input: ProposalCreateInput): Promise<Readonly<Proposal>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findScopedById(proposalId: string): Promise<Readonly<ScopedProposal> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null>;
  updateResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string
  ): Promise<Readonly<Proposal>>;
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
        run_id
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
}

export class SqliteProposalRepo implements ProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findPendingStatement;
  private readonly findPendingByRunIdStatement;
  private readonly updateResolutionStatement;

  public constructor(private readonly db: StorageDatabase) {
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
        run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  }

  public async create(input: ProposalCreateInput): Promise<Readonly<Proposal>> {
    const parsedProposal = parseProposal(input.proposal);
    const parsedWorkspaceId = parseWorkspaceId(input.workspace_id);
    const parsedRunId = parseRunId(input.run_id);

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
        parsedRunId
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
            run_id: row.run_id
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
    updatedAt: string
  ): Promise<Readonly<Proposal>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedState = parseProposalResolutionState(state);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.updateResolutionStatement.run(parsedState, parsedUpdatedAt, parsedProposalId);

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
