/**
 * Shared event_log row column order for INSERT and SELECT paths.
 * Sync binds a precomputed revision in-txn; worker CAS stays in payload SQL.
 */
export const EVENT_LOG_INSERT_COLUMNS = [
  "event_id",
  "event_type",
  "entity_type",
  "entity_id",
  "workspace_id",
  "run_id",
  "caused_by",
  "revision",
  "payload_json",
  "created_at"
] as const;

const EVENT_LOG_INSERT_COLUMN_LIST = EVENT_LOG_INSERT_COLUMNS.join(",\n  ");

/** Comma-separated columns for SELECT${…} templates in statement groups. */
export const EVENT_LOG_SELECT_COLUMNS = `
        ${EVENT_LOG_INSERT_COLUMNS.join(",\n        ")}
`;

export const EVENT_LOG_GET_BY_ID_SQL = `
SELECT
  ${EVENT_LOG_INSERT_COLUMN_LIST}
FROM event_log
WHERE event_id = ?
`;

/** Sync path: revision computed on the caller connection then bound. */
export const EVENT_LOG_APPEND_SYNC_SQL = `
INSERT INTO event_log (
  ${EVENT_LOG_INSERT_COLUMN_LIST}
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Worker path: revision CAS is a scalar subquery so SELECT MAX + INSERT stay
 * one IMMEDIATE transaction on the worker connection.
 */
export const EVENT_LOG_APPEND_WITH_REVISION_SQL = `
INSERT INTO event_log (
  ${EVENT_LOG_INSERT_COLUMN_LIST}
) VALUES (
  ?, ?, ?, ?, ?, ?, ?,
  (
    SELECT COALESCE(MAX(revision), -1) + 1
    FROM event_log
    WHERE entity_type = ? AND entity_id = ?
  ),
  ?, ?
)
`;
