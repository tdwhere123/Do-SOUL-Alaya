import { BootstrappingRecordSchema, type BootstrappingRecord } from "@do-what/protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

interface BootstrappingRecordRow {
  readonly record_id: string;
  readonly workspace_id: string;
  readonly paths_planted: number;
  readonly template_ids_json: string;
  readonly planted_at: string;
}

export interface BootstrappingRecordRepo {
  create(record: BootstrappingRecord): Promise<Readonly<BootstrappingRecord>>;
  findByWorkspace(workspaceId: string): Promise<Readonly<BootstrappingRecord> | null>;
}

const BOOTSTRAPPING_RECORD_SELECT_COLUMNS = `
      record_id,
      workspace_id,
      paths_planted,
      template_ids_json,
      planted_at
`;

export class SqliteBootstrappingRecordRepo implements BootstrappingRecordRepo {
  private readonly createStatement;
  private readonly findByWorkspaceStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO bootstrapping_records (
        record_id,
        workspace_id,
        paths_planted,
        template_ids_json,
        planted_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${BOOTSTRAPPING_RECORD_SELECT_COLUMNS}
      FROM bootstrapping_records
      WHERE workspace_id = ?
      LIMIT 1
    `);
  }

  public async create(record: BootstrappingRecord): Promise<Readonly<BootstrappingRecord>> {
    const parsedRecord = parseBootstrappingRecord(record);

    try {
      this.createStatement.run(
        parsedRecord.record_id,
        parsedRecord.workspace_id,
        parsedRecord.paths_planted,
        JSON.stringify(parsedRecord.template_ids_used),
        parsedRecord.planted_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert bootstrapping record ${parsedRecord.record_id}.`,
        error
      );
    }

    const persistedRecord = await this.findByWorkspace(parsedRecord.workspace_id);
    if (persistedRecord === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Inserted bootstrapping record ${parsedRecord.record_id} could not be reloaded.`
      );
    }

    return persistedRecord;
  }

  public async findByWorkspace(
    workspaceId: string
  ): Promise<Readonly<BootstrappingRecord> | null> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.findByWorkspaceStatement.get(parsedWorkspaceId) as
        | BootstrappingRecordRow
        | undefined;
      return row === undefined ? null : parseBootstrappingRecordRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load bootstrapping record for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }
}

function parseBootstrappingRecord(value: BootstrappingRecord): Readonly<BootstrappingRecord> {
  try {
    return deepFreeze(BootstrappingRecordSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate bootstrapping record.", error);
  }
}

function parseBootstrappingRecordRow(row: BootstrappingRecordRow): Readonly<BootstrappingRecord> {
  return parseBootstrappingRecord({
    record_id: parseNonEmptyString(row.record_id, "record id"),
    workspace_id: parseNonEmptyString(row.workspace_id, "workspace id"),
    paths_planted: row.paths_planted,
    template_ids_used: parseTemplateIds(row.template_ids_json),
    planted_at: parseTimestamp(row.planted_at)
  });
}

function parseTemplateIds(rawTemplateIds: string): readonly string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawTemplateIds);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse template_ids_json.", error);
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to validate template_ids_json in bootstrapping record."
    );
  }

  return parsed;
}
