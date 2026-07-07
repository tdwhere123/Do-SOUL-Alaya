import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";

export type SqliteStatement = BetterSqlite3.Statement;

export interface OrphanRadarStatements {
  readonly createStatement: SqliteStatement;
  readonly createEventLogOrphanStatement: SqliteStatement;
  readonly findByIdStatement: SqliteStatement;
  readonly findActiveByWorkspaceIdStatement: SqliteStatement;
  readonly findByTargetMemoryStatement: SqliteStatement;
  readonly deleteExpiredStatement: SqliteStatement;
}

const ORPHAN_RADAR_LIST_LIMIT = 200;

export function prepareOrphanRadarStatements(db: StorageDatabase): OrphanRadarStatements {
  return {
    createStatement: db.connection.prepare(CREATE_ORPHAN_RADAR_SQL),
    createEventLogOrphanStatement: db.connection.prepare(CREATE_EVENT_LOG_ORPHAN_SQL),
    findByIdStatement: db.connection.prepare(selectOrphanRadarSql("byId", "limitOne")),
    findActiveByWorkspaceIdStatement: db.connection.prepare(
      selectOrphanRadarSql("activeByWorkspace", "listRecent")
    ),
    findByTargetMemoryStatement: db.connection.prepare(
      selectOrphanRadarSql("byTargetMemory", "listRecent")
    ),
    deleteExpiredStatement: db.connection.prepare("DELETE FROM orphan_radar WHERE expires_at <= ?")
  };
}

type OrphanRadarWhereKey = "byId" | "activeByWorkspace" | "byTargetMemory";
type OrphanRadarSuffixKey = "limitOne" | "listRecent";

const ORPHAN_RADAR_WHERE_CLAUSES: Readonly<Record<OrphanRadarWhereKey, string>> = Object.freeze({
  byId: "radar_id = ? AND target_event_id IS NULL",
  activeByWorkspace: "workspace_id = ? AND expires_at > ? AND target_event_id IS NULL",
  byTargetMemory: "target_memory_id = ? AND workspace_id = ?"
});

const ORPHAN_RADAR_SUFFIXES: Readonly<Record<OrphanRadarSuffixKey, string>> = Object.freeze({
  limitOne: "LIMIT 1",
  listRecent: `ORDER BY detected_at DESC, radar_id ASC\n       LIMIT ${ORPHAN_RADAR_LIST_LIMIT}`
});

function selectOrphanRadarSql(whereKey: OrphanRadarWhereKey, suffixKey: OrphanRadarSuffixKey): string {
  return `SELECT${ORPHAN_RADAR_SELECT_COLUMNS}
       FROM orphan_radar
       WHERE ${ORPHAN_RADAR_WHERE_CLAUSES[whereKey]}
       ${ORPHAN_RADAR_SUFFIXES[suffixKey]}`;
}

const ORPHAN_RADAR_SELECT_COLUMNS = `
         radar_id,
         target_memory_id,
         workspace_id,
         suspected_surface_gaps_json,
         suggested_action,
         confidence,
         detected_at,
         expires_at,
         requires_review
`;

const CREATE_ORPHAN_RADAR_SQL = `INSERT INTO orphan_radar (
        radar_id,
        target_memory_id,
        workspace_id,
        suspected_surface_gaps_json,
        suggested_action,
        confidence,
        detected_at,
        expires_at,
        requires_review
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const CREATE_EVENT_LOG_ORPHAN_SQL = `INSERT OR IGNORE INTO orphan_radar (
        radar_id,
        target_memory_id,
        target_event_id,
        target_event_type,
        expected_table,
        workspace_id,
        suspected_surface_gaps_json,
        suggested_action,
        confidence,
        detected_at,
        expires_at,
        requires_review
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
