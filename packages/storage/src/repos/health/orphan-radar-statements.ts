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
    findByIdStatement: db.connection.prepare(selectOrphanRadarSql("radar_id = ? AND target_event_id IS NULL", "LIMIT 1")),
    findActiveByWorkspaceIdStatement: db.connection.prepare(
      selectOrphanRadarSql(
        "workspace_id = ? AND expires_at > ? AND target_event_id IS NULL",
        `ORDER BY detected_at DESC, radar_id ASC\n       LIMIT ${ORPHAN_RADAR_LIST_LIMIT}`
      )
    ),
    findByTargetMemoryStatement: db.connection.prepare(
      selectOrphanRadarSql(
        "target_memory_id = ? AND workspace_id = ?",
        `ORDER BY detected_at DESC, radar_id ASC\n       LIMIT ${ORPHAN_RADAR_LIST_LIMIT}`
      )
    ),
    deleteExpiredStatement: db.connection.prepare("DELETE FROM orphan_radar WHERE expires_at <= ?")
  };
}

function selectOrphanRadarSql(whereClause: string, suffix: string): string {
  return `SELECT${ORPHAN_RADAR_SELECT_COLUMNS}
       FROM orphan_radar
       WHERE ${whereClause}
       ${suffix}`;
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
