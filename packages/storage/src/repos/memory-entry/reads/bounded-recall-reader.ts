import { MEMORY_SOURCE_REVISION_INDEX_SQL, memorySourceRevision } from "../source-revision.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { buildWorkspaceScopedFtsMatch } from "../../shared/fts-lane-routing.js";
import { tokenizeFtsQuery } from "./keyword-search.js";
import { MEMORY_ENTRY_SELECT_COLUMNS, parseMemoryEntryRow, type MemoryEntryRow } from "../mappers/row-mapper.js";

const SOURCE_BYTES_SQL = MEMORY_ENTRY_SELECT_COLUMNS.split(",").map((column) =>
  `COALESCE(length(CAST(${column.trim()} AS BLOB)), 0)`).join(" + ");

export class SqliteMemoryRecallReader {
  public constructor(private readonly db: StorageDatabase) {}

  public prepareIndex(): void { this.db.connection.exec(MEMORY_SOURCE_REVISION_INDEX_SQL); }

  public source(workspaceId: string, objectId: string, byteLimit = 65536) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > 65536) throw new Error("invalid source byte limit");
    return this.db.connection.transaction(() => {
      const rows = this.db.connection.prepare(`SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
        FROM memory_entries WHERE workspace_id = ? AND object_id = ?
        AND ${SOURCE_BYTES_SQL} <= ? LIMIT 1`)
        .all(workspaceId, objectId, byteLimit) as MemoryEntryRow[];
      const revisions = rows.length ? this.db.connection.prepare(`SELECT revision FROM event_log
        INDEXED BY garden_semantic_source_event_revision WHERE workspace_id=? AND entity_type='memory_entry'
        AND entity_id=? AND event_type IN ('soul.memory.created','soul.memory.updated')
        ORDER BY revision DESC LIMIT 1`).all(workspaceId, objectId) as { revision: number }[] : [];
      const raw = rows[0];
      const revision = revisions[0]?.revision;
      const row = raw && revision !== undefined ? { ...parseMemoryEntryRow(raw), sourceEventRevision: revision,
        sourceRevision: memorySourceRevision(revision, raw.content, raw.evidence_refs, raw.updated_at) } : null;
      return { row, rowsRead: rows.length + revisions.length, sourceRowsRead: rows.length, revisionRowsRead: revisions.length,
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
    const rows = this.db.connection.prepare(`SELECT object_id
      FROM memory_content_fts_porter WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?
      AND object_id > ? ORDER BY object_id LIMIT ?`)
      .all(
        workspaceId,
        buildWorkspaceScopedFtsMatch(workspaceId, tokens),
        afterObjectId ?? "",
        fetchLimit
      ) as { object_id: string }[];
    const bytesRead = Buffer.byteLength(JSON.stringify(rows), "utf8");
    return {
      ids: rows.map((row) => row.object_id),
      rows,
      rowsRead: rows.length,
      bytesRead,
      nativeVisits: rows.length,
      nativeBytes: bytesRead,
      truncated: rows.length === fetchLimit
    };
  }
}
