import type { StorageDatabase } from "../../sqlite/db.js";
import { parseOptionalRow } from "../shared/parse-row.js";
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

export class SqliteFieldSourceRecordRepo implements FieldSourceRecordRepo {
  private readonly insertStatement;
  private readonly selectStatement;

  public constructor(database: StorageDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO source_records (
        record_id, workspace_id, source_id, source_version, content_digest,
        evidence_object_id, recorded_at, operator_version, source_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT record_id, workspace_id, source_id, source_version, content_digest,
             evidence_object_id, recorded_at, operator_version, source_body
      FROM source_records WHERE record_id = ? LIMIT 1
    `);
  }

  public insert(row: FieldSourceRecordRow): FieldSourceRecordRow {
    return insertIdempotent(
      () => this.insertStatement.run(
        row.record_id,
        row.workspace_id,
        row.source_id,
        row.source_version,
        row.content_digest,
        row.evidence_object_id,
        row.recorded_at,
        row.operator_version,
        row.source_body
      ),
      () => this.findById(row.record_id),
      (existing) => sameRecord(existing, row),
      "source record"
    );
  }

  public findById(recordId: string): FieldSourceRecordRow | null {
    return parseOptionalRow(
      this.selectStatement.get(recordId),
      fieldSourceRecordParser,
      "source record"
    );
  }
}

export class SqliteFieldSourceSpanRepo implements FieldSourceSpanRepo {
  private readonly insertStatement;
  private readonly selectStatement;

  public constructor(database: StorageDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO source_spans (
        span_id, record_id, start_offset, end_offset, purpose, producer_version, workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(span_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(`
      SELECT span_id, record_id, start_offset, end_offset, purpose, producer_version, workspace_id
      FROM source_spans WHERE span_id = ? LIMIT 1
    `);
  }

  public insert(row: FieldSourceSpanRow): FieldSourceSpanRow {
    return insertIdempotent(
      () => this.insertStatement.run(
        row.span_id,
        row.record_id,
        row.start_offset,
        row.end_offset,
        row.purpose,
        row.producer_version,
        row.workspace_id
      ),
      () => this.findById(row.span_id),
      (existing) => sameSpan(existing, row),
      "source span"
    );
  }

  public findById(spanId: string): FieldSourceSpanRow | null {
    return parseOptionalRow(
      this.selectStatement.get(spanId),
      fieldSourceSpanParser,
      "source span"
    );
  }
}

function sameRecord(existing: FieldSourceRecordRow, incoming: FieldSourceRecordRow): boolean {
  return existing.workspace_id === incoming.workspace_id &&
    existing.source_id === incoming.source_id &&
    existing.source_version === incoming.source_version &&
    existing.content_digest === incoming.content_digest &&
    existing.evidence_object_id === incoming.evidence_object_id &&
    existing.operator_version === incoming.operator_version &&
    existing.source_body === incoming.source_body;
}

function sameSpan(existing: FieldSourceSpanRow, incoming: FieldSourceSpanRow): boolean {
  return existing.record_id === incoming.record_id &&
    existing.start_offset === incoming.start_offset &&
    existing.end_offset === incoming.end_offset &&
    existing.purpose === incoming.purpose &&
    existing.producer_version === incoming.producer_version &&
    existing.workspace_id === incoming.workspace_id;
}
