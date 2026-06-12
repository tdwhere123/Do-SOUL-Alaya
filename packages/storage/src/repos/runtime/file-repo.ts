import {
  FileRecordSchema,
  type EventLogEntry,
  type FileRecord
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  getEventLogWriter,
  insertEventLogEntry,
  type EventLogDraftInput
} from "../shared/event-log-writer.js";
import { parseNonEmptyString } from "../shared/validators.js";

export interface FileRepo {
  create(record: Readonly<FileRecord>): Promise<Readonly<FileRecord>>;
  createWithEvent(
    record: Readonly<FileRecord>,
    event: EventLogDraftInput
  ): Promise<Readonly<{ record: Readonly<FileRecord>; event: EventLogEntry }>>;
  findById(fileId: string): Promise<Readonly<FileRecord> | null>;
  findByRunId(runId: string): Promise<readonly Readonly<FileRecord>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<FileRecord>[]>;
}

interface FileRow {
  readonly file_id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly storage_path: string;
  readonly workspace_id: string | null;
  readonly run_id: string | null;
  readonly created_at: string;
}

const FILE_SELECT_COLUMNS = `
        file_id,
        filename,
        mime_type,
        size_bytes,
        storage_path,
        workspace_id,
        run_id,
        created_at
`;

export class SqliteFileRepo implements FileRepo {
  private readonly createStatement;
  private readonly eventLogWriter;
  private readonly findByIdStatement;
  private readonly findByRunIdStatement;
  private readonly findByWorkspaceIdStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO files (
        file_id,
        filename,
        mime_type,
        size_bytes,
        storage_path,
        workspace_id,
        run_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.eventLogWriter = getEventLogWriter(db.connection);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${FILE_SELECT_COLUMNS}
      FROM files
      WHERE file_id = ?
      LIMIT 1
    `);

    this.findByRunIdStatement = db.connection.prepare(`
      SELECT${FILE_SELECT_COLUMNS}
      FROM files
      WHERE run_id = ?
      ORDER BY created_at DESC, file_id DESC
    `);

    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT${FILE_SELECT_COLUMNS}
      FROM files
      WHERE workspace_id = ?
      ORDER BY created_at DESC, file_id DESC
    `);
  }

  public async create(record: Readonly<FileRecord>): Promise<Readonly<FileRecord>> {
    const parsedRecord = parseFileRecord(record);

    try {
      this.createStatement.run(
        parsedRecord.file_id,
        parsedRecord.filename,
        parsedRecord.mime_type,
        parsedRecord.size_bytes,
        parsedRecord.storage_path,
        parsedRecord.workspace_id,
        parsedRecord.run_id,
        parsedRecord.created_at
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create file ${parsedRecord.file_id}.`, error);
    }

    return parsedRecord;
  }

  public async createWithEvent(
    record: Readonly<FileRecord>,
    event: EventLogDraftInput
  ): Promise<Readonly<{ record: Readonly<FileRecord>; event: EventLogEntry }>> {
    const parsedRecord = parseFileRecord(record);

    try {
      return this.db.connection.transaction(() => {
        const storedEvent = insertEventLogEntry(this.eventLogWriter, event);

        this.createStatement.run(
          parsedRecord.file_id,
          parsedRecord.filename,
          parsedRecord.mime_type,
          parsedRecord.size_bytes,
          parsedRecord.storage_path,
          parsedRecord.workspace_id,
          parsedRecord.run_id,
          parsedRecord.created_at
        );

        return {
          record: parsedRecord,
          event: storedEvent
        };
      })();
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create file ${parsedRecord.file_id}.`, error);
    }
  }

  public async findById(fileId: string): Promise<Readonly<FileRecord> | null> {
    const parsedFileId = parseNonEmptyString(fileId, "file_id");

    try {
      const row = this.findByIdStatement.get(parsedFileId) as FileRow | undefined;
      return row === undefined ? null : parseFileRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load file ${parsedFileId}.`, error);
    }
  }

  public async findByRunId(runId: string): Promise<readonly Readonly<FileRecord>[]> {
    const parsedRunId = parseNonEmptyString(runId, "run_id");

    try {
      const rows = this.findByRunIdStatement.all(parsedRunId) as FileRow[];
      return rows.map((row) => parseFileRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list files for run ${parsedRunId}.`, error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<FileRecord>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");

    try {
      const rows = this.findByWorkspaceIdStatement.all(parsedWorkspaceId) as FileRow[];
      return rows.map((row) => parseFileRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list files for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }
}

function parseFileRecord(record: Readonly<FileRecord>): Readonly<FileRecord> {
  try {
    return deepFreeze(FileRecordSchema.parse(record));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate file record.", error);
  }
}

function parseFileRow(row: FileRow): Readonly<FileRecord> {
  try {
    return deepFreeze(
      FileRecordSchema.parse({
        file_id: row.file_id,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        storage_path: row.storage_path,
        workspace_id: row.workspace_id,
        run_id: row.run_id,
        created_at: row.created_at
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate file row.", error);
  }
}
