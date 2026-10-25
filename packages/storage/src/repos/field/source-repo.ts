import { readHostInventory, type HostInventoryReadInput, type HostInventoryReadResult } from "./host-inventory-read.js";
import { StorageError } from "../../shared/errors.js";
import type { FieldContractSha256 } from "@do-soul/alaya-protocol";
import { HOST_OCCURRENCE_LIMITS, bindHostOccurrenceInventory, describeHostStructure, canonicalJson, IsoDatetimeStringSchema, sameSourceRecordFields as sameRecord } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { readRetainedSourceChunk, writeRetainedSourceChunks } from "./retained-source-chunks.js";
import { readSourceProjectionDependencies, SOURCE_RECORD_METADATA_BYTE_MAX as SOURCE_METADATA_BYTE_MAX,
  SOURCE_RECORD_METADATA_COLUMNS as SOURCE_METADATA_COLUMNS, CURRENT_SOURCE_RECORD_ORDER as CURRENT_RECORD_ORDER,
  type SourceRecordReadAllowance } from "./source-representation-read.js";
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

// The canonical body is never selected by a Recall read. Even BLOB substr
// materializes a complete TEXT value inside SQLite before returning its prefix.
function sourceRecordReadSql(representationColumn: boolean, hostStructureColumn: boolean) {
  const value = (column: string) => (column === "source_representation_json" && !representationColumn ||
    column === "host_structure_json" && !hostStructureColumn) ? "NULL" : column;
  const metadataBytes = SOURCE_METADATA_COLUMNS.map(column => `COALESCE(octet_length(${value(column)}), 0)`).join(" + ");
  return {
    full: `SELECT ${SOURCE_METADATA_COLUMNS.map(column => `${value(column)} AS ${column}`).join(", ")}, source_body FROM source_records`,
    bounded: `SELECT ${SOURCE_METADATA_COLUMNS.map((column) =>
    `CASE WHEN (${metadataBytes}) <= ${SOURCE_METADATA_BYTE_MAX} THEN ${value(column)} ELSE NULL END AS ${column}`).join(", ")},
         (${metadataBytes}) > ${SOURCE_METADATA_BYTE_MAX} AS metadata_limited,
         (SELECT CASE WHEN octet_length(evidence_object_id) <= 256 THEN evidence_object_id ELSE NULL END FROM source_record_active_evidence_refs ref
           WHERE ref.workspace_id = source_records.workspace_id AND ref.record_id = source_records.record_id
           ORDER BY evidence_object_id LIMIT 1) AS effective_evidence_object_id,
         CASE WHEN retained_content_bytes = octet_length(source_body) THEN retained_content_bytes ELSE NULL END AS source_body_bytes,
         octet_length(source_body) IS NOT NULL AS body_retained FROM source_records`
  };
}

export type BoundedSourceRecordRead = Readonly<{
  readonly record: FieldSourceRecordRow | null;
  readonly bodyBytes: number;
  readonly prefixBytes: number;
  readonly invalidOffset: boolean;
  readonly evidenceVerified: boolean;
  readonly nativeBytes: number;
  readonly metadataBytes: number;
  readonly dependencyWork: number;
  readonly resourceLimited?: boolean;
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
  private readonly representationColumn: boolean;
  private readonly hostStructureColumn: boolean;
  private readonly recordReadSql;
  private readonly nextCurrentBoundedStatement;
  private readonly currentBoundedStatement;
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
    this.representationColumn = database.connection.prepare("PRAGMA table_info(source_records)").all()
      .some(column => (column as { name: string }).name === "source_representation_json");
    this.hostStructureColumn = database.connection.prepare("PRAGMA table_info(source_records)").all()
      .some(column => (column as { name: string }).name === "host_structure_json");
    this.recordReadSql = sourceRecordReadSql(this.representationColumn, this.hostStructureColumn);
    this.nextCurrentBoundedStatement = new RefreshableStatementHolder(database, (activeDatabase) =>
      activeDatabase.connection.prepare(`${this.recordReadSql.bounded}
        INDEXED BY idx_source_records_current
        WHERE source_records.workspace_id = ? AND source_records.source_id > ?
        ORDER BY source_records.source_id ASC, ${CURRENT_RECORD_ORDER} LIMIT 1`));
    this.currentBoundedStatement = new RefreshableStatementHolder(database, (activeDatabase) =>
      activeDatabase.connection.prepare(`${this.recordReadSql.bounded}
        INDEXED BY idx_source_records_current
        WHERE source_records.workspace_id = ? AND source_records.source_id = ?
        ORDER BY ${CURRENT_RECORD_ORDER} LIMIT 1`));
    this.insertStatement = database.connection.prepare(`
      INSERT INTO source_records (
        record_id, workspace_id, source_id, source_version, content_digest,
        evidence_object_id, recorded_at, event_time, valid_from, valid_to,
        operator_id, speaker, scope_class, attribution_context_json, ${this.representationColumn ? "source_representation_json," : ""} ${this.hostStructureColumn ? "host_structure_json," : ""} source_body, retained_content_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${this.representationColumn ? "?," : ""} ${this.hostStructureColumn ? "?," : ""} ?, ?)
      ON CONFLICT(workspace_id, record_id) DO NOTHING
    `);
    this.selectStatement = database.connection.prepare(
      `${this.recordReadSql.full} WHERE workspace_id = ? AND record_id = ? LIMIT 1`
    );
    this.listStatement = database.connection.prepare(
      `${this.recordReadSql.full} WHERE workspace_id = ? ORDER BY record_id`
    );
    this.pageStatement = database.connection.prepare(`
      ${this.recordReadSql.full}
      WHERE workspace_id = ?
        AND (recorded_at, record_id) > (?, ?)
      ORDER BY recorded_at ASC, record_id ASC
      LIMIT ?
    `);
    this.boundedPageStatement = database.connection.prepare(`
      ${this.recordReadSql.bounded}
      WHERE workspace_id = ?
        AND (recorded_at, record_id) > (?, ?)
      ORDER BY recorded_at ASC, record_id ASC
      LIMIT ?
    `);
    this.boundedSelectStatement = database.connection.prepare(
      `${this.recordReadSql.bounded} WHERE workspace_id = ? AND record_id = ? LIMIT 1`
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
    if (row.source_representation !== undefined && !this.representationColumn) {
      throw new StorageError("VALIDATION_FAILED", "source representation requires the current storage schema");
    }
    if (!this.hostStructureColumn) {
      throw new StorageError("VALIDATION_FAILED", "source writes require the current host-capable storage schema");
    }
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
          row.attribution_context === null ? null : canonicalJson(row.attribution_context),
          ...(this.representationColumn ? [row.source_representation === undefined ? null : canonicalJson(row.source_representation)] : []),
          ...(this.hostStructureColumn ? [row.host_structure === undefined ? null : canonicalJson(row.host_structure)] : []),
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

  public readHostInventory(input: HostInventoryReadInput): HostInventoryReadResult {
    return readHostInventory(this.database, input, this.sha256,
      { hostStructure: this.hostStructureColumn, representation: this.representationColumn });
  }

  public getHostInventory(workspaceId: string, recordId: string): string | null {
    if (!this.hostStructureColumn) return null;
    const row = this.database.connection.prepare(`SELECT canonical_inventory FROM source_host_inventories
      WHERE workspace_id = ? AND record_id = ? AND octet_length(canonical_inventory) <= ?`)
      .get(workspaceId, recordId, HOST_OCCURRENCE_LIMITS.inventoryBytes) as
      { canonical_inventory: string } | undefined;
    return row?.canonical_inventory ?? null;
  }

  public putHostInventory(workspaceId: string, recordId: string, canonicalInventory: string): void {
    const record = this.findById(workspaceId, recordId);
    if (record?.source_body == null || record.host_structure === undefined) {
      throw new StorageError("VALIDATION_FAILED", "host inventory requires a retained captured source");
    }
    const inventory = bindHostOccurrenceInventory(JSON.parse(canonicalInventory), record.source_body);
    if (canonicalJson(inventory) !== canonicalInventory ||
        canonicalJson(describeHostStructure(record, inventory, this.sha256)) !== canonicalJson(record.host_structure)) {
      throw new StorageError("VALIDATION_FAILED", "host inventory binding differs from source");
    }
    const existing = this.getHostInventory(workspaceId, recordId);
    if (existing !== null && existing !== canonicalInventory) throw new StorageError("VALIDATION_FAILED", "host inventory replay mismatch");
    this.database.connection.prepare(`INSERT INTO source_host_inventories VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, record_id) DO NOTHING`).run(workspaceId, recordId, canonicalInventory);
  }

  public verifiedEvidenceBinding(workspaceId: string, evidenceObjectId: string): boolean {
    return this.database.connection.prepare(
      "SELECT 1 FROM evidence_capsules WHERE workspace_id = ? AND object_id = ? AND lifecycle_state = 'active' LIMIT 1"
    ).get(workspaceId, evidenceObjectId) !== undefined;
  }

  public findById(workspaceId: string, recordId: string): FieldSourceRecordRow | null {
    return this.availableRecord(parseOptionalRow(
      this.selectStatement.get(workspaceId, recordId),
      fieldSourceRecordParser,
      "source record"
    ));
  }

  public listByWorkspace(workspaceId: string): readonly FieldSourceRecordRow[] {
    return parseRows(this.listStatement.all(workspaceId), fieldSourceRecordParser, "source record").map(row => this.availableRecord(row)!);
  }

  public findCurrent(workspaceId: string, sourceId: string): FieldSourceRecordRow | null {
    this.database.reopenIfClosed();
    return this.availableRecord(parseOptionalRow(this.database.connection.prepare(`${this.recordReadSql.full}
      INDEXED BY idx_source_records_current
      WHERE source_records.workspace_id = ? AND source_records.source_id = ?
      ORDER BY ${CURRENT_RECORD_ORDER} LIMIT 1`).get(workspaceId, sourceId),
    fieldSourceRecordParser, "current source record"));
  }

  public findCurrentBounded(
    workspaceId: string, sourceId: string, byteLimit = 1, offset = 0, allowance?: SourceRecordReadAllowance
  ): BoundedSourceRecordRead | null {
    assertSourceBodyByteLimit(byteLimit);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new StorageError("VALIDATION_FAILED", "invalid source-root byte offset");
    const raw = this.currentBoundedStatement.active().get(workspaceId, sourceId);
    return raw == null ? null : this.readBoundedBody(raw, byteLimit, offset, allowance);
  }

  public findNextCurrentBounded(
    workspaceId: string, afterSourceId: string | null, byteLimit = 1, allowance?: SourceRecordReadAllowance
  ): BoundedSourceRecordRead | null {
    assertSourceBodyByteLimit(byteLimit);
    // Each source-id seek skips that source's entire obsolete-version range.
    const raw = this.nextCurrentBoundedStatement.active().get(workspaceId, afterSourceId ?? "");
    return raw == null ? null : this.readBoundedBody(raw, byteLimit, 0, allowance);
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
    const rows = parseRows(this.pageStatement.all(workspaceId, afterRecordedAt, afterRecordId, limit),
      fieldSourceRecordParser,
      "source record"
    ).map(row => this.availableRecord(row)!);
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
    byteLimit: number,
    allowance?: SourceRecordReadAllowance
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
    const rows: BoundedSourceRecordRead[] = [];
    let work = 0, bytes = 0;
    for (const row of raw) {
      const read = this.readBoundedBody(row, byteLimit, 0, { workLimit: (allowance?.workLimit ?? Infinity) - work,
        nativeByteLimit: (allowance?.nativeByteLimit ?? Infinity) - bytes });
      rows.push(read); work += 5 + read.dependencyWork; bytes += read.nativeBytes + read.metadataBytes;
      if (read.resourceLimited) break;
    }
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
    offset: number,
    allowance?: SourceRecordReadAllowance
  ): BoundedSourceRecordRead | null {
    assertSourceBodyByteLimit(byteLimit);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("invalid source-root byte offset");
    }
    const raw = this.boundedSelectStatement.get(workspaceId, recordId);
    if (raw === undefined || raw === null) return null;
    return this.readBoundedBody(raw, byteLimit, offset, allowance);
  }

  private availableRecord(row: FieldSourceRecordRow | null): FieldSourceRecordRow | null {
    if (row === null || row.source_body === null) return row;
    return readSourceProjectionDependencies(this.database, row, CURRENT_RECORD_ORDER).available ? row : { ...row, source_body: null };
  }

  private readBoundedBody(value: unknown, byteLimit: number, offset: number, allowance?: SourceRecordReadAllowance): BoundedSourceRecordRead {
    const row = readRecord(value, "bounded source record");
    const nativeMetadataBytes = [...SOURCE_METADATA_COLUMNS, "effective_evidence_object_id"].reduce((sum, column) =>
      sum + (typeof row[column] === "string" ? Buffer.byteLength(row[column] as string, "utf8") : 0), 0);
    const verified = row.effective_evidence_object_id != null && this.database.connection.prepare(`
      SELECT 1 FROM source_record_evidence_refs ref JOIN evidence_capsules e
        ON e.object_id = ref.evidence_object_id AND e.workspace_id = ref.workspace_id
      WHERE ref.workspace_id = ? AND ref.record_id = ? AND ref.evidence_object_id = ?
        AND e.lifecycle_state = 'active' LIMIT 1`).get(row.workspace_id, row.record_id,
      row.effective_evidence_object_id) !== undefined;
    const source = row.metadata_limited === 1 ? null : fieldSourceRecordParser.parse({ ...row, source_body: null });
    const dependencies = source === null ? { available: false, work: 0, metadataBytes: 0, resourceLimited: false, unavailable: true }
      : readSourceProjectionDependencies(this.database, source, CURRENT_RECORD_ORDER, allowance);
    const body = !dependencies.available || typeof row.source_body_bytes !== "number"
      ? { prefix: null, nativeBytes: 0, metadataBytes: 0 }
      : readRetainedSourceChunk(this.database, { workspaceId: row.workspace_id as string, kind: "source_record",
        rootId: row.record_id as string, revision: row.source_version as string, digest: row.content_digest as string },
      offset, byteLimit, row.source_body_bytes);
    return parseBoundedSourceRecord({ ...row, evidence_object_id: verified ? row.effective_evidence_object_id : null,
      evidence_verified: verified ? 1 : 0,
      source_body_bytes: !dependencies.available && !dependencies.resourceLimited && !dependencies.unavailable ? 0
        : row.source_body_bytes ?? (row.body_retained === 1 ? 1 : 0), source_body_prefix: body.prefix,
      dependency_work: dependencies.work, resource_limited: dependencies.resourceLimited,
      native_bytes: body.nativeBytes, metadata_bytes: nativeMetadataBytes + body.metadataBytes + dependencies.metadataBytes }, byteLimit, offset);
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
  if (cursor == null) {
    return { afterRecordedAt: null, afterRecordId: null };
  }
  const [timestamp, recordId, extra] = cursor.slice(2).split("\t");
  if (!cursor.startsWith("r:") || !IsoDatetimeStringSchema.safeParse(timestamp).success ||
      recordId === undefined || recordId.length === 0 || /[\r\n]/u.test(recordId) || extra !== undefined) {
    throw new StorageError("VALIDATION_FAILED", "Invalid source-record cursor.");
  }
  return {
    afterRecordedAt: timestamp!,
    afterRecordId: recordId
  };
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
  const receipt = { evidenceVerified: row.evidence_verified === 1, nativeBytes: readIntegerField(row, "native_bytes"), metadataBytes,
    dependencyWork: readIntegerField(row, "dependency_work"), ...(row.resource_limited === true ? { resourceLimited: true } : {}) };
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
