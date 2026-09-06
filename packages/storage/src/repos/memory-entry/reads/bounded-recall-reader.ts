import { MEMORY_SOURCE_REVISION_INDEX_SQL, memorySourceRevision } from "../source-revision.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { buildWorkspaceScopedFtsMatch } from "../../shared/fts-lane-routing.js";
import { tokenizeFtsQuery } from "./keyword-search.js";
import { MEMORY_ENTRY_SELECT_COLUMNS, parseMemoryEntryRow, type MemoryEntryRow } from "../mappers/row-mapper.js";

const SOURCE_BYTES_SQL = MEMORY_ENTRY_SELECT_COLUMNS.split(",").map((column) =>
  `COALESCE(length(CAST(${column.trim()} AS BLOB)), 0)`).join(" + ");

let nextReaderId = 0;

export class SqliteMemoryRecallReader {
  private readonly visitFunction = `recall_lexical_visit_${++nextReaderId}`;
  private readonly visitState = new Map<number, { visits: number; bytes: number; limit: number }>();
  private nextVisitCall = 0;
  private readonly exhausted = new Error("lexical native visit limit exhausted");

  public constructor(private readonly db: StorageDatabase) {
    db.connection.function(this.visitFunction, (id: string, callId: number) => {
      const state = this.visitState.get(callId);
      if (state === undefined) throw new Error("lexical visit call is missing");
      state.visits += 1; state.bytes += Buffer.byteLength(id, "utf8");
      if (state.visits >= state.limit) throw this.exhausted;
      return 1;
    });
  }

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

  public lexical(workspaceId: string, query: string, limit: number, nativeLimit = 512) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 512 ||
        !Number.isSafeInteger(nativeLimit) || nativeLimit < 0 || nativeLimit > 512) throw new Error("invalid lexical row/work limit");
    const tokens = tokenizeFtsQuery(query);
    const callId = ++this.nextVisitCall;
    const state = { visits: 0, bytes: 0, limit: nativeLimit };
    this.visitState.set(callId, state);
    let rows: { object_id: string }[] = [];
    let exhausted = !limit || !nativeLimit;
    let completed = false;
    try {
      if (!exhausted && tokens.length) {
        try {
          // Native visits stop the sort's input before an unbounded matching set can
          // be consumed. An interrupted ordering has no canonical winner to emit.
          rows = this.db.connection.prepare(`SELECT object_id
            FROM memory_content_fts_porter WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?
            AND ${this.visitFunction}(object_id, ?) ORDER BY object_id LIMIT ?`)
            .all(workspaceId, buildWorkspaceScopedFtsMatch(workspaceId, tokens), callId, limit) as typeof rows;
          completed = true;
        } catch (error) {
          if (error !== this.exhausted) throw error;
          exhausted = true;
        }
      }
    } finally {
      this.visitState.delete(callId);
    }
    return { ids: rows.map((row) => row.object_id), rows, rowsRead: rows.length,
      bytesRead: completed ? Buffer.byteLength(JSON.stringify(rows), "utf8") : 0, nativeVisits: state.visits,
      nativeBytes: state.bytes, truncated: exhausted || rows.length === limit };
  }
}
