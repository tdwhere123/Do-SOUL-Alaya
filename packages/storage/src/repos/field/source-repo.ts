import type { FieldContractSha256 } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { readRetainedSourceChunk, writeRetainedSourceChunks } from "./retained-source-chunks.js";
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
const SOURCE_METADATA_BYTE_MAX = 7864;
const SOURCE_METADATA_COLUMNS = ["record_id", "workspace_id", "source_id", "source_version", "content_digest",
  "evidence_object_id", "recorded_at", "event_time", "valid_from", "valid_to", "operator_id", "speaker", "scope_class"] as const;
const METADATA_BYTES = SOURCE_METADATA_COLUMNS.map((column) => `COALESCE(octet_length(${column}), 0)`).join(" + ");

const RECORD_SELECT = `
  SELECT record_id, workspace_id, source_id, source_version, content_digest,
         evidence_object_id, recorded_at, event_time, valid_from, valid_to,
         operator_id, speaker, scope_class, source_body
  FROM source_records
`;

// The canonical body is never selected by a Recall read. Even BLOB substr
// materializes a complete TEXT value inside SQLite before returning its prefix.
const RECORD_BOUNDED_SELECT = `
  SELECT ${SOURCE_METADATA_COLUMNS.map((column) =>
    `CASE WHEN (${METADATA_BYTES}) <= ${SOURCE_METADATA_BYTE_MAX} THEN ${column} ELSE NULL END AS ${column}`).join(", ")},
         (${METADATA_BYTES}) > ${SOURCE_METADATA_BYTE_MAX} AS metadata_limited,
         (SELECT CASE WHEN octet_length(evidence_object_id) <= 256 THEN evidence_object_id ELSE NULL END FROM source_record_active_evidence_refs ref
           WHERE ref.workspace_id = source_records.workspace_id AND ref.record_id = source_records.record_id
           ORDER BY evidence_object_id LIMIT 1) AS effective_evidence_object_id,
         CASE WHEN retained_content_bytes = octet_length(source_body) THEN retained_content_bytes ELSE NULL END AS source_body_bytes,
         octet_length(source_body) IS NOT NULL AS body_retained
  FROM source_records
`;

export type BoundedSourceRecordRead = Readonly<{
  readonly record: FieldSourceRecordRow | null;
  readonly bodyBytes: number;
  readonly prefixBytes: number;
  readonly invalidOffset: boolean;
  readonly evidenceVerified: boolean;
  readonly nativeBytes: number;
  readonly metadataBytes: number;
}>;

export type BoundedSourceRecordPage = Readonly<{
  readonly rows: readonly BoundedSourceRecordRead[];
  readonly truncated: boolean;
  readonly committedThrough: string | null;
  readonly unavailable?: boolean;
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
        operator_id, speaker, scope_class, source_body, retained_content_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        AND (recorded_at, record_id) > (?, ?)
      ORDER BY recorded_at ASC, record_id ASC
      LIMIT ?
    `);
    this.boundedPageStatement = database.connection.prepare(`
      ${RECORD_BOUNDED_SELECT}
      WHERE workspace_id = ?
        AND (recorded_at, record_id) > (?, ?)
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
      const existing = this.findById(row.workspace_id, row.record_id);
      // A matching erased identity remains a tombstone even when its formerly
      // bound capsule has also been erased. No replay may recreate either body.
      if (existing?.source_body === null && sameRecord(existing, row)) return existing;
      if (row.evidence_object_id !== null && !this.verifiedEvidenceBinding(row.workspace_id, row.evidence_object_id)) {
        throw new Error("source evidence binding requires an active capsule in the same workspace");
      }
      const persisted = insertIdempotent(
        () => this.insertStatement.run(
          row.record_id, row.workspace_id, row.source_id, row.source_version,
          row.content_digest, row.evidence_object_id, row.recorded_at, row.event_time,
          row.valid_from, row.valid_to, row.operator_id, row.speaker, row.scope_class,
          row.source_body, row.source_body === null ? null : Buffer.byteLength(row.source_body, "utf8")
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
      if (persisted.source_body !== null) {
        writeRetainedSourceChunks(this.database, { workspaceId: persisted.workspace_id, kind: "source_record",
          rootId: persisted.record_id, revision: persisted.source_version, digest: persisted.content_digest }, persisted.source_body);
        this.database.connection.prepare(`UPDATE source_records SET retained_content_bytes = ?
          WHERE workspace_id = ? AND record_id = ?`).run(Buffer.byteLength(persisted.source_body, "utf8"),
          persisted.workspace_id, persisted.record_id);
      }
      return persisted;
    }, "source record with evidence binding");
  }

  public verifiedEvidenceBinding(workspaceId: string, evidenceObjectId: string): boolean {
    return this.database.connection.prepare(
      "SELECT 1 FROM evidence_capsules WHERE workspace_id = ? AND object_id = ? AND lifecycle_state = 'active' LIMIT 1"
    ).get(workspaceId, evidenceObjectId) !== undefined;
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
      this.pageStatement.all(workspaceId, afterRecordedAt, afterRecordId, limit),
      fieldSourceRecordParser,
      "source record"
    );
    const last = rows.at(-1);
    return {
      rows: rows.filter((row) => row.source_body !== null),
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
      workspaceId,
      afterRecordedAt,
      afterRecordId,
      limit
    );
    const rows = raw.map((row) => this.readBoundedBody(row, byteLimit, 0));
    const last = rows.at(-1)?.record;
    return {
      rows,
      truncated: rows.length === limit,
      committedThrough: last == null
        ? encodeRecordCursor(options)
        : encodeRecordCursor({ afterRecordedAt: last.recorded_at, afterRecordId: last.record_id })
      , unavailable: rows.some((row) => row.record === null || row.record.source_body === null && row.bodyBytes > 0)
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
    const raw = this.boundedSelectStatement.get(workspaceId, recordId);
    if (raw === undefined || raw === null) return null;
    return this.readBoundedBody(raw, byteLimit, offset);
  }

  private readBoundedBody(value: unknown, byteLimit: number, offset: number): BoundedSourceRecordRead {
    const row = readRecord(value, "bounded source record");
    const nativeMetadataBytes = [...SOURCE_METADATA_COLUMNS, "effective_evidence_object_id"].reduce((sum, column) =>
      sum + (typeof row[column] === "string" ? Buffer.byteLength(row[column] as string, "utf8") : 0), 0);
    const verified = row.effective_evidence_object_id != null && this.database.connection.prepare(`
      SELECT 1 FROM source_record_evidence_refs ref JOIN evidence_capsules e
        ON e.object_id = ref.evidence_object_id AND e.workspace_id = ref.workspace_id
      WHERE ref.workspace_id = ? AND ref.record_id = ? AND ref.evidence_object_id = ?
        AND e.lifecycle_state = 'active' LIMIT 1`).get(row.workspace_id, row.record_id,
      row.effective_evidence_object_id) !== undefined;
    const body = row.metadata_limited === 1 || typeof row.source_body_bytes !== "number"
      ? { prefix: null, nativeBytes: 0, metadataBytes: 0 }
      : readRetainedSourceChunk(this.database, { workspaceId: row.workspace_id as string, kind: "source_record",
        rootId: row.record_id as string, revision: row.source_version as string, digest: row.content_digest as string },
      offset, byteLimit, row.source_body_bytes);
    return parseBoundedSourceRecord({ ...row, evidence_object_id: verified ? row.effective_evidence_object_id : null,
      evidence_verified: verified ? 1 : 0,
      source_body_bytes: row.source_body_bytes ?? (row.body_retained === 1 ? 1 : 0), source_body_prefix: body.prefix,
      native_bytes: body.nativeBytes, metadata_bytes: nativeMetadataBytes + body.metadataBytes }, byteLimit, offset);
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
    existing.valid_to === incoming.valid_to &&
    (existing.speaker ?? null) === (incoming.speaker ?? null) &&
    (existing.scope_class ?? null) === (incoming.scope_class ?? null);
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

function parseBoundedSourceRecord(
  value: unknown,
  byteLimit: number,
  offset: number
): BoundedSourceRecordRead {
  const row = readRecord(value, "bounded source record");
  const bodyBytes = readIntegerField(row, "source_body_bytes");
  const prefix = prefixBuffer(row.source_body_prefix);
  const metadataBytes = readIntegerField(row, "metadata_bytes");
  const receipt = { evidenceVerified: row.evidence_verified === 1, nativeBytes: readIntegerField(row, "native_bytes"), metadataBytes };
  if (row.metadata_limited === 1) return { record: null, bodyBytes, prefixBytes: 0, invalidOffset: false, ...receipt };
  if (prefix === null) {
    return {
      record: fieldSourceRecordParser.parse({ ...row, source_body: null }),
      bodyBytes,
      prefixBytes: 0,
      invalidOffset: offset !== 0
      , ...receipt
    };
  }
  if (offset > bodyBytes || (offset < bodyBytes && prefix.length > 0 && (prefix[0]! & 0xc0) === 0x80)) {
    return {
      record: fieldSourceRecordParser.parse({ ...row, source_body: null }),
      bodyBytes,
      prefixBytes: 0,
      invalidOffset: true
      , ...receipt
    };
  }
  if (offset === bodyBytes) {
    return {
      record: fieldSourceRecordParser.parse({ ...row, source_body: "" }),
      bodyBytes,
      prefixBytes: 0,
      invalidOffset: false
      , ...receipt
    };
  }
  const trimmed = trimUtf8Prefix(prefix, byteLimit);
  return {
    record: fieldSourceRecordParser.parse({ ...row, source_body: trimmed.toString("utf8") }),
    bodyBytes,
    prefixBytes: trimmed.length,
    invalidOffset: false
    , ...receipt
  };
}

function prefixBuffer(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("invalid source body prefix");
}

export function trimUtf8Prefix(bytes: Buffer, byteLimit: number): Buffer {
  if (bytes.length === 0) return bytes;
  let end = Math.min(bytes.length, byteLimit);
  let last = end - 1;
  while (last > 0 && (bytes[last]! & 0xc0) === 0x80) last -= 1;
  const lead = bytes[last]!;
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  if (last + width > end) end = last;
  return bytes.subarray(0, end);
}
