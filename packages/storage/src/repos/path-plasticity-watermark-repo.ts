import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface PathPlasticityWatermarkRecord {
  readonly workspace_id: string;
  readonly last_processed_reported_at: string;
  readonly last_processed_audit_event_id: string | null;
  readonly updated_at: string;
}

interface PathPlasticityWatermarkRow {
  readonly workspace_id: string;
  readonly last_processed_reported_at: string;
  readonly last_processed_audit_event_id: string | null;
  readonly updated_at: string;
}

export interface PathPlasticityWatermarkRepo {
  findByWorkspaceId(workspaceId: string): Readonly<PathPlasticityWatermarkRecord> | null;
  upsert(record: PathPlasticityWatermarkRecord): Readonly<PathPlasticityWatermarkRecord>;
}

export class SqlitePathPlasticityWatermarkRepo implements PathPlasticityWatermarkRepo {
  private readonly findByWorkspaceIdStatement;
  private readonly upsertStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT
        workspace_id,
        last_processed_reported_at,
        last_processed_audit_event_id,
        updated_at
      FROM path_plasticity_watermark
      WHERE workspace_id = ?
      LIMIT 1
    `);
    this.upsertStatement = db.connection.prepare(`
      INSERT INTO path_plasticity_watermark (
        workspace_id,
        last_processed_reported_at,
        last_processed_audit_event_id,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        last_processed_reported_at = excluded.last_processed_reported_at,
        last_processed_audit_event_id = excluded.last_processed_audit_event_id,
        updated_at = excluded.updated_at
    `);
  }

  public findByWorkspaceId(workspaceId: string): Readonly<PathPlasticityWatermarkRecord> | null {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.findByWorkspaceIdStatement.get(parsedWorkspaceId) as
        | PathPlasticityWatermarkRow
        | undefined;
      return row === undefined ? null : parsePathPlasticityWatermarkRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load path plasticity watermark for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public upsert(record: PathPlasticityWatermarkRecord): Readonly<PathPlasticityWatermarkRecord> {
    const parsed = parsePathPlasticityWatermarkRecord(record);

    try {
      this.upsertStatement.run(
        parsed.workspace_id,
        parsed.last_processed_reported_at,
        parsed.last_processed_audit_event_id,
        parsed.updated_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to upsert path plasticity watermark for workspace ${parsed.workspace_id}.`,
        error
      );
    }

    const stored = this.findByWorkspaceId(parsed.workspace_id);
    if (stored === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Path plasticity watermark ${parsed.workspace_id} was not found after upsert.`
      );
    }
    return stored;
  }
}

function parsePathPlasticityWatermarkRow(
  row: PathPlasticityWatermarkRow
): Readonly<PathPlasticityWatermarkRecord> {
  return parsePathPlasticityWatermarkRecord(row);
}

function parsePathPlasticityWatermarkRecord(
  record: PathPlasticityWatermarkRecord
): Readonly<PathPlasticityWatermarkRecord> {
  return Object.freeze({
    workspace_id: parseNonEmptyString(record.workspace_id, "workspace id"),
    last_processed_reported_at: parseIsoString(record.last_processed_reported_at, "last processed reported at"),
    last_processed_audit_event_id:
      record.last_processed_audit_event_id === null
        ? null
        : parseNonEmptyString(record.last_processed_audit_event_id, "last processed audit event id"),
    updated_at: parseIsoString(record.updated_at, "updated at")
  });
}

function parseIsoString(value: string, fieldName: string): string {
  const parsed = parseNonEmptyString(value, fieldName);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${fieldName} timestamp.`);
  }
  return parsed;
}
