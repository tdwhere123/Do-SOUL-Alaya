import type { FieldContractSha256 } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow, parseRows } from "../shared/parse-row.js";
import {
  assertSubjectNotErased,
  verifyPersistedSourceRecord,
  verifyPersistedSourceSpan
} from "./identity.js";
import {
  fieldSourceRecordParser,
  fieldSourceSpanParser,
  insertIdempotent
} from "./mappers.js";
import type {
  FieldSourceRecordRepo,
  FieldSourceRecordRow,
  FieldSourceSpanRepo,
  FieldSourceSpanRow
} from "./ports.js";

const RECORD_SELECT = `
  SELECT record_id, workspace_id, source_id, source_version, content_digest,
         evidence_object_id, recorded_at, event_time, valid_from, valid_to,
         operator_id, source_body
  FROM source_records
`;

const SPAN_SELECT = `
  SELECT span_id, record_id, start_offset, end_offset, purpose, producer_version,
         workspace_id, recorded_at
  FROM source_spans
`;

export class SqliteFieldSourceRecordRepo implements FieldSourceRecordRepo {
  private readonly insertStatement;
  private readonly selectStatement;
  private readonly listStatement;

  public constructor(
    private readonly database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO source_records (
        record_id, workspace_id, source_id, source_version, content_digest,
        evidence_object_id, recorded_at, event_time, valid_from, valid_to,
        operator_id, source_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, record_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(
      `${RECORD_SELECT} WHERE workspace_id = ? AND record_id = ? LIMIT 1`
    );
    this.listStatement = database.connection.prepare(
      `${RECORD_SELECT} WHERE workspace_id = ? ORDER BY record_id`
    );
  }

  public insert(row: FieldSourceRecordRow): FieldSourceRecordRow {
    verifyPersistedSourceRecord(row, this.sha256);
    if (this.findById(row.workspace_id, row.record_id) === null) {
      assertSubjectNotErased(this.database, row.workspace_id, "source_record", row.record_id);
    }
    return insertIdempotent(
      () => this.insertStatement.run(
        row.record_id,
        row.workspace_id,
        row.source_id,
        row.source_version,
        row.content_digest,
        row.evidence_object_id,
        row.recorded_at,
        row.event_time,
        row.valid_from,
        row.valid_to,
        row.operator_id,
        row.source_body
      ),
      () => this.findById(row.workspace_id, row.record_id),
      (existing) => sameRecord(existing, row),
      "source record"
    );
  }

  public findById(workspaceId: string, recordId: string): FieldSourceRecordRow | null {
    return parseOptionalRow(
      this.selectStatement.get(workspaceId, recordId),
      fieldSourceRecordParser,
      "source record"
    );
  }

  public listByWorkspace(workspaceId: string): readonly FieldSourceRecordRow[] {
    return parseRows(this.listStatement.all(workspaceId), fieldSourceRecordParser, "source record");
  }
}

export class SqliteFieldSourceSpanRepo implements FieldSourceSpanRepo {
  private readonly insertStatement;
  private readonly selectStatement;
  private readonly listStatement;

  public constructor(
    database: StorageDatabase,
    private readonly sha256: FieldContractSha256
  ) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO source_spans (
        span_id, record_id, start_offset, end_offset, purpose, producer_version,
        workspace_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, span_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(
      `${SPAN_SELECT} WHERE workspace_id = ? AND span_id = ? LIMIT 1`
    );
    this.listStatement = database.connection.prepare(
      `${SPAN_SELECT} WHERE workspace_id = ? ORDER BY span_id`
    );
  }

  public insert(row: FieldSourceSpanRow): FieldSourceSpanRow {
    verifyPersistedSourceSpan(row, this.sha256);
    return insertIdempotent(
      () => this.insertStatement.run(
        row.span_id,
        row.record_id,
        row.start_offset,
        row.end_offset,
        row.purpose,
        row.producer_version,
        row.workspace_id,
        row.recorded_at
      ),
      () => this.findById(row.workspace_id, row.span_id),
      (existing) => sameSpan(existing, row),
      "source span"
    );
  }

  public findById(workspaceId: string, spanId: string): FieldSourceSpanRow | null {
    return parseOptionalRow(
      this.selectStatement.get(workspaceId, spanId),
      fieldSourceSpanParser,
      "source span"
    );
  }

  public listByWorkspace(workspaceId: string): readonly FieldSourceSpanRow[] {
    return parseRows(this.listStatement.all(workspaceId), fieldSourceSpanParser, "source span");
  }
}

function sameRecord(existing: FieldSourceRecordRow, incoming: FieldSourceRecordRow): boolean {
  return existing.source_id === incoming.source_id &&
    existing.source_version === incoming.source_version &&
    existing.content_digest === incoming.content_digest &&
    existing.evidence_object_id === incoming.evidence_object_id &&
    existing.operator_id === incoming.operator_id &&
    existing.event_time === incoming.event_time &&
    existing.valid_from === incoming.valid_from &&
    existing.valid_to === incoming.valid_to;
}

function sameSpan(existing: FieldSourceSpanRow, incoming: FieldSourceSpanRow): boolean {
  return existing.record_id === incoming.record_id &&
    existing.start_offset === incoming.start_offset &&
    existing.end_offset === incoming.end_offset &&
    existing.purpose === incoming.purpose &&
    existing.producer_version === incoming.producer_version;
}
