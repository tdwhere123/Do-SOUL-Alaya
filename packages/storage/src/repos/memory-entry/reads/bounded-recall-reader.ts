import { MEMORY_SOURCE_REVISION_INDEX_SQL, memorySourceRevision } from "../source-revision.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { DynamicPreparedStatementCache } from "../../../sqlite/dynamic-prepared-statement-cache.js";
import { withSqliteBusyRetry } from "../../../sqlite/open-readonly.js";
import { buildWorkspaceScopedFtsMatch } from "../../shared/fts-lane-routing.js";
import {
  parseRows,
  readIntegerField,
  readNonEmptyStringField,
  readRecord,
  type RowParser
} from "../../shared/parse-row.js";
import { tokenizeFtsQuery } from "./keyword-search.js";
import { MEMORY_ENTRY_SELECT_COLUMNS, MemoryEntryRowParser } from "../mappers/row-mapper.js";

const SOURCE_BYTES_SQL = MEMORY_ENTRY_SELECT_COLUMNS.split(",").map((column) =>
  `COALESCE(length(CAST(${column.trim()} AS BLOB)), 0)`).join(" + ");

export const LEXICAL_RECALL_SQL = `SELECT object_id, rowid AS rowid
      FROM memory_content_fts_porter WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?
      AND rowid > ? ORDER BY rowid LIMIT ?`;

const SOURCE_LENGTH_SQL =
  `SELECT ${SOURCE_BYTES_SQL} AS byte_length FROM memory_entries WHERE workspace_id = ? AND object_id = ? LIMIT 1`;
const SOURCE_ROW_SQL =
  `SELECT${MEMORY_ENTRY_SELECT_COLUMNS} FROM memory_entries WHERE workspace_id = ? AND object_id = ? LIMIT 1`;
const SOURCE_REVISION_SQL = `SELECT revision FROM event_log
        INDEXED BY garden_semantic_source_event_revision WHERE workspace_id=? AND entity_type='memory_entry'
        AND entity_id=? AND event_type IN ('soul.memory.created','soul.memory.updated')
        ORDER BY revision DESC LIMIT 1`;
const LEXICAL_AFTER_ROWID_SQL =
  `SELECT rowid AS rowid FROM memory_content_fts_porter WHERE object_id = ? LIMIT 1`;

const ByteLengthRowParser: RowParser<{ readonly byte_length: number }> = {
  parse(value: unknown): { readonly byte_length: number } {
    const record = readRecord(value, "source byte length row");
    return { byte_length: readIntegerField(record, "byte_length") };
  }
};

const LexicalRecallRowParser: RowParser<{ readonly object_id: string; readonly rowid: number }> = {
  parse(value: unknown): { readonly object_id: string; readonly rowid: number } {
    const record = readRecord(value, "lexical recall row");
    return {
      object_id: readNonEmptyStringField(record, "object_id"),
      rowid: readIntegerField(record, "rowid")
    };
  }
};

const LexicalAfterRowIdParser: RowParser<{ readonly rowid: number }> = {
  parse(value: unknown): { readonly rowid: number } {
    const record = readRecord(value, "lexical after rowid");
    return { rowid: readIntegerField(record, "rowid") };
  }
};

const RevisionRowParser: RowParser<{ readonly revision: number }> = {
  parse(value: unknown): { readonly revision: number } {
    const record = readRecord(value, "source revision row");
    return { revision: readIntegerField(record, "revision") };
  }
};

export class SqliteMemoryRecallReader {
  private readonly statements: DynamicPreparedStatementCache;

  public constructor(private readonly db: StorageDatabase) {
    this.statements = new DynamicPreparedStatementCache(db, () => db.reopenIfClosed());
  }

  public prepareIndex(): void { this.db.connection.exec(MEMORY_SOURCE_REVISION_INDEX_SQL); }

  public source(workspaceId: string, objectId: string, byteLimit = 65536) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 65536) throw new Error("invalid source byte limit");
    return this.db.connection.transaction(() => {
      const lengthRows = parseCachedRows(
        this.statements, SOURCE_LENGTH_SQL, [workspaceId, objectId], ByteLengthRowParser, "source byte length row"
      );
      const lengthRow = lengthRows[0];
      if (lengthRow === undefined) {
        return {
          row: null, rowsRead: 0, sourceRowsRead: 0, revisionRowsRead: 0, bytesRead: 0, unavailable: false
        };
      }
      if (lengthRow.byte_length > byteLimit) {
        return {
          row: null,
          rowsRead: 1,
          sourceRowsRead: 1,
          revisionRowsRead: 0,
          bytesRead: Buffer.byteLength(JSON.stringify(lengthRow), "utf8"),
          unavailable: true,
          resourceLimited: true
        };
      }
      const rawRows = withSqliteBusyRetry(() => this.statements.prepare(SOURCE_ROW_SQL).all(workspaceId, objectId));
      const rows = parseRows(rawRows, MemoryEntryRowParser, "memory entry row");
      const revisions = rows.length
        ? parseCachedRows(
          this.statements, SOURCE_REVISION_SQL, [workspaceId, objectId], RevisionRowParser, "source revision row"
        )
        : [];
      const raw = rows[0];
      const revision = revisions[0]?.revision;
      const evidenceRefsJson = rawRows[0] === undefined
        ? ""
        : readNonEmptyStringField(readRecord(rawRows[0], "memory entry row"), "evidence_refs");
      const row = raw && revision !== undefined ? { ...raw, sourceEventRevision: revision,
        sourceRevision: memorySourceRevision(revision, raw.content, evidenceRefsJson, raw.updated_at) } : null;
      return { row, rowsRead: 1 + rows.length + revisions.length, sourceRowsRead: 1 + rows.length, revisionRowsRead: revisions.length,
        bytesRead: Buffer.byteLength(JSON.stringify(rows), "utf8") +
          (rows.length ? Buffer.byteLength(JSON.stringify(revisions), "utf8") : 0), unavailable: row === null };
    })();
  }

  public lexical(
    workspaceId: string,
    query: string,
    limit: number,
    nativeLimit = 512,
    afterObjectId: string | null = null
  ) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 512 ||
        !Number.isSafeInteger(nativeLimit) || nativeLimit < 0 || nativeLimit > 512) throw new Error("invalid lexical row/work limit");
    const tokens = tokenizeFtsQuery(query);
    const fetchLimit = Math.min(limit, nativeLimit);
    if (!fetchLimit || tokens.length === 0) {
      return {
        ids: [],
        rows: [],
        rowsRead: 0,
        bytesRead: 0,
        nativeVisits: 0,
        nativeBytes: 0,
        truncated: fetchLimit === 0
      };
    }
    const afterRowId = lexicalAfterRowId(this.statements, afterObjectId);
    const rows = parseCachedRows(
      this.statements,
      LEXICAL_RECALL_SQL,
      [workspaceId, buildWorkspaceScopedFtsMatch(workspaceId, tokens), afterRowId, fetchLimit],
      LexicalRecallRowParser,
      "lexical recall row"
    );
    const bytesRead = Buffer.byteLength(JSON.stringify(rows), "utf8");
    const last = rows.at(-1);
    return {
      ids: rows.map((row) => row.object_id),
      rows,
      rowsRead: rows.length,
      bytesRead,
      nativeVisits: rows.length,
      nativeBytes: bytesRead,
      truncated: rows.length === fetchLimit,
      committedThrough: last === undefined ? afterObjectId : String(last.rowid)
    };
  }
}

function lexicalAfterRowId(
  statements: DynamicPreparedStatementCache,
  afterObjectId: string | null
): number {
  if (afterObjectId === null || afterObjectId === "") return 0;
  if (/^[0-9]+$/u.test(afterObjectId)) return Number(afterObjectId);
  const row = parseCachedRows(
    statements, LEXICAL_AFTER_ROWID_SQL, [afterObjectId], LexicalAfterRowIdParser, "lexical after rowid"
  )[0];
  return row?.rowid ?? 0;
}

function parseCachedRows<T>(
  statements: DynamicPreparedStatementCache,
  sql: string,
  args: readonly unknown[],
  parser: RowParser<T>,
  label: string
): readonly T[] {
  return withSqliteBusyRetry(() => parseRows(statements.prepare(sql).all(...args), parser, label));
}
