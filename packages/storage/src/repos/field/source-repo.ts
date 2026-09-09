import type { FieldContractSha256 } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import {
  parseOptionalRow,
  parseRows,
  readIntegerField,
  readRecord
} from "../shared/parse-row.js";
import {
  assertSubjectNotErased,
  verifyPersistedSourceRecord,
  verifyPersistedSourceSpan
} from "./identity.js";
import {
  fieldSourceEvidenceBindingParser,
  fieldSourceRecordParser,
  fieldSourceSpanParser,
  insertIdempotent,
  persistFieldTransaction
} from "./mappers/mappers.js";
import type {
  FieldSourceEvidenceBindingRow,
  FieldSourceRecordPage,
  FieldSourceRecordPageOptions,
  FieldSourceRecordRepo,
  FieldSourceRecordRow,
  FieldSourceSpanRepo,
  FieldSourceSpanRow
} from "./ports.js";

const SOURCE_RECORD_PAGE_MAX = 512;
const SOURCE_BODY_BYTE_MAX = 65_536;
const UTF8_MAX_TAIL = 3;

const RECORD_SELECT = `
  SELECT record_id, workspace_id, source_id, source_version, content_digest,
         evidence_object_id, recorded_at, event_time, valid_from, valid_to,
         operator_id, source_body
  FROM source_records
`;

// TEXT substr is character-bounded and still materializes oversize CJK bodies.
const RECORD_BOUNDED_SELECT = `
  SELECT record_id, workspace_id, source_id, source_version, content_digest,
         evidence_object_id, recorded_at, event_time, valid_from, valid_to,
         operator_id,
         CASE WHEN source_body IS NULL THEN NULL
              ELSE substr(CAST(source_body AS BLOB), ? + 1, ?)
         END AS source_body_prefix,
         COALESCE(length(CAST(source_body AS BLOB)), 0) AS source_body_bytes
  FROM source_records
`;

export type BoundedSourceRecordRead = Readonly<{
  readonly record: FieldSourceRecordRow;
  readonly bodyBytes: number;
  readonly prefixBytes: number;
  readonly invalidOffset: boolean;
}>;

export type BoundedSourceRecordPage = Readonly<{
  readonly rows: readonly BoundedSourceRecordRead[];
  readonly truncated: boolean;
  readonly committedThrough: string | null;
}>;

const SPAN_SELECT = `
  SELECT span_id, record_id, start_offset, end_offset, purpose, producer_version,
         workspace_id, recorded_at
  FROM source_spans
`;

export class SqliteFieldSourceRecordRepo implements FieldSourceRecordRepo {
  private readonly insertStatement;
  private readonly selectStatement;
  private readonly listStatement;
  private readonly pageStatement;
  private readonly boundedPageStatement;
  private readonly boundedSelectStatement;
  private readonly insertEvidenceBindingStatement;
  private readonly listEvidenceBindingsStatement;

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
    this.pageStatement = database.connection.prepare(`
      ${RECORD_SELECT}
      WHERE workspace_id = ?
        AND source_body IS NOT NULL
        AND (recorded_at > ? OR (recorded_at = ? AND record_id > ?))
      ORDER BY recorded_at ASC, record_id ASC
      LIMIT ?
    `);
    this.boundedPageStatement = database.connection.prepare(`
      ${RECORD_BOUNDED_SELECT}
      WHERE workspace_id = ?
        AND source_body IS NOT NULL
        AND (recorded_at > ? OR (recorded_at = ? AND record_id > ?))
      ORDER BY recorded_at ASC, record_id ASC
      LIMIT ?
    `);
    this.boundedSelectStatement = database.connection.prepare(
      `${RECORD_BOUNDED_SELECT} WHERE workspace_id = ? AND record_id = ? LIMIT 1`
    );
    this.insertEvidenceBindingStatement = database.connection.prepare(`
      INSERT INTO source_record_evidence_refs (
        workspace_id, record_id, evidence_object_id
      ) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, record_id, evidence_object_id) DO NOTHING
    `);
    this.listEvidenceBindingsStatement = database.connection.prepare(`
      SELECT workspace_id, record_id, evidence_object_id
      FROM source_record_evidence_refs
      WHERE workspace_id = ?
      ORDER BY record_id, evidence_object_id
    `);
  }

  public insert(row: FieldSourceRecordRow): FieldSourceRecordRow {
    verifyPersistedSourceRecord(row, this.sha256);
    if (this.findById(row.workspace_id, row.record_id) === null) {
      assertSubjectNotErased(this.database, row.workspace_id, "source_record", row.record_id);
    }
    return persistFieldTransaction(this.database, () => {
      const persisted = insertIdempotent(
        () => this.insertStatement.run(
          row.record_id, row.workspace_id, row.source_id, row.source_version,
          row.content_digest, row.evidence_object_id, row.recorded_at, row.event_time,
          row.valid_from, row.valid_to, row.operator_id, row.source_body
        ),
        () => this.findById(row.workspace_id, row.record_id),
        (existing) => sameRecord(existing, row),
        "source record"
      );
      if (row.evidence_object_id !== null) {
        this.insertEvidenceBindingStatement.run(
          row.workspace_id, row.record_id, row.evidence_object_id
        );
      }
      return persisted;
    }, "source record with evidence binding");
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

  public listPage(workspaceId: string, options: FieldSourceRecordPageOptions): FieldSourceRecordPage {
    const limit = options.limit;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > SOURCE_RECORD_PAGE_MAX) {
      throw new Error("invalid source record page limit");
    }
    if (limit === 0) {
      return { rows: [], truncated: true, committedThrough: encodeRecordCursor(options) };
    }
    const afterRecordedAt = options.afterRecordedAt ?? "";
    const afterRecordId = options.afterRecordId ?? "";
    const rows = parseRows(
      this.pageStatement.all(workspaceId, afterRecordedAt, afterRecordedAt, afterRecordId, limit),
      fieldSourceRecordParser,
      "source record"
    );
    const last = rows.at(-1);
    return {
      rows,
      truncated: rows.length === limit,
      committedThrough: last === undefined
        ? encodeRecordCursor(options)
        : encodeRecordCursor({ afterRecordedAt: last.recorded_at, afterRecordId: last.record_id })
    };
  }

  public listPageBounded(
    workspaceId: string,
    options: FieldSourceRecordPageOptions,
    byteLimit: number
  ): BoundedSourceRecordPage {
    const limit = options.limit;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > SOURCE_RECORD_PAGE_MAX) {
      throw new Error("invalid source record page limit");
    }
    assertSourceBodyByteLimit(byteLimit);
    if (limit === 0) {
      return { rows: [], truncated: true, committedThrough: encodeRecordCursor(options) };
    }
    const afterRecordedAt = options.afterRecordedAt ?? "";
    const afterRecordId = options.afterRecordId ?? "";
    const raw = this.boundedPageStatement.all(
      0,
      byteLimit + UTF8_MAX_TAIL,
      workspaceId,
      afterRecordedAt,
      afterRecordedAt,
      afterRecordId,
      limit
    );
    const rows = parseBoundedRows(raw, byteLimit, 0);
    const last = rows.at(-1)?.record;
    return {
      rows,
      truncated: rows.length === limit,
      committedThrough: last === undefined
        ? encodeRecordCursor(options)
        : encodeRecordCursor({ afterRecordedAt: last.recorded_at, afterRecordId: last.record_id })
    };
  }

  public findByIdBounded(
    workspaceId: string,
    recordId: string,
    byteLimit: number,
    offset: number
  ): BoundedSourceRecordRead | null {
    assertSourceBodyByteLimit(byteLimit);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("invalid source-root byte offset");
    }
    const raw = this.boundedSelectStatement.get(offset, byteLimit + UTF8_MAX_TAIL, workspaceId, recordId);
    if (raw === undefined || raw === null) return null;
    return parseBoundedSourceRecord(raw, byteLimit, offset);
  }

  public listEvidenceBindings(workspaceId: string): readonly FieldSourceEvidenceBindingRow[] {
    return parseRows(
      this.listEvidenceBindingsStatement.all(workspaceId),
      fieldSourceEvidenceBindingParser,
      "source evidence binding"
    );
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

export function encodeRecordCursor(input: Readonly<{
  readonly afterRecordedAt?: string | null;
  readonly afterRecordId?: string | null;
}>): string | null {
  if (input.afterRecordedAt == null || input.afterRecordedAt === "" ||
      input.afterRecordId == null || input.afterRecordId === "") {
    return null;
  }
  return `r:${input.afterRecordedAt}\t${input.afterRecordId}`;
}

export function parseRecordCursor(cursor: string | null | undefined): Readonly<{
  readonly afterRecordedAt: string | null;
  readonly afterRecordId: string | null;
}> {
  if (cursor == null || cursor === "" || !cursor.startsWith("r:")) {
    return { afterRecordedAt: null, afterRecordId: null };
  }
  const payload = cursor.slice(2);
  const split = payload.indexOf("\t");
  if (split <= 0) return { afterRecordedAt: null, afterRecordId: null };
  return {
    afterRecordedAt: payload.slice(0, split),
    afterRecordId: payload.slice(split + 1)
  };
}

function sameRecord(existing: FieldSourceRecordRow, incoming: FieldSourceRecordRow): boolean {
  return existing.source_id === incoming.source_id &&
    existing.source_version === incoming.source_version &&
    existing.content_digest === incoming.content_digest &&
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

function assertSourceBodyByteLimit(byteLimit: number): void {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > SOURCE_BODY_BYTE_MAX) {
    throw new Error("invalid source-root byte limit");
  }
}

function parseBoundedRows(
  values: unknown,
  byteLimit: number,
  offset: number
): readonly BoundedSourceRecordRead[] {
  if (!Array.isArray(values)) {
    throw new Error("invalid bounded source record page");
  }
  return values.map((row) => parseBoundedSourceRecord(row, byteLimit, offset));
}

function parseBoundedSourceRecord(
  value: unknown,
  byteLimit: number,
  offset: number
): BoundedSourceRecordRead {
  const row = readRecord(value, "bounded source record");
  const bodyBytes = readIntegerField(row, "source_body_bytes");
  const prefix = prefixBuffer(row.source_body_prefix);
  if (prefix === null) {
    return {
      record: fieldSourceRecordParser.parse({ ...row, source_body: null }),
      bodyBytes,
      prefixBytes: 0,
      invalidOffset: offset !== 0
    };
  }
  if (offset > bodyBytes || (offset < bodyBytes && prefix.length > 0 && (prefix[0]! & 0xc0) === 0x80)) {
    return {
      record: fieldSourceRecordParser.parse({ ...row, source_body: null }),
      bodyBytes,
      prefixBytes: 0,
      invalidOffset: true
    };
  }
  if (offset === bodyBytes) {
    return {
      record: fieldSourceRecordParser.parse({ ...row, source_body: "" }),
      bodyBytes,
      prefixBytes: 0,
      invalidOffset: false
    };
  }
  const trimmed = trimUtf8Prefix(prefix, byteLimit);
  return {
    record: fieldSourceRecordParser.parse({ ...row, source_body: trimmed.toString("utf8") }),
    bodyBytes,
    prefixBytes: trimmed.length,
    invalidOffset: false
  };
}

function prefixBuffer(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("invalid source body prefix");
}

function trimUtf8Prefix(bytes: Buffer, byteLimit: number): Buffer {
  if (bytes.length === 0) return bytes;
  let end = Math.min(bytes.length, byteLimit);
  while (end > 0 && !isUtf8Boundary(bytes, end)) end -= 1;
  if (end === 0) {
    const lead = bytes[0]!;
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    end = Math.min(bytes.length, width);
  }
  return bytes.subarray(0, end);
}

function isUtf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
}
