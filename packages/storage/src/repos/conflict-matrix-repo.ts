import {
  ConflictEdgeTypeSchema,
  ConflictMatrixEdgeSchema,
  type ConflictEdgeType,
  type ConflictMatrixEdge
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface ConflictMatrixRepo {
  create(edge: Readonly<ConflictMatrixEdge>): Promise<Readonly<ConflictMatrixEdge>>;
  findById(objectId: string): Promise<Readonly<ConflictMatrixEdge> | null>;
  findBySourceClaim(claimId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]>;
  findByTargetClaim(claimId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]>;
  findBetweenClaims(
    sourceClaimId: string,
    targetClaimId: string
  ): Promise<readonly Readonly<ConflictMatrixEdge>[]>;
  delete(objectId: string): Promise<void>;
}

const CONFLICT_MATRIX_EDGE_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        source_claim_id,
        target_claim_id,
        edge_type,
        workspace_id
`;

interface ConflictMatrixEdgeRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly source_claim_id: string;
  readonly target_claim_id: string;
  readonly edge_type: string;
  readonly workspace_id: string;
}

export class SqliteConflictMatrixRepo implements ConflictMatrixRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findBySourceClaimStatement;
  private readonly findByTargetClaimStatement;
  private readonly findByWorkspaceStatement;
  private readonly findBetweenClaimsStatement;
  private readonly deleteStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO conflict_matrix_edges (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        source_claim_id,
        target_claim_id,
        edge_type,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${CONFLICT_MATRIX_EDGE_SELECT_COLUMNS}
      FROM conflict_matrix_edges
      WHERE object_id = ?
      LIMIT 1
    `);

    this.findBySourceClaimStatement = db.connection.prepare(`
      SELECT${CONFLICT_MATRIX_EDGE_SELECT_COLUMNS}
      FROM conflict_matrix_edges
      WHERE source_claim_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findByTargetClaimStatement = db.connection.prepare(`
      SELECT${CONFLICT_MATRIX_EDGE_SELECT_COLUMNS}
      FROM conflict_matrix_edges
      WHERE target_claim_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${CONFLICT_MATRIX_EDGE_SELECT_COLUMNS}
      FROM conflict_matrix_edges
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findBetweenClaimsStatement = db.connection.prepare(`
      SELECT${CONFLICT_MATRIX_EDGE_SELECT_COLUMNS}
      FROM conflict_matrix_edges
      WHERE (source_claim_id = ? AND target_claim_id = ?)
         OR (source_claim_id = ? AND target_claim_id = ?)
      ORDER BY created_at ASC, object_id ASC
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM conflict_matrix_edges
      WHERE object_id = ?
    `);
  }

  public async create(edge: Readonly<ConflictMatrixEdge>): Promise<Readonly<ConflictMatrixEdge>> {
    const parsedEdge = parseConflictMatrixEdge(edge);

    try {
      this.createStatement.run(
        parsedEdge.object_id,
        parsedEdge.object_kind,
        parsedEdge.schema_version,
        parsedEdge.lifecycle_state,
        parsedEdge.created_at,
        parsedEdge.updated_at,
        parsedEdge.created_by,
        parsedEdge.source_claim_id,
        parsedEdge.target_claim_id,
        parsedEdge.edge_type,
        parsedEdge.workspace_id
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create conflict matrix edge ${parsedEdge.object_id}.`,
        error
      );
    }

    return parsedEdge;
  }

  public async findById(objectId: string): Promise<Readonly<ConflictMatrixEdge> | null> {
    const parsedObjectId = parseObjectId(objectId);

    try {
      const row = this.findByIdStatement.get(parsedObjectId) as ConflictMatrixEdgeRow | undefined;
      return row === undefined ? null : parseConflictMatrixEdgeRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load conflict matrix edge ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findBySourceClaim(claimId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    const parsedClaimId = parseClaimId(claimId);

    try {
      const rows = this.findBySourceClaimStatement.all(parsedClaimId) as ConflictMatrixEdgeRow[];
      return rows.map((row) => parseConflictMatrixEdgeRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict matrix edges by source claim ${parsedClaimId}.`,
        error
      );
    }
  }

  public async findByTargetClaim(claimId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    const parsedClaimId = parseClaimId(claimId);

    try {
      const rows = this.findByTargetClaimStatement.all(parsedClaimId) as ConflictMatrixEdgeRow[];
      return rows.map((row) => parseConflictMatrixEdgeRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict matrix edges by target claim ${parsedClaimId}.`,
        error
      );
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as ConflictMatrixEdgeRow[];
      return rows.map((row) => parseConflictMatrixEdgeRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict matrix edges for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findBetweenClaims(
    sourceClaimId: string,
    targetClaimId: string
  ): Promise<readonly Readonly<ConflictMatrixEdge>[]> {
    const parsedSourceClaimId = parseClaimId(sourceClaimId);
    const parsedTargetClaimId = parseClaimId(targetClaimId);

    try {
      const rows = this.findBetweenClaimsStatement.all(
        parsedSourceClaimId,
        parsedTargetClaimId,
        parsedTargetClaimId,
        parsedSourceClaimId
      ) as ConflictMatrixEdgeRow[];
      return rows.map((row) => parseConflictMatrixEdgeRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list conflict matrix edges between claims ${parsedSourceClaimId} and ${parsedTargetClaimId}.`,
        error
      );
    }
  }

  public async delete(objectId: string): Promise<void> {
    const parsedObjectId = parseObjectId(objectId);

    try {
      const result = this.deleteStatement.run(parsedObjectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Conflict matrix edge ${parsedObjectId} was not found.`);
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete conflict matrix edge ${parsedObjectId}.`,
        error
      );
    }
  }
}

function parseConflictMatrixEdge(value: Readonly<ConflictMatrixEdge>): Readonly<ConflictMatrixEdge> {
  try {
    return deepFreeze(ConflictMatrixEdgeSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate conflict matrix edge.", error);
  }
}

function parseConflictMatrixEdgeRow(row: ConflictMatrixEdgeRow): Readonly<ConflictMatrixEdge> {
  try {
    return deepFreeze(
      ConflictMatrixEdgeSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        source_claim_id: row.source_claim_id,
        target_claim_id: row.target_claim_id,
        edge_type: parseEdgeType(row.edge_type),
        workspace_id: row.workspace_id
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate conflict matrix edge row.", error);
  }
}

function parseObjectId(value: string): string {
  return parseNonEmptyString(value, "conflict matrix edge object id");
}

function parseClaimId(value: string): string {
  return parseNonEmptyString(value, "claim id");
}

function parseWorkspaceId(value: string): string {
  return parseNonEmptyString(value, "workspace id");
}

function parseEdgeType(value: string): ConflictEdgeType {
  try {
    return ConflictEdgeTypeSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate edge_type ${value}.`, error);
  }
}
