import {
  GovernanceDriftLeaseSchema,
  SurfaceDriftOperationTypeSchema,
  type GovernanceDriftLease,
  type SurfaceDriftOperationType
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";

interface DriftLeaseRow {
  readonly lease_id: string;
  readonly workspace_id: string;
  readonly operation_type: string;
  readonly granted_to: string;
  readonly drift_id: string | null;
  readonly expires_at: string;
  readonly granted_at: string;
}

const SQLITE_CONSTRAINT_UNIQUE = "SQLITE_CONSTRAINT_UNIQUE";

export interface DriftLeaseRepo {
  create(lease: Readonly<GovernanceDriftLease>): Readonly<GovernanceDriftLease>;
  findActive(workspaceId: string): Promise<readonly Readonly<GovernanceDriftLease>[]>;
  findActiveById(
    workspaceId: string,
    leaseId: string
  ): Promise<Readonly<GovernanceDriftLease> | null>;
  delete(leaseId: string): void;
  deleteExpired(beforeDate: string): number;
}

export class SqliteDriftLeaseRepo implements DriftLeaseRepo {
  private readonly createStatement;
  private readonly findActiveStatement;
  private readonly findActiveByIdStatement;
  private readonly deleteStatement;
  private readonly deleteExpiredStatement;
  private readonly now: () => string;

  public constructor(
    private readonly db: StorageDatabase,
    options: { readonly now?: () => string } = {}
  ) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO drift_leases (
        lease_id,
        workspace_id,
        operation_type,
        granted_to,
        drift_id,
        expires_at,
        granted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.findActiveStatement = db.connection.prepare(`
      SELECT
        lease_id,
        workspace_id,
        operation_type,
        granted_to,
        drift_id,
        expires_at,
        granted_at
      FROM drift_leases
      WHERE workspace_id = ? AND expires_at > ?
      ORDER BY granted_at ASC, lease_id ASC
    `);

    this.findActiveByIdStatement = db.connection.prepare(`
      SELECT
        lease_id,
        workspace_id,
        operation_type,
        granted_to,
        drift_id,
        expires_at,
        granted_at
      FROM drift_leases
      WHERE workspace_id = ? AND lease_id = ? AND expires_at > ?
      LIMIT 1
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM drift_leases
      WHERE lease_id = ?
    `);

    this.deleteExpiredStatement = db.connection.prepare(`
      DELETE FROM drift_leases
      WHERE expires_at <= ?
    `);

    this.now = options.now ?? (() => new Date().toISOString());
  }

  public create(lease: Readonly<GovernanceDriftLease>): Readonly<GovernanceDriftLease> {
    const parsedLease = parseDriftLease(lease);

    try {
      this.createStatement.run(
        parsedLease.lease_id,
        parsedLease.workspace_id,
        parsedLease.operation_type,
        parsedLease.granted_to,
        parsedLease.drift_id,
        parsedLease.expires_at,
        parsedLease.granted_at
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new StorageError(
          "CONFLICT",
          `Active drift lease already exists for workspace ${parsedLease.workspace_id} and operation ${parsedLease.operation_type}.`,
          error
        );
      }

      throw new StorageError("QUERY_FAILED", `Failed to create drift lease ${parsedLease.lease_id}.`, error);
    }

    return parsedLease;
  }

  public async findActive(workspaceId: string): Promise<readonly Readonly<GovernanceDriftLease>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const referenceTime = parseTimestamp(this.now());

    try {
      const rows = this.findActiveStatement.all(parsedWorkspaceId, referenceTime) as DriftLeaseRow[];
      return rows.map((row) => parseDriftLeaseRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list active drift leases for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findActiveById(
    workspaceId: string,
    leaseId: string
  ): Promise<Readonly<GovernanceDriftLease> | null> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedLeaseId = parseNonEmptyString(leaseId, "lease id");
    const referenceTime = parseTimestamp(this.now());

    try {
      const row = this.findActiveByIdStatement.get(
        parsedWorkspaceId,
        parsedLeaseId,
        referenceTime
      ) as DriftLeaseRow | undefined;

      return row === undefined ? null : parseDriftLeaseRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load drift lease ${parsedLeaseId} for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public delete(leaseId: string): void {
    const parsedLeaseId = parseNonEmptyString(leaseId, "lease id");

    try {
      this.deleteStatement.run(parsedLeaseId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete drift lease ${parsedLeaseId}.`, error);
    }
  }

  public deleteExpired(beforeDate: string): number {
    const parsedBeforeDate = parseTimestamp(beforeDate);

    try {
      const result = this.deleteExpiredStatement.run(parsedBeforeDate);
      return result.changes;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete expired drift leases before ${parsedBeforeDate}.`,
        error
      );
    }
  }
}

function parseDriftLease(value: GovernanceDriftLease): Readonly<GovernanceDriftLease> {
  try {
    return deepFreeze(GovernanceDriftLeaseSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate drift lease.", error);
  }
}

function parseDriftLeaseRow(row: DriftLeaseRow): Readonly<GovernanceDriftLease> {
  return parseDriftLease({
    lease_id: row.lease_id,
    workspace_id: row.workspace_id,
    operation_type: parseSurfaceDriftOperationType(row.operation_type),
    granted_to: row.granted_to,
    drift_id: row.drift_id,
    expires_at: row.expires_at,
    granted_at: row.granted_at
  });
}

function parseSurfaceDriftOperationType(value: string): SurfaceDriftOperationType {
  try {
    return SurfaceDriftOperationTypeSchema.parse(value);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to validate drift lease operation type.",
      error
    );
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === SQLITE_CONSTRAINT_UNIQUE;
}
