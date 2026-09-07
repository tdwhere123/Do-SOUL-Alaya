import { MEMORY_SOURCE_REVISION_INDEX_SQL, memorySourceRevision } from "../source-revision.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { buildWorkspaceScopedFtsMatch } from "../../shared/fts-lane-routing.js";
import { tokenizeFtsQuery } from "./keyword-search.js";
import { MEMORY_ENTRY_SELECT_COLUMNS, parseMemoryEntryRow, type MemoryEntryRow } from "../mappers/row-mapper.js";

const SOURCE_BYTES_SQL = MEMORY_ENTRY_SELECT_COLUMNS.split(",").map((column) =>
  `COALESCE(length(CAST(${column.trim()} AS BLOB)), 0)`).join(" + ");

export const LEXICAL_RECALL_SQL = `SELECT object_id, rowid AS rowid
      FROM memory_content_fts_porter WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?
      AND rowid > ? ORDER BY rowid LIMIT ?`;

export class SqliteMemoryRecallReader {
  public constructor(private readonly db: StorageDatabase) {}

  public prepareIndex(): void { this.db.connection.exec(MEMORY_SOURCE_REVISION_INDEX_SQL); }

  public source(workspaceId: string, objectId: string, byteLimit = 65536) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 65536) throw new Error("invalid source byte limit");
    return this.db.connection.transaction(() => {
      const lengthRow = this.db.connection.prepare(
        `SELECT ${SOURCE_BYTES_SQL} AS byte_length FROM memory_entries WHERE workspace_id = ? AND object_id = ? LIMIT 1`
      ).get(workspaceId, objectId) as { readonly byte_length: number } | undefined;
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
      const rows = this.db.connection.prepare(`SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
        FROM memory_entries WHERE workspace_id = ? AND object_id = ? LIMIT 1`)
        .all(workspaceId, objectId) as MemoryEntryRow[];
      const revisions = rows.length ? this.db.connection.prepare(`SELECT revision FROM event_log
        INDEXED BY garden_semantic_source_event_revision WHERE workspace_id=? AND entity_type='memory_entry'
        AND entity_id=? AND event_type IN ('soul.memory.created','soul.memory.updated')
        ORDER BY revision DESC LIMIT 1`).all(workspaceId, objectId) as { revision: number }[] : [];
      const raw = rows[0];
      const revision = revisions[0]?.revision;
      const row = raw && revision !== undefined ? { ...parseMemoryEntryRow(raw), sourceEventRevision: revision,
        sourceRevision: memorySourceRevision(revision, raw.content, raw.evidence_refs, raw.updated_at) } : null;
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
    const afterRowId = lexicalAfterRowId(this.db, afterObjectId);
    const rows = this.db.connection.prepare(LEXICAL_RECALL_SQL)
      .all(
        workspaceId,
        buildWorkspaceScopedFtsMatch(workspaceId, tokens),
        afterRowId,
        fetchLimit
      ) as { object_id: string; rowid: number }[];
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
  db: StorageDatabase,
  afterObjectId: string | null
): number {
  if (afterObjectId === null || afterObjectId === "") return 0;
  if (/^[0-9]+$/u.test(afterObjectId)) return Number(afterObjectId);
  const row = db.connection.prepare(
    `SELECT rowid AS rowid FROM memory_content_fts_porter WHERE object_id = ? LIMIT 1`
  ).get(afterObjectId) as { rowid: number } | undefined;
  return row?.rowid ?? 0;
}
